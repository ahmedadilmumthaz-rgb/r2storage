import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db';
import { storageEngine } from '../storage/engine';
import { S3Auth } from '../auth/s3auth';
import { CONFIG } from '../config';
import { secretsEqual } from '../auth/secrets';
import { SESSION_COOKIE, isValidSession } from '../auth/session';
import { getStorageQuota, setStorageQuota, usedStorageBytes, wouldExceedQuota } from '../quota';
import mime from 'mime-types';
import crypto from 'crypto';

export async function adminRoutes(fastify: FastifyInstance) {
  // Admin API guard. Accepts EITHER a valid dashboard session cookie
  // (HttpOnly, SameSite=Strict) OR the x-admin-secret header (used by
  // curl/scripts). Runs in preHandler so the onRequest rate-limit hook
  // counts failed attempts first.
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/admin')) return;
    const isPublicAdminRoute =
      req.url.startsWith('/api/admin/login') ||
      req.url.startsWith('/api/admin/logout') ||
      req.url.startsWith('/api/admin/session');
    if (isPublicAdminRoute) return;

    if (await isValidSession((req.cookies || {})[SESSION_COOKIE])) return;

    const provided = req.headers['x-admin-secret'];
    if (typeof provided === 'string' && secretsEqual(provided, CONFIG.ADMIN_SECRET)) return;

    return reply.status(401).send({ error: 'Unauthorized. Missing or invalid admin session or secret.' });
  });

  // 1. Dashboard Overview Analytics
  fastify.get('/api/admin/overview', async (req, reply) => {
    const bucketsCount = await db.bucket.count();
    const objectsCount = await db.object.count();
    const totalStorageResult = await db.object.aggregate({
      _sum: { size: true },
    });
    const totalStorageBytes = totalStorageResult._sum.size || 0;

    const accessKeysCount = await db.accessKey.count();
    const customDomainsCount = await db.customDomain.count();

    const logs = await db.requestLog.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
    });

    return {
      bucketsCount,
      objectsCount,
      totalStorageBytes,
      accessKeysCount,
      customDomainsCount,
      recentLogs: logs,
    };
  });

  // 2. Buckets API
  fastify.get('/api/admin/buckets', async () => {
    const buckets = await db.bucket.findMany({
      include: {
        _count: {
          select: { objects: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const bucketsWithStats = await Promise.all(
      buckets.map(async (b) => {
        const sizeSum = await db.object.aggregate({
          where: { bucketName: b.name },
          _sum: { size: true },
        });
        return {
          ...b,
          objectCount: b._count.objects,
          totalSizeBytes: sizeSum._sum.size || 0,
        };
      })
    );

    return bucketsWithStats;
  });

  fastify.post('/api/admin/buckets', async (req, reply) => {
    const { name, isPublic, corsOrigins } = req.body as { name: string; isPublic?: boolean; corsOrigins?: string };
    if (!name || !/^[a-z0-9.-]{3,63}$/.test(name)) {
      return reply.status(400).send({ error: 'Bucket name must be between 3-63 chars and contain lowercases, numbers, dots, or hyphens.' });
    }

    const existing = await db.bucket.findUnique({ where: { name } });
    if (existing) {
      return reply.status(409).send({ error: 'Bucket with this name already exists.' });
    }

    const bucket = await db.bucket.create({
      data: {
        name,
        isPublic: isPublic ?? false,
        corsOrigins: corsOrigins || '*',
      },
    });

    return reply.status(201).send(bucket);
  });

  fastify.patch('/api/admin/buckets/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const { isPublic, corsOrigins } = req.body as { isPublic?: boolean; corsOrigins?: string };

    const updated = await db.bucket.update({
      where: { name },
      data: {
        ...(isPublic !== undefined ? { isPublic } : {}),
        ...(corsOrigins !== undefined ? { corsOrigins } : {}),
      },
    });

    return updated;
  });

  fastify.delete('/api/admin/buckets/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    
    // Delete all objects files first
    const objects = await db.object.findMany({ where: { bucketName: name } });
    for (const obj of objects) {
      await storageEngine.deleteObjectFile(obj.storagePath);
    }

    await db.bucket.delete({ where: { name } });
    return { success: true, message: `Bucket ${name} deleted successfully` };
  });

  // 3. Object Management within Bucket
  fastify.get('/api/admin/buckets/:name/objects', async (req, reply) => {
    const { name } = req.params as { name: string };
    const objects = await db.object.findMany({
      where: { bucketName: name },
      orderBy: { createdAt: 'desc' },
    });
    return objects;
  });

  fastify.post('/api/admin/buckets/:name/upload', async (req, reply) => {
    const { name } = req.params as { name: string };
    const bucket = await db.bucket.findUnique({ where: { name } });
    if (!bucket) return reply.status(404).send({ error: 'Bucket not found' });

    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'No file uploaded' });

    const buffer = await data.toBuffer();
    const key = data.filename;
    const contentType = data.mimetype || mime.lookup(key) || 'application/octet-stream';

    const existing = await db.object.findUnique({ where: { bucketName_key: { bucketName: name, key } } });
    if (await wouldExceedQuota(buffer.length, existing?.size || 0)) {
      return reply.status(507).send({ error: 'Storage quota exceeded. Delete objects or upgrade your plan to free up space.' });
    }

    const { size, etag, storagePath } = await storageEngine.saveObject(name, key, buffer);

    const objectRecord = await db.object.upsert({
      where: { bucketName_key: { bucketName: name, key } },
      create: {
        bucketName: name,
        key,
        size,
        contentType,
        etag,
        storagePath,
      },
      update: {
        size,
        contentType,
        etag,
        storagePath,
        updatedAt: new Date(),
      },
    });

    return reply.status(201).send(objectRecord);
  });

  fastify.delete('/api/admin/buckets/:name/objects/*', async (req, reply) => {
    const { name } = req.params as { name: string };
    const key = (req.params as any)['*'];
    if (!key) return reply.status(400).send({ error: 'Missing object key' });

    const obj = await db.object.findUnique({
      where: { bucketName_key: { bucketName: name, key } },
    });

    if (obj) {
      await storageEngine.deleteObjectFile(obj.storagePath);
      await db.object.delete({ where: { id: obj.id } });
    }

    return { success: true };
  });

  fastify.post('/api/admin/buckets/:name/presigned', async (req, reply) => {
    const { name } = req.params as { name: string };
    const { key, expiresInSeconds } = req.body as { key: string; expiresInSeconds?: number };

    // Prefer a key that can access this bucket (unrestricted or matching filter)
    const keyRecord =
      (await db.accessKey.findFirst({
        where: { OR: [{ bucketFilter: null }, { bucketFilter: name }] },
        orderBy: { createdAt: 'desc' },
      })) ||
      (await db.accessKey.findFirst({ orderBy: { createdAt: 'desc' } }));
    if (!keyRecord) {
      return reply.status(400).send({ error: 'No Access Key created yet. Please create an Access Key first.' });
    }

    const host = req.headers.host || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${host}`;

    const presignedUrl = S3Auth.generatePresignedUrl(
      baseUrl,
      name,
      key,
      keyRecord.accessKeyId,
      keyRecord.secretAccessKey,
      expiresInSeconds || 3600
    );

    return { url: presignedUrl, expiresInSeconds: expiresInSeconds || 3600 };
  });

  // 4. Access Keys API
  fastify.get('/api/admin/keys', async () => {
    return await db.accessKey.findMany({ orderBy: { createdAt: 'desc' } });
  });

  fastify.post('/api/admin/keys', async (req, reply) => {
    const { name, permission, bucketFilter } = req.body as { name?: string; permission?: string; bucketFilter?: string };

    const accessKeyId = 'r2_' + crypto.randomBytes(12).toString('hex');
    const secretAccessKey = crypto.randomBytes(24).toString('hex');

    const key = await db.accessKey.create({
      data: {
        accessKeyId,
        secretAccessKey,
        name: name || 'API Key',
        permission: permission || 'FULL',
        bucketFilter: bucketFilter || null,
      },
    });

    return reply.status(201).send(key);
  });

  fastify.delete('/api/admin/keys/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.accessKey.delete({ where: { id } });
    return { success: true };
  });

  // 5. Custom Domains API
  fastify.get('/api/admin/domains', async () => {
    return await db.customDomain.findMany({ orderBy: { createdAt: 'desc' } });
  });

  fastify.post('/api/admin/domains', async (req, reply) => {
    const { domain, bucketName } = req.body as { domain: string; bucketName: string };
    if (!domain || !bucketName) {
      return reply.status(400).send({ error: 'Domain and bucketName are required.' });
    }

    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) return reply.status(404).send({ error: 'Bucket not found' });

    const newDomain = await db.customDomain.create({
      data: {
        domain: domain.toLowerCase().trim(),
        bucketName,
        sslStatus: 'ACTIVE',
      },
    });

    return reply.status(201).send(newDomain);
  });

  fastify.delete('/api/admin/domains/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.customDomain.delete({ where: { id } });
    return { success: true };
  });

  // 6. Usage & metering — polled by the SaaS control plane for billing/metering.
  // Returns storage as of now plus requests/bytesTransferred recorded since the
  // given ISO 8601 `since` timestamp (or all time if omitted).
  fastify.get('/api/admin/usage', async (req, reply) => {
    const { since } = req.query as { since?: string };
    let sinceDate: Date | undefined;
    if (since) {
      sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return reply.status(400).send({ error: 'Invalid `since` timestamp. Expected an ISO 8601 date.' });
      }
    }

    const where = sinceDate ? { createdAt: { gt: sinceDate } } : {};

    const [storageResult, requestLogsResult] = await Promise.all([
      db.object.aggregate({ _sum: { size: true } }),
      db.requestLog.aggregate({ where, _sum: { bytesTransferred: true } }),
    ]);
    const requests = await db.requestLog.count({ where });

    return {
      storageBytes: storageResult._sum.size || 0,
      requests,
      bytesTransferred: requestLogsResult._sum.bytesTransferred || 0,
      since: sinceDate ? sinceDate.toISOString() : null,
    };
  });

  // 7. Storage quota — read by the control plane at provisioning, adjusted at
  // runtime on plan changes (0 = unlimited).
  fastify.get('/api/admin/quota', async () => ({
    storageBytesLimit: await getStorageQuota(),
    storageBytes: await usedStorageBytes(),
  }));

  fastify.patch('/api/admin/quota', async (req, reply) => {
    const { storageBytesLimit } = (req.body || {}) as { storageBytesLimit?: unknown };
    if (typeof storageBytesLimit !== 'number' || !Number.isFinite(storageBytesLimit) || storageBytesLimit < 0) {
      return reply.status(400).send({ error: 'storageBytesLimit must be a non-negative integer (0 = unlimited).' });
    }
    await setStorageQuota(storageBytesLimit);
    return { storageBytesLimit: await getStorageQuota() };
  });
}
