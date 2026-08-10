import { CONFIG } from '../config';

/**
 * Brute-force lockout for the single shared ADMIN_SECRET.
 *
 * Two tiers, both in-memory (safe here because the backend runs as exactly one
 * process per instance — systemd Type=simple, one worker):
 *
 *  - Per-IP:   `failThreshold` consecutive failures from one address lock that
 *              address out for `ipCooldownSec`. Stops a single host guessing.
 *  - Global:   `globalThreshold` consecutive failures summed across ALL
 *              addresses trigger a global cooldown that doubles on each
 *              re-trigger (capped). Stops distributed/rotating-IP guessing
 *              without an operator being able to be locked out by a single
 *              spoofed source.
 *
 * Any successful login resets both the caller's per-IP counter and the global
 * counter. Counters also age out: a counter whose first failure is older than
 * the window no longer counts (so an old flood can't keep the door locked).
 */

interface Counter {
  failCount: number;
  firstFailAt: number;
  lockedUntil: number;
}

const FAIL_WINDOW_MS = 60 * 60 * 1000; // failures must be within 1h to stack
const MAX_GLOBAL_COOLDOWN_SEC = 60 * 60; // 1h cap on the doubling cooldown

const perIp = new Map<string, Counter>();
let global: Counter = emptyCounter();
// Current global cooldown length; doubles each time the global lockout fires,
// up to the cap (local copy so CONFIG is never mutated).
let globalCooldownSec = CONFIG.LOGIN_GLOBAL_COOLDOWN_SEC;

function emptyCounter(): Counter {
  return { failCount: 0, firstFailAt: 0, lockedUntil: 0 };
}

function freshen(c: Counter): Counter {
  if (c.firstFailAt && Date.now() - c.firstFailAt > FAIL_WINDOW_MS) {
    return emptyCounter();
  }
  return c;
}

export interface LockoutStatus {
  locked: boolean;
  retryAfterSec: number;
}

function statusOf(c: Counter): LockoutStatus {
  const now = Date.now();
  if (c.lockedUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((c.lockedUntil - now) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

/** True when the caller's IP (or the global lockout) must refuse a login now. */
export function isLockedOut(ip: string): LockoutStatus {
  const ipStatus = statusOf(freshen(perIp.get(ip) ?? emptyCounter()));
  if (ipStatus.locked) return ipStatus;
  return statusOf(freshen(global));
}

/**
 * Record a failed login attempt.
 *
 * `tier`: 'both' (login form — counts toward the per-IP AND global counters,
 * since a single shared secret has no per-account counter to absorb it) or
 * 'perIp' only (x-admin-secret header, so a misconfigured monitoring script
 * can't trip the global lockout and lock everyone out).
 */
export function recordFailure(ip: string, tier: 'both' | 'perIp'): LockoutStatus {
  const now = Date.now();

  const ipCounter = freshen(perIp.get(ip) ?? emptyCounter());
  if (ipCounter.failCount === 0) ipCounter.firstFailAt = now;
  ipCounter.failCount++;
  if (ipCounter.failCount >= CONFIG.LOGIN_FAIL_THRESHOLD) {
    ipCounter.lockedUntil = now + CONFIG.LOGIN_IP_COOLDOWN_SEC * 1000;
    ipCounter.failCount = 0; // re-arm: next failures start counting again
  }
  perIp.set(ip, ipCounter);

  if (tier === 'both') {
    global = freshen(global);
    if (global.failCount === 0) global.firstFailAt = now;
    global.failCount++;
    if (global.failCount >= CONFIG.LOGIN_GLOBAL_THRESHOLD) {
      const cooldown = Math.min(globalCooldownSec, MAX_GLOBAL_COOLDOWN_SEC);
      // Double on re-trigger: a second lockout after the first expiry lasts 2x.
      const prior = global.lockedUntil > now ? global.lockedUntil : now;
      global.lockedUntil = prior + cooldown * 1000;
      globalCooldownSec = Math.min(globalCooldownSec * 2, MAX_GLOBAL_COOLDOWN_SEC);
      global.failCount = 0;
    }
  }

  const status = isLockedOut(ip);
  return status.locked ? status : { locked: false, retryAfterSec: 0 };
}

/** Called on a successful login: clears the caller's counter and the global one. */
export function resetLockout(ip: string): void {
  perIp.delete(ip);
  global = emptyCounter();
  globalCooldownSec = CONFIG.LOGIN_GLOBAL_COOLDOWN_SEC;
}
