// aws-chunked body decoding + SigV4 chunk-signature verification.
//
// AWS CLI and the SDKs stream PUT payloads with this framing when they can't
// hash the whole body up front (or want a checksum trailer): the body is split
// into chunks, each prefixed with a hex size line, and x-amz-content-sha256 is
// either STREAMING-AWS4-HMAC-SHA256-PAYLOAD (every chunk carries a signature)
// or STREAMING-UNSIGNED-PAYLOAD (framed but unsigned). Framing, per AWS docs:
//
//   <hex-size>[;chunk-signature=<sig>]\r\n <data> \r\n
//   ...
//   0[;chunk-signature=<sig>]\r\n [<trailer>: <value>\r\n] \r\n
//
// The decoder strips the framing so storage/checksums/quota all see plaintext
// bytes, and verifies each chunk signature when the request used the signed
// streaming mode. A signed chunk must match the exact signature AWS derives
// from the previous chunk's signature (or the top-level Authorization
// Signature for the first chunk), so tampering in flight is caught the same
// way the rest of the API is protected.

import { Transform, Readable } from 'stream';
import crypto from 'crypto';

export class AwsChunkError extends Error {
  readonly code: 'SignatureDoesNotMatch' | 'InvalidRequest';
  constructor(code: 'SignatureDoesNotMatch' | 'InvalidRequest', message: string) {
    super(message);
    this.name = 'AwsChunkError';
    this.code = code;
  }
}

// Verification context derived from the request's SigV4 Authorization header
// (attached to AuthResult by s3auth.ts for STREAMING-* payload hashes).
export interface AwsChunkedContext {
  signingKey?: Buffer;
  amzDate?: string;
  scopeStr?: string;
  seedSignature?: string;
}

export function isAwsChunked(headers: Record<string, unknown>): boolean {
  const encoding = String(headers['content-encoding'] ?? '').toLowerCase();
  const sha = String(headers['x-amz-content-sha256'] ?? '');
  return encoding.includes('aws-chunked') || sha.startsWith('STREAMING-');
}

