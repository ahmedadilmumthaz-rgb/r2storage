import { initDb } from './lib/db';
import { ENV } from './lib/env';
import { meterAll } from './lib/usage';

let started = false;

export async function register() {
  if (started) return;
  started = true;

  try {
    await initDb();
    console.log('[platform] database initialized (WAL)');
  } catch (e) {
    console.error('[platform] db init failed:', e);
  }

  if (ENV.METERING_INTERVAL_MS > 0) {
    const loop = async () => {
      try {
        const n = await meterAll();
        console.log(`[meter] polled ${n} instance(s)`);
      } catch (e) {
        console.error('[meter] sweep failed:', e);
      }
    };
    await loop();
    setInterval(loop, ENV.METERING_INTERVAL_MS).unref();
    console.log(`[platform] metering every ${ENV.METERING_INTERVAL_MS}ms`);
  }
}
