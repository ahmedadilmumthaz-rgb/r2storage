import crypto from 'crypto';

// RFC 6238 TOTP (time-based one-time password) for admin 2FA, implemented with
// Node's built-in crypto only — no new dependency, and the hot loop is a couple
// of HMAC-SHA1 calls so an external library buys nothing.
//
// The secret is a base32 string (RFC 4648) exactly as provisioned by Google
// Authenticator / 1Password / Aegis. Codes are verified against a ±`window`
// step offset to tolerate clock drift, and compared constant-time.

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 decode (tolerates lowercase, spaces, hyphens, padding). */
export function base32Decode(input: string): Buffer {
  const s = String(input).toUpperCase().replace(/[=\s-]/g, '');
  if (!s) throw new Error('empty base32 secret');
  // 5 bits per char; a leftover single bit (len*5 % 8 === 1) means padding is
  // missing/malformed. Everything must come from the A-Z2-7 alphabet.
  if ((s.length * 5) % 8 === 1 || /[^A-Z2-7]/.test(s)) {
    throw new Error('invalid base32 secret');
  }
  const bits: number[] = [];
  for (const ch of s) {
    const v = B32_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base32 secret');
    for (let b = 4; b >= 0; b--) bits.push((v >> b) & 1);
  }
  const out: number[] = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    out.push(byte);
  }
  return Buffer.from(out);
}

/**
 * Compute the current TOTP code for a secret at a given time.
 * Deterministic — exported for tests and for the smoke suite to mint codes.
 */
export function totpCode(secret: string, timeSec: number, digits = 6, stepSec = 30): string {
  const counter = Math.floor(timeSec / stepSec);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  const code = (bin % 10 ** digits).toString();
  return code.padStart(digits, '0');
}

export interface TotpVerifyOptions {
  /** Tolerance in steps before/after now (default 1 = ±30s). */
  window?: number;
  /** Overridable clock (seconds) for tests. */
  nowSec?: number;
  digits?: number;
  stepSec?: number;
}

/** Constant-time check of a 6-digit code against the current step ± window. */
export function verifyTotp(secret: string, token: unknown, opts: TotpVerifyOptions = {}): boolean {
  const { window = 1, nowSec = Math.floor(Date.now() / 1000), digits = 6, stepSec = 30 } = opts;
  const clean = String(token ?? '').trim().replace(/[\s-]/g, '');
  if (!/^\d+$/.test(clean) || clean.length !== digits) return false;
  const expected = Buffer.from(clean, 'utf8');
  for (let i = -window; i <= window; i++) {
    let candidate: Buffer;
    try {
      candidate = Buffer.from(totpCode(secret, nowSec + i * stepSec, digits, stepSec), 'utf8');
    } catch {
      return false; // malformed secret — fail closed, never crash a request
    }
    if (candidate.length === expected.length && crypto.timingSafeEqual(expected, candidate)) {
      return true;
    }
  }
  return false;
}