// x-amz-decoded-content-length is the plaintext size a streaming client
// declares (Content-Length, when present, is the framed size). Null when absent.
export function decodedContentLength(headers: Record<string, unknown>): number | null {
  const v = parseInt(String(headers['x-amz-decoded-content-length'] ?? ''), 10);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// AWS caps streamed chunks at 8MiB; generous bound so a malicious size line
// can't force us to buffer arbitrarily. Parsed size lines are bounded too.
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const MAX_LINE_LENGTH = 4096;

export function decodeAwsChunked(
  raw: Readable,
  sha256Value: string,
  ctx: AwsChunkedContext
): { stream: NodeJS.ReadableStream; trailerChecksum: Promise<string | null> } {
  const verifyChunks = sha256Value === 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
  if (verifyChunks && (!ctx.signingKey || !ctx.amzDate || !ctx.scopeStr || !ctx.seedSignature)) {
    // Fail closed: a request claiming signed chunks we have no context for
    // must not be stored unverified.
    throw new AwsChunkError('InvalidRequest', 'Signed streaming payload cannot be verified (missing streaming context).');
  }

  let resolveTrailer!: (value: string | null) => void;
  const trailerChecksum = new Promise<string | null>((resolve) => {
    resolveTrailer = resolve;
  });

  const decoder = new AwsChunkDecoder({ verifyChunks, ...ctx });
  // Do not destroy the underlying request stream here: the route replies to
  // decoding errors (403/400) and fastify tears down the unread request body
  // once the response is flushed, so a pre-emptive destroy would abort the
  // connection before that reply can be written.
  decoder.on('error', () => resolveTrailer(null));
  decoder.on('finish', () => resolveTrailer(decoder.trailerChecksum));
  raw.pipe(decoder);

  return { stream: decoder, trailerChecksum };
}

class AwsChunkDecoder extends Transform {
  trailerChecksum: string | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private state: 'size' | 'data' | 'crlf' | 'trailer' | 'done' = 'size';
  private chunkSize = 0;
  private chunkSig = '';
  private dataParts: Buffer[] = [];
  private dataLen = 0;
  private prevSignature: string;

  constructor(
    private opts: {
      verifyChunks: boolean;
      signingKey?: Buffer;
      amzDate?: string;
      scopeStr?: string;
      seedSignature?: string;
    }
  ) {
    super();
    this.prevSignature = opts.seedSignature || '';
  }

  _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.consume();
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  _flush(cb: (err?: Error | null) => void): void {
    try {
      if (this.state !== 'done') {
        throw new AwsChunkError('InvalidRequest', 'Truncated aws-chunked body.');
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private consume(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.state === 'size') {
        const idx = this.buf.indexOf('\r\n');
        if (idx === -1) {
          if (this.buf.length > MAX_LINE_LENGTH) {
            throw new AwsChunkError('InvalidRequest', 'aws-chunked size line too long.');
          }
          return;
        }
        const line = this.buf.subarray(0, idx).toString('latin1');
        this.buf = this.buf.subarray(idx + 2);
        const semi = line.indexOf(';');
        const sizeHex = (semi === -1 ? line : line.slice(0, semi)).trim();
        if (!/^[0-9a-fA-F]+$/.test(sizeHex)) {
          throw new AwsChunkError('InvalidRequest', 'Malformed aws-chunked size.');
        }
        const size = parseInt(sizeHex, 16);
        if (size === 0) {
          this.state = 'trailer';
          continue;
        }
        if (size > MAX_CHUNK_SIZE) {
          throw new AwsChunkError('InvalidRequest', 'aws-chunked chunk exceeds the size limit.');
        }
        let sig = '';
        if (semi !== -1) {
          const sigMatch = line.slice(semi + 1).match(/^chunk-signature=([0-9a-fA-F]{64})$/);
          if (!sigMatch) {
            throw new AwsChunkError('InvalidRequest', 'Malformed aws-chunked chunk signature.');
          }
          sig = sigMatch[1].toLowerCase();
        }
        if (this.opts.verifyChunks && !sig) {
          throw new AwsChunkError('SignatureDoesNotMatch', 'Missing chunk signature for a signed streaming payload.');
        }
        if (!this.opts.verifyChunks && sig) {
          throw new AwsChunkError('InvalidRequest', 'Unexpected chunk signature on an unsigned streaming payload.');
        }
        this.chunkSize = size;
        this.chunkSig = sig;
        this.dataParts = [];
        this.dataLen = 0;
        this.state = 'data';
      } else if (this.state === 'data') {
        if (this.buf.length < this.chunkSize) return;
        const data = this.buf.subarray(0, this.chunkSize);
        this.buf = this.buf.subarray(this.chunkSize);
        this.dataParts.push(data);
        this.dataLen += data.length;
        this.state = 'crlf';
      } else if (this.state === 'crlf') {
        if (this.buf.length < 2) return;
        if (this.buf[0] !== 0x0d || this.buf[1] !== 0x0a) {
          throw new AwsChunkError('InvalidRequest', 'Malformed aws-chunked chunk terminator.');
        }
        this.buf = this.buf.subarray(2);
        const payload = this.dataParts.length === 1 ? this.dataParts[0] : Buffer.concat(this.dataParts, this.dataLen);
        if (this.opts.verifyChunks) {
          this.verifyChunkSignature(payload);
        }
        this.push(payload);
        this.state = 'size';
      } else if (this.state === 'trailer') {
        if (this.buf.length === 0) return;
        if (this.buf.length >= 2 && this.buf[0] === 0x0d && this.buf[1] === 0x0a) {
          // Empty trailer line terminates the body.
          this.buf = this.buf.subarray(2);
          this.state = 'done';
          continue;
        }
        const idx = this.buf.indexOf('\r\n');
        if (idx === -1) {
          if (this.buf.length > MAX_LINE_LENGTH) {
            throw new AwsChunkError('InvalidRequest', 'aws-chunked trailer line too long.');
          }
          return;
        }
        const line = this.buf.subarray(0, idx).toString('latin1');
        this.buf = this.buf.subarray(idx + 2);
        const colon = line.indexOf(':');
        if (colon <= 0) {
          throw new AwsChunkError('InvalidRequest', 'Malformed aws-chunked trailer.');
        }
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'x-amz-checksum-crc32') {
          this.trailerChecksum = value;
        }
      } else {
        return; // done
      }
    }
  }

  // SigV4 chunk string-to-sign (aws docs: sigv4-streaming):
  //   AWS4-HMAC-SHA256-PAYLOAD\n<date>\n<scope>\n<prevSig>\n
  //   + sha256Hex(that context) + "\n" + sha256Hex(chunk data)
  private verifyChunkSignature(payload: Buffer): void {
    const context = `AWS4-HMAC-SHA256-PAYLOAD\n${this.opts.amzDate}\n${this.opts.scopeStr}\n${this.prevSignature}\n`;
    const stringToSign = `${context}${crypto.createHash('sha256').update(context).digest('hex')}\n${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const expected = crypto.createHmac('sha256', this.opts.signingKey as Buffer).update(stringToSign).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(this.chunkSig, 'hex'))) {
      throw new AwsChunkError('SignatureDoesNotMatch', 'Chunk signature verification failed.');
    }
    this.prevSignature = this.chunkSig;
  }
}
