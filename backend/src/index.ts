import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import path from 'path';
import fs from 'fs';
import { CONFIG } from './config';
import { authRoutes } from './api/auth';
import { adminRoutes } from './api/admin';
import { s3Routes } from './api/s3';
import { publicDomainRoutes, tryServePublicObject } from './api/public';
import { startMaintenanceSweeper } from './maintenance';
import { db, initDatabase } from './db';

const fastify = Fastify({
  logger: true,
  trustProxy: true,
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info(`${signal} received, draining in-flight requests and shutting down...`);
  // Safety net: never hang systemctl's TimeoutStopSec (30s) forever.
  const forceTimer = setTimeout(() => {
    fastify.log.error('Shutdown timeout reached, forcing exit.');
    process.exit(1);
  }, 15000);
  forceTimer.unref();
  try {
    await fastify.close();
    process.exit(0);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  try {
    // Register CORS (disabled globally; object-serve routes set ACAO explicitly),
    // Multipart, security headers, and rate limiting plugins.
    await fastify.register(cors, { origin: false });
    await fastify.register(helmet, {
      crossOriginResourcePolicy: false,
    });
    await fastify.register(cookie);
    await fastify.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5GB limit

    // Global baseline rate limit (per-scope limits set via onRoute below run first)
    fastify.addHook('onRoute', (routeOptions) => {
      const url = routeOptions.url || '';
      let limit: { max: number; timeWindow: string } | undefined;
      if (url.startsWith('/api/admin/login')) {
        // Login gets its own, tighter cap on top of the lockout in auth/lockout.ts.
        limit = { max: 10, timeWindow: '1 minute' };
      } else if (url.startsWith('/api/')) {
        limit = { max: CONFIG.RATE_LIMIT_ADMIN, timeWindow: '1 minute' }; // brute-force protection
      } else if (url.startsWith('/s3')) {
        limit = { max: CONFIG.RATE_LIMIT_S3, timeWindow: '1 minute' };
      }
      if (limit) {
        routeOptions.config = { ...(routeOptions.config || {}), rateLimit: limit };
      }
    });
    await fastify.register(rateLimit, { max: CONFIG.RATE_LIMIT_GLOBAL, timeWindow: '1 minute' });

    // Stream raw bodies (S3 PUT / multipart parts / XML) to disk instead of buffering
    fastify.addContentTypeParser('application/octet-stream', { bodyLimit: 10 * 1024 * 1024 * 1024 }, (req, payload, done) => done(null, payload));
    fastify.addContentTypeParser('*', { bodyLimit: 10 * 1024 * 1024 * 1024 }, (req, payload, done) => done(null, payload));

    // Register API & S3 protocol routes
    await fastify.register(authRoutes);
    await fastify.register(adminRoutes);
    await fastify.register(s3Routes);
    await fastify.register(publicDomainRoutes);

    // Serve Frontend Static UI Files
    const frontendDistPath = fs.existsSync(path.join(__dirname, '../frontend/dist'))
      ? path.join(__dirname, '../frontend/dist')
      : path.join(__dirname, 'public');

    if (fs.existsSync(frontendDistPath)) {
      await fastify.register(fastifyStatic, {
        root: frontendDistPath,
        prefix: '/',
      });

      // SPA fallback to index.html for non-API routes, after trying
      // to serve objects for mapped custom domains (e.g. https://cdn.example.com/logo.png)
      fastify.setNotFoundHandler(async (req, reply) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/s3')) {
          return reply.status(404).send({ error: 'Endpoint Not Found', path: req.url });
        }
        if (await tryServePublicObject(req, reply)) {
          return;
        }
        return reply.sendFile('index.html');
      });
    }

    // Health check endpoint
    fastify.get('/health', async () => {
      return { status: 'ok', service: 'r2storage', timestamp: new Date() };
    });

    const DEFAULT_SECRET = 'r2storage-admin-secret-key-change-me';
    if (CONFIG.ADMIN_SECRET === DEFAULT_SECRET) {
      if (CONFIG.IS_PRODUCTION) {
        fastify.log.error('Refusing to start in production with the default ADMIN_SECRET. Set a strong ADMIN_SECRET env var.');
        process.exit(1);
      }
      console.warn('[WARNING] Using the default ADMIN_SECRET. Set a strong ADMIN_SECRET env var before public deployment.');
    }

    // Ensure database connection + SQLite WAL/busy_timeout tuning
    await db.$connect();
    await initDatabase();
    console.log('Database connected successfully.');

    // Start orphan tmp / abandoned multipart sweep (runs on boot + hourly)
    startMaintenanceSweeper();

    await fastify.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
    console.log(`R2 Storage Server listening on ${CONFIG.HOST}:${CONFIG.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
