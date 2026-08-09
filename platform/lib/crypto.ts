import crypto from 'crypto';
import { ENV } from './env';

function masterKey(): Buffer {
  const k = ENV.PLATFORM_MASTER_KEY;
  if (k) return crypto.createHash('sha256').update(k).digest();
  if (ENV.NODE_ENV === 'production') {
    throw new Error('PLATFORM_MASTER_KEY is required in production');
  }
  console.warn('[crypto] using insecure DEV master key — set PLATFORM_MASTER_KEY');
  return crypto.createHash('sha256').update('dev-master-key-change-me').digest();
}

// AES-256-GCM envelope: iv.tag.ciphertext (base64). Tenant admin secrets and
// initial access keys are stored encrypted in the platform DB.
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
