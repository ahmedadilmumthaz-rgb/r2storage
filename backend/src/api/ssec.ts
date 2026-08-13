import crypto from 'crypto';
import { FastifyReply } from 'fastify';
import { encryptionEnabled } from '../storage/crypto';

/**
 * SSE-C (Server-Side Encryption with Customer-Provided Keys) — a compatibility
 * surface only, "validate + echo".
 *
 * AWS's SSE-C protocol promises the provider never sees the key: every
 * PUT/GET/HEAD presents `x-amz-server-side-encryption-customer-*`, and a wrong
 * key makes the object unreadable. This server already encrypts every blob at
 * rest with the server-managed AES-256-GCM key (STORAGE_ENCRYPTION_KEY), so we
 * adopt the SSE-C *wire protocol* — validate the header trio exactly like S3
 * (well-formed AES256 algorithm, a base64 32-byte key, matching base64 key
 * MD5) and echo the headers back — but the customer key is never stored,
 * derived from, or required on later reads. The real at-rest protection is the
 * server-side cipher; this is an API-compatibility facade. See AGENTS.md
 * security posture note 5.
 *
 * The facade is refused outright when STORAGE_ENCRYPTION_KEY is unset:
 * accepting SSE-C on a server that stores plaintext would silently claim
 * protection that doesn't exist.
 */

export const SSE_C_ALGORITHM = 'AES256';

export interface SseCInfo {
  algorithm: string;
  keyMd5: string;
}

export interface SseCError {
  status: number;
  code: string;
  message: string;
}

export type SseCResult =
  | { kind: 'none' }
  | { kind: 'ok'; info: SseCInfo }
  | { kind: 'error'; error: SseCError };

const DEST_PREFIX = 'x-amz-server-side-encryption-customer';
const SOURCE_PREFIX = 'x-amz-copy-source-server-side-encryption-customer';

function readTrio(headers: Record<string, unknown>, prefix: string) {
  const val = (name: string) => (headers[name] as string | undefined)?.trim();
  return {
    algorithm: val(`${prefix}-algorithm`),
    key: val(`${prefix}-key`),
    keyMd5: val(`${prefix}-key-md5`),
  };
}

function invalidArgument(message: string): SseCResult {
  return { kind: 'error', error: { status: 400, code: 'InvalidArgument', message } };
}

function validateTrio(trio: { algorithm?: string; key?: string; keyMd5?: string }): SseCResult {
  const { algorithm, key, keyMd5 } = trio;
  if (algorithm === undefined && key === undefined && keyMd5 === undefined) {
    return { kind: 'none' };
  }
  // The trio is atomic: S3 rejects a partial set rather than guessing.
  if (algorithm === undefined) {
    return invalidArgument('Requests specifying Server Side Encryption with Customer provided keys must provide a valid encryption algorithm.');
  }
  if (key === undefined || keyMd5 === undefined) {
    return invalidArgument('Requests specifying Server Side Encryption with Customer provided keys must provide an appropriate secret key.');
  }
  if (algorithm !== SSE_C_ALGORITHM) {
    return invalidArgument('Requests specifying Server Side Encryption with Customer provided keys must provide a valid encryption algorithm.');
  }

  // The key must decode from base64 to exactly 32 bytes (a 256-bit AES key).
  // Round-tripping through Buffer rejects non-canonical base64 strings.
  const keyBuf = Buffer.from(key, 'base64');
  if (keyBuf.length !== 32 || keyBuf.toString('base64') !== key) {
    return invalidArgument('The secret key was invalid for the specified algorithm.');
  }

  // The MD5 is computed over the *raw* key bytes, not the base64 string.
  const supplied = Buffer.from(keyMd5, 'base64');
  const computed = crypto.createHash('md5').update(keyBuf).digest();
  if (
    supplied.length !== computed.length ||
    supplied.toString('base64') !== keyMd5 ||
    !crypto.timingSafeEqual(supplied, computed)
  ) {
    return invalidArgument('The calculated MD5 hash of the key did not match the hash that was provided.');
  }

  return { kind: 'ok', info: { algorithm, keyMd5: supplied.toString('base64') } };
}

/**
 * Validates the SSE-C header trio on a request. Pass `source = true` to read
 * the x-amz-copy-source-server-side-encryption-customer-* family used by
 * CopyObject / UploadPartCopy for the source object.
 */
export function validateSseC(headers: Record<string, unknown>, source = false): SseCResult {
  const result = validateTrio(readTrio(headers, source ? SOURCE_PREFIX : DEST_PREFIX));
  if (result.kind === 'none' || result.kind === 'error') {
    return result;
  }
  if (!encryptionEnabled()) {
    return {
      kind: 'error',
      error: {
        status: 400,
        code: 'InvalidRequest',
        message: 'Server-side encryption is not configured; SSE-C requires a STORAGE_ENCRYPTION_KEY.',
      },
    };
  }
  return result;
}

// Echoes the SSE-C headers on a successful response so the client gets the
// round-trip integrity confirmation AWS sends back. No-op without a key.
export function applySseCResponseHeaders(reply: FastifyReply, result: SseCResult): void {
  if (result.kind !== 'ok') return;
  reply.header('x-amz-server-side-encryption-customer-algorithm', result.info.algorithm);
  reply.header('x-amz-server-side-encryption-customer-key-md5', result.info.keyMd5);
}
