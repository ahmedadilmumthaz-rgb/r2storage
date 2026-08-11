import fs from 'fs';
import crypto from 'crypto';
import { PassThrough } from 'stream';
import { CONFIG } from '../config';

// AES-256-GCM encryption at rest for stored blobs.
//
// Layout of an encrypted blob on disk:
//   [ 'r2enc1' magic (6) ][ 12-byte random IV ][ ciphertext ][ 16-byte GCM tag ]
// The magic lets reads transparently fall back to legacy plaintext blobs that
// were written before a key was configured, and the per-blob random IV means
// equal objects never share ciphertext (no cross-object correlation).
//
// Everything here is streamed (never the whole blob in memory) on the write
// path; the GCM tag is appended only after final(), so a truncated file fails
// authentication rather than returning partial data.

export const ENC_MAGIC = Buffer.from('r2enc1', 'utf8');
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const HEADER_LEN = ENC_MAGIC.length + IV_LEN;

let keyCache: Buffer | null | undefined; // undefined = not yet checked

/** The validated 32-byte AES key, or null when encryption is disabled. */
export function encKey(): Buffer | null {
  if (keyCache !== undefined) return keyCache;
  const raw = CONFIG.STORAGE_ENCRYPTION_KEY || '';
  if (!raw) {
    keyCache = null;
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    // Fail closed: a malformed key would silently produce undecryptable blobs.
    console.error('[storage] STORAGE_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Refusing to start.');
    process.exit(1);
  }
  keyCache = Buffer.from(raw, 'hex');
  return keyCache;
}

export const encryptionEnabled = (): boolean => encKey() !== null;

function isEncrypted(buf: Buffer): boolean {
  return (
    buf.length >= HEADER_LEN + TAG_LEN &&
    buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)
  );
}

/**
 * Wraps a WriteStream so chunks written to the returned EncryptedWrite are
 * encrypted before hitting disk. `write`/`end` mirror the WriteStream API;
 * the GCM tag is flushed on `end`. Without a configured key this is a thin
 * passthrough, so callers need no branching.
 */
export class EncryptedWrite {
  private cipher: crypto.CipherGCM | null;

  constructor(private out: fs.WriteStream) {
    const k = encKey();
    if (!k) {
      this.cipher = null;
      return;
    }
    const iv = crypto.randomBytes(IV_LEN);
    out.write(ENC_MAGIC);
    out.write(iv);
    this.cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
    // end:false — our 'end' handler owns closing `out` so it can append the GCM
    // tag first; pipe's default end:true would close out before the tag writes.
    this.cipher.pipe(out, { end: false });
    this.cipher.on('end', () => {
      out.write(this.cipher!.getAuthTag());
      out.end();
    });
  }

  write(chunk: Buffer): boolean {
    return this.cipher ? this.cipher.write(chunk) : this.out.write(chunk);
  }

  end(): void {
    if (this.cipher) this.cipher.end();
    else this.out.end();
  }
}

/**
 * Opens an encrypted blob for reading. Returns null when the file is a legacy
 * plaintext blob (or encryption is disabled) — callers stream it as-is then.
 * On success the returned stream emits the decrypted plaintext; a tampered or
 * truncated blob fails GCM authentication and errors the stream.
 */
export function openEncryptedRead(filePath: string): NodeJS.ReadableStream | null {
  const k = encKey();
  if (!k) return null;

  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(HEADER_LEN);
  try {
    const n = fs.readSync(fd, header, 0, HEADER_LEN, 0);
    if (n < HEADER_LEN || !header.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) {
      fs.closeSync(fd);
      return null;
    }
    const stat = fs.fstatSync(fd);
    if (stat.size < HEADER_LEN + TAG_LEN) {
      fs.closeSync(fd);
      throw new Error(`truncated encrypted blob: ${filePath}`);
    }
    const tag = Buffer.alloc(TAG_LEN);
    fs.readSync(fd, tag, 0, TAG_LEN, stat.size - TAG_LEN);
    fs.closeSync(fd);

    const decipher = crypto.createDecipheriv('aes-256-gcm', k, header.subarray(ENC_MAGIC.length));
    decipher.setAuthTag(tag);
    const body = fs.createReadStream(filePath, {
      start: HEADER_LEN,
      end: stat.size - TAG_LEN - 1, // inclusive end of the ciphertext region
    });
    body.on('error', (err) => decipher.destroy(err));
    // If a range read tears the decipher down early (sliceStream destroys it
    // once the requested span has been emitted), stop the file stream too so a
    // huge blob isn't decrypted to the end just to serve a small range.
    decipher.on('close', () => body.destroy());
    body.pipe(decipher);
    return decipher;
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd already closed */
    }
    throw err;
  }
}

/** Decrypts an in-memory blob (legacy plaintext passes through untouched). */
export function maybeDecryptBuffer(buf: Buffer): Buffer {
  const k = encKey();
  if (!k || !isEncrypted(buf)) return buf;
  const iv = buf.subarray(ENC_MAGIC.length, HEADER_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(buf.subarray(HEADER_LEN, buf.length - TAG_LEN)),
    decipher.final(),
  ]);
}

/** Encrypts an in-memory blob (passthrough when encryption is disabled). */
export function maybeEncryptBuffer(buf: Buffer): Buffer {
  const k = encKey();
  if (!k) return buf;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([ENC_MAGIC, iv, ct, cipher.getAuthTag()]);
}

/**
 * Forwards only the bytes in the inclusive plaintext span [start, end] of
 * `source` and ends the returned stream once that span has been emitted.
 * Used to serve byte-range GETs on encrypted blobs, which must be decrypted
 * from the first byte (GCM counters cannot be seeked into) before the range
 * can be carved out; plaintext blobs use fs.createReadStream's native
 * { start, end } instead. `source` is destroyed early so the underlying file
 * stops being decrypted once the requested span is past.
 */
export function sliceStream(source: NodeJS.ReadableStream, start: number, end: number): NodeJS.ReadableStream {
  const out = new PassThrough();
  // All real sources (fs streams, deciphers) are Node streams with destroy();
  // the NodeJS.ReadableStream lib type just doesn't expose it.
  const destroySource = () => (source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  let pos = 0;
  let done = false;
  source.on('data', (chunk: Buffer) => {
    if (done) return;
    const chunkStart = pos;
    pos += chunk.length;
    if (chunkStart + chunk.length - 1 < start) return;
    if (chunkStart > end) {
      done = true;
      destroySource();
      out.end();
      return;
    }
    const from = Math.max(0, start - chunkStart);
    const to = Math.min(chunk.length, end - chunkStart + 1);
    if (from < to) out.write(chunk.subarray(from, to));
    if (chunkStart + to - 1 >= end) {
      done = true;
      destroySource();
      out.end();
    }
  });
  source.on('error', (err) => out.destroy(err));
  source.on('end', () => {
    if (!done) out.end();
  });
  return out;
}
