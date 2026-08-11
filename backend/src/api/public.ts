import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db';
import { storageEngine } from '../storage/engine';
import { CONFIG } from '../config';
import { parseRangeHeader, notModified } from './range';

/**
 * Resolves a request for a public custom-domain URL and streams the object.
 *
 * Returns true if the request was fully handled (object streamed, or an error
 * such as 404/403 already sent because the host is a recognized storage host
 * but the object cannot be served). Returns false only when the host is not
 * mapped to any bucket (or the path is empty), letting callers fall through
 * to the SPA handler.
 */
export async function tryServePublicObject(
  req: FastifyRequest,
  reply: FastifyReply,
  explicitKey?: string
): Promise<boolean> {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  let key = explicitKey;
  if (key === undefined) {
    key = req.url.split('?')[0].replace(/^\/+/, '');
    try {
      key = decodeURIComponent(key);
    } catch {
      return false;
    }
  }

  let bucketName: string | null = null;

  // 1. Check custom domain table
  const domainRecord = await db.customDomain.findUnique({
    where: { domain: host },
  });

  if (domainRecord) {
    bucketName = domainRecord.bucketName;
  } else if (host.endsWith(`.${CONFIG.BASE_DOMAIN}`)) {
    // Subdomain resolution e.g. mybucket.storage.domain.com
    bucketName = host.replace(`.${CONFIG.BASE_DOMAIN}`, '');
  }

  // Host isn't a recognized storage host: let the SPA fallback handle it.
  if (!bucketName) return false;

  // Root path: let the SPA handler serve the dashboard.
  if (!key) return false;

  const bucket = await db.bucket.findUnique({ where: { name: bucketName } });

  if (!bucket || !bucket.isPublic) {
    reply.status(403).send({ error: 'Bucket is private.' });
    return true;
  }

  const obj = await db.object.findUnique({
    where: { bucketName_key: { bucketName, key } },
  });

  if (!obj) {
    reply.status(404).send({ error: 'Object not found.' });
    return true;
  }

  const stream = await storageEngine.getObjectStream(obj.storagePath);
  if (!stream) {
    reply.status(404).send({ error: 'Object storage file missing.' });
    return true;
  }

  reply.header('Access-Control-Allow-Origin', bucket.corsOrigins || '*');
  reply.header('Content-Type', obj.contentType);
  reply.header('ETag', obj.etag);
  reply.header('Cache-Control', 'public, max-age=31536000');
  reply.header('Accept-Ranges', 'bytes');

  // Conditional GET + byte ranges behave like the S3 route (206/416/304);
  // useful for media streams served from a custom domain.
  if (notModified(req.headers as Record<string, unknown>, obj.etag, obj.updatedAt)) {
    await reply.status(304).send();
    return true;
  }

  const spec = parseRangeHeader(req.headers.range as string | undefined, obj.size);
  if (spec.kind === 'invalid') {
    reply.header('Content-Range', `bytes */${obj.size}`);
    await reply.status(416).send({ error: 'Range Not Satisfiable' });
    return true;
  }

  let status = 200;
  let contentLength = obj.size;
  let rangeHeader: string | undefined;
  let body: NodeJS.ReadableStream;
  if (spec.kind === 'partial') {
    status = 206;
    contentLength = spec.length!;
    rangeHeader = `bytes ${spec.start}-${spec.end}/${obj.size}`;
    const ranged = await storageEngine.getObjectStreamRange(obj.storagePath, spec.start!, spec.end!);
    if (!ranged) {
      await reply.status(404).send({ error: 'Object storage file missing.' });
      return true;
    }
    body = ranged;
  } else {
    body = stream;
  }

  reply.header('Content-Length', contentLength);
  if (rangeHeader) reply.header('Content-Range', rangeHeader);

  await reply.status(status).send(body);
  return true;
}

export async function publicDomainRoutes(fastify: FastifyInstance) {
  // Backward-compatible /public/<key> asset resolver
  fastify.get('/public/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = (req.params as any)['*'];
    const handled = await tryServePublicObject(req, reply, key);
    if (!handled) {
      return reply.status(404).send({ error: 'Asset not found.' });
    }
  });
}
