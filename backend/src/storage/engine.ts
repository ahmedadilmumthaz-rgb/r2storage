import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from '../config';
import { EncryptedWrite, openEncryptedRead, encryptionEnabled, maybeDecryptBuffer, maybeEncryptBuffer, sliceStream } from './crypto';

export class StorageEngine {
  private baseDir: string;

  constructor() {
    this.baseDir = CONFIG.STORAGE_DIR;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getFilePath(bucketName: string, key: string): string {
    const safeBucket = bucketName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const dir = path.join(this.baseDir, safeBucket, keyHash.slice(0, 2), keyHash.slice(2, 4));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, keyHash);
  }

  async saveObject(bucketName: string, key: string, buffer: Buffer): Promise<{ size: number; etag: string; storagePath: string }> {
    const filePath = this.getFilePath(bucketName, key);
    // Encrypt at rest when a key is configured; the ETag stays the MD5 of the
    // *plaintext* so it matches what S3 clients compute from the payload.
    await fs.promises.writeFile(filePath, maybeEncryptBuffer(buffer));
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    return {
      size: buffer.length,
      etag: `"${md5}"`,
      storagePath: filePath,
    };
  }

  async saveObjectFromStream(bucketName: string, key: string, stream: NodeJS.ReadableStream): Promise<{ size: number; etag: string; storagePath: string }> {
    const filePath = this.getFilePath(bucketName, key);
    const tmpPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
    const hash = crypto.createHash('md5');
    let size = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(tmpPath);
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
        stream.on('error', reject);
        if (encryptionEnabled()) {
          // Hash plaintext chunks before encryption so the ETag matches the payload.
          const ew = new EncryptedWrite(writeStream);
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            hash.update(chunk);
            ew.write(chunk);
          });
          stream.on('end', () => ew.end());
        } else {
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            hash.update(chunk);
          });
          stream.pipe(writeStream);
        }
      });
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }

    await fs.promises.rename(tmpPath, filePath);
    return { size, etag: `"${hash.digest('hex')}"`, storagePath: filePath };
  }

  private getPartPath(uploadId: string, partNumber: number): string {
    const dir = path.join(this.baseDir, 'multipart', uploadId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, String(partNumber));
  }

  async savePartFromStream(uploadId: string, partNumber: number, stream: NodeJS.ReadableStream): Promise<{ etag: string; size: number; storagePath: string }> {
    const partPath = this.getPartPath(uploadId, partNumber);
    const hash = crypto.createHash('md5');
    let size = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(partPath);
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
        stream.on('error', reject);
        if (encryptionEnabled()) {
          const ew = new EncryptedWrite(writeStream);
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            hash.update(chunk);
            ew.write(chunk);
          });
          stream.on('end', () => ew.end());
        } else {
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            hash.update(chunk);
          });
          stream.pipe(writeStream);
        }
      });
    } catch (err) {
      await fs.promises.unlink(partPath).catch(() => {});
      throw err;
    }

    return { etag: `"${hash.digest('hex')}"`, size, storagePath: partPath };
  }

  async assembleUpload(
    bucketName: string,
    key: string,
    parts: Array<{ storagePath: string; partNumber: number }>
  ): Promise<{ size: number; etag: string; storagePath: string }> {
    const filePath = this.getFilePath(bucketName, key);
    const tmpPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
    const hash = crypto.createHash('md5');
    let size = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(tmpPath);
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
        const ew = new EncryptedWrite(writeStream); // passthrough when disabled
        const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        (async () => {
          for (const part of ordered) {
            // Parts are stored encrypted too; decrypt back to plaintext before
            // re-encrypting into the assembled object (or hashing, if disabled).
            const data = maybeDecryptBuffer(await fs.promises.readFile(part.storagePath));
            size += data.length;
            hash.update(data);
            if (!ew.write(data)) {
              await new Promise<void>((res) => writeStream.once('drain', () => res()));
            }
          }
          ew.end();
        })().catch(reject);
      });
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }

    await fs.promises.rename(tmpPath, filePath);
    return { size, etag: `"${hash.digest('hex')}"`, storagePath: filePath };
  }

  async deleteUploadParts(uploadId: string): Promise<void> {
    const dir = path.join(this.baseDir, 'multipart', uploadId);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  async getObjectStream(filePath: string): Promise<NodeJS.ReadableStream | null> {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    // Decrypt when the blob carries the encryption magic; plaintext (legacy or
    // key-less) blobs stream through untouched.
    return openEncryptedRead(filePath) ?? fs.createReadStream(filePath);
  }

  // Inclusive plaintext byte range [start, end] of a blob. Plaintext files use
  // fs's native range reads (O(1) seek); encrypted blobs must be decrypted in
  // full first (see sliceStream), which is correct though CPU-bound for huge
  // objects — the tradeoff of whole-file GCM.
  async getObjectStreamRange(
    filePath: string,
    start: number,
    end: number,
  ): Promise<NodeJS.ReadableStream | null> {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const decrypted = openEncryptedRead(filePath);
    if (decrypted) {
      return sliceStream(decrypted, start, end);
    }
    return fs.createReadStream(filePath, { start, end });
  }

  async getObjectBuffer(filePath: string): Promise<Buffer | null> {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return maybeDecryptBuffer(await fs.promises.readFile(filePath));
  }

  async deleteObjectFile(filePath: string): Promise<boolean> {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        return true;
      }
    } catch (err) {
      console.error('Failed to delete object file:', err);
    }
    return false;
  }
}

export const storageEngine = new StorageEngine();
