import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db';
import { storageEngine } from '../storage/engine';
import { S3Auth, AuthResult } from '../auth/s3auth';
import { wouldExceedQuota } from '../quota';
import mime from 'mime-types';
import crypto from 'crypto';
import { Readable } from 'stream';
import { parseRangeHeader, notModified, checkWritePreconditions } from './range';

function bodyAsStream(body: unknown): NodeJS.ReadableStream {
  if (body && typeof (body as any).pipe === 'function') {
    return body as NodeJS.ReadableStream;
  }
  return Readable.from((body as Buffer) || Buffer.alloc(0));
}

function renderMultipartInitXml(bucketName: string, key: string, uploadId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <UploadId>${escapeXml(uploadId)}</UploadId>
</InitiateMultipartUploadResult>`;
}

function renderMultipartCompleteXml(bucketName: string, key: string, etag: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <ETag>${escapeXml(etag)}</ETag>
</CompleteMultipartUploadResult>`;
}

function permissionDenied(auth: AuthResult, bucketName: string, required: 'read' | 'write' | 'full'): string | null {
  if (auth.bucketFilter && auth.bucketFilter !== bucketName) {
    return 'API Key is not authorized for this bucket.';
  }
  if (required === 'read' && auth.permission === 'WRITE_ONLY') {
    return 'API Key has Write Only permissions and cannot read.';
  }
  if (required === 'write' && auth.permission === 'READ_ONLY') {
    return 'API Key has Read Only permissions and cannot write.';
  }
  if (required === 'full' && auth.permission !== 'FULL') {
    return 'This operation requires Full Access permissions.';
  }
  return null;
}

export async function s3Routes(fastify: FastifyInstance) {
  // Catch-all S3 protocol handler under `/s3/:bucket/*` and `/s3/:bucket`
  
  // 1. GET /s3/:bucket (ListObjectsV2)
  fastify.get('/s3/:bucket', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const query = req.query as Record<string, string>;

    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'The specified bucket does not exist.'));
    }

    if (!bucket.isPublic) {
      const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
      if (!auth.authenticated) {
        return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
      }
      const denied = permissionDenied(auth, bucketName, 'read');
      if (denied) {
        return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
      }
    }

    const prefix = query['prefix'] || '';
    const objects = await db.object.findMany({
      where: {
        bucketName,
        ...(prefix ? { key: { startsWith: prefix } } : {}),
      },
      take: 1000,
    });

    const xml = renderListObjectsV2Xml(bucketName, prefix, objects);
    return reply.status(200).type('application/xml').send(xml);
  });

  // 2. GET /s3/:bucket/* (GetObject)
  fastify.get('/s3/:bucket/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const key = (req.params as any)['*'];
    const query = req.query as Record<string, string>;

    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'Bucket not found'));
    }

    if (!bucket.isPublic) {
      const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
      if (!auth.authenticated) {
        return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
      }
      const denied = permissionDenied(auth, bucketName, 'read');
      if (denied) {
        return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
      }
    }

    const obj = await db.object.findUnique({
      where: { bucketName_key: { bucketName, key } },
    });

    if (!obj) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'The specified key does not exist.'));
    }

    // Set CORS headers
    reply.header('Access-Control-Allow-Origin', bucket.corsOrigins || '*');
    reply.header('Content-Type', obj.contentType);
    reply.header('ETag', obj.etag);
    reply.header('Cache-Control', 'public, max-age=31536000');
    reply.header('Accept-Ranges', 'bytes');

    // Conditional GET: honor If-None-Match / If-Modified-Since (RFC 7232).
    if (notModified(req.headers as Record<string, unknown>, obj.etag, obj.updatedAt)) {
      return reply.status(304).send();
    }

    // Byte-range GET: single `bytes=` range → 206, unsatisfiable → 416,
    // anything else (malformed, multi-range) serves the full object as 200.
    let status = 200;
    let contentLength = obj.size;
    let rangeHeader: string | undefined;
    const range = req.headers.range as string | undefined;
    const spec = parseRangeHeader(range, obj.size);
    if (spec.kind === 'invalid') {
      reply.header('Content-Range', `bytes */${obj.size}`);
      return reply.status(416).type('application/xml').send(renderS3ErrorXml('InvalidRange', 'The requested range is not satisfiable'));
    }

    let stream: NodeJS.ReadableStream | null;
    if (spec.kind === 'partial') {
      status = 206;
      contentLength = spec.length!;
      rangeHeader = `bytes ${spec.start}-${spec.end}/${obj.size}`;
      stream = await storageEngine.getObjectStreamRange(obj.storagePath, spec.start!, spec.end!);
    } else {
      stream = await storageEngine.getObjectStream(obj.storagePath);
    }
    if (!stream) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'Object storage file missing'));
    }

    reply.header('Content-Length', contentLength);
    if (rangeHeader) reply.header('Content-Range', rangeHeader);

    // Log request asynchronously
    db.requestLog.create({
      data: {
        bucketName,
        method: 'GET',
        path: req.url,
        status,
        ip: req.ip || '127.0.0.1',
        bytesTransferred: contentLength,
      },
    }).catch(() => {});

    return reply.status(status).send(stream);
  });

  // 3. PUT /s3/:bucket/* (PutObject)
  fastify.put('/s3/:bucket/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const key = (req.params as any)['*'];
    const query = req.query as Record<string, string>;

    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'Bucket not found'));
    }

    const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
    if (!auth.authenticated) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
    }

    const denied = permissionDenied(auth, bucketName, 'write');
    if (denied) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
    }

    // 3a. CopyObject — PUT with an x-amz-copy-source header clones the source
    // object server-side (no payload). Read permission on the source is
    // required too (the authenticated key must span both buckets).
    const copySource = req.headers['x-amz-copy-source'] as string | undefined;
    if (copySource) {
      let srcBucket: string;
      let srcKey: string;
      try {
        const decoded = decodeURIComponent(copySource.replace(/^\//, '').split('?')[0]);
        const slash = decoded.indexOf('/');
        if (slash <= 0 || slash === decoded.length - 1) throw new Error('malformed');
        srcBucket = decoded.slice(0, slash);
        srcKey = decoded.slice(slash + 1);
      } catch {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('InvalidArgument', 'The x-amz-copy-source header is malformed.')
        );
      }

      const srcBucketRec = await db.bucket.findUnique({ where: { name: srcBucket } });
      if (!srcBucketRec) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'The source bucket does not exist.'));
      }
      const srcObj = await db.object.findUnique({
        where: { bucketName_key: { bucketName: srcBucket, key: srcKey } },
      });
      if (!srcObj) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'The specified copy source does not exist.'));
      }

      // Read on source: skip only when the source bucket is public (mirrors the
      // anonymous GET path); otherwise the principal must be authorized.
      if (!srcBucketRec.isPublic) {
        const srcDenied = permissionDenied(auth, srcBucket, 'read');
        if (srcDenied) {
          return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', srcDenied));
        }
      }

      const directive = (req.headers['x-amz-metadata-directive'] as string || 'COPY').trim().toUpperCase();
      if (directive !== 'COPY' && directive !== 'REPLACE') {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('InvalidArgument', 'x-amz-metadata-directive must be COPY or REPLACE.')
        );
      }

      // Copying an object onto itself only makes sense with REPLACE (metadata
      // rewrite); AWS rejects the plain COPY form.
      if (srcBucket === bucketName && srcKey === key && directive !== 'REPLACE') {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('InvalidRequest', 'This copy request is illegal because it is trying to copy an object to itself without changing the object\'s metadata, storage class, website redirect location or encryption attributes.')
        );
      }

      const destObj = await db.object.findUnique({
        where: { bucketName_key: { bucketName, key } },
      });
      // Conditional writes apply to the copy destination, as on a plain PUT.
      const precondition = checkWritePreconditions(
        req.headers as Record<string, unknown>,
        destObj ? { etag: destObj.etag, updatedAt: destObj.updatedAt } : null,
      );
      if (precondition === 'precondition-failed') {
        return reply.status(412).type('application/xml').send(renderS3ErrorXml('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'));
      }
      if (precondition === 'conflict') {
        return reply.status(409).type('application/xml').send(renderS3ErrorXml('ConditionalRequestConflict', 'The conditional request cannot succeed because the object already exists'));
      }
      // A copy adds the source's size minus whatever it replaces at the dest.
      const addedBytes = srcObj.size - (destObj?.size || 0);
      if (addedBytes > 0 && (await wouldExceedQuota(addedBytes))) {
        return reply.status(507).type('application/xml').send(
          renderS3ErrorXml('InsufficientStorage', 'Storage quota exceeded. Delete objects or upgrade your plan to free up space.')
        );
      }

      const destContentType =
        directive === 'REPLACE'
          ? (req.headers['content-type'] as string) || srcObj.contentType
          : srcObj.contentType;
      const storagePath = await storageEngine.copyObjectFile(srcObj.storagePath, bucketName, key);

      await db.object.upsert({
        where: { bucketName_key: { bucketName, key } },
        create: {
          bucketName,
          key,
          size: srcObj.size,
          contentType: destContentType,
          etag: srcObj.etag,
          storagePath,
        },
        update: {
          size: srcObj.size,
          contentType: destContentType,
          etag: srcObj.etag,
          storagePath,
          updatedAt: new Date(),
        },
      });

      reply.header('Access-Control-Allow-Origin', bucket.corsOrigins || '*');
      reply.header('Access-Control-Expose-Headers', 'ETag');
      return reply.status(200).type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <ETag>${escapeXml(srcObj.etag)}</ETag>
  <LastModified>${new Date().toISOString()}</LastModified>
</CopyObjectResult>`
      );
    }

    const contentType = (req.headers['content-type'] as string) || mime.lookup(key) || 'application/octet-stream';

    // UploadPart (multipart)
    const uploadId = query['uploadId'];
    const partNumber = query['partNumber'] !== undefined ? parseInt(query['partNumber'], 10) : NaN;
    if (uploadId && Number.isInteger(partNumber) && partNumber >= 1) {
      const upload = await db.multipartUpload.findUnique({ where: { uploadId } });
      if (!upload) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchUpload', 'The specified upload does not exist.'));
      }
      // Multipart parts consume disk before the upload completes, so enforce the
    // quota here too — otherwise parts could fill the disk while never being
    // completed (the complete-time check would never fire). Re-uploading the
    // same part replaces its bytes, so subtract the old part's size.
    const existingPart = await db.multipartPart.findUnique({
      where: { uploadId_partNumber: { uploadId, partNumber } },
    });
    const partsSum = (await db.multipartPart.aggregate({ where: { uploadId }, _sum: { size: true } }))._sum.size || 0;
    const partLength = parseInt((req.headers['content-length'] as string) || '0', 10);
    const addedBytes = partsSum - (existingPart?.size || 0) + partLength;
    if (addedBytes > 0 && (await wouldExceedQuota(addedBytes))) {
      return reply.status(507).type('application/xml').send(
        renderS3ErrorXml('InsufficientStorage', 'Storage quota exceeded. Delete objects or upgrade your plan to free up space.')
      );
    }

    const part = await storageEngine.savePartFromStream(uploadId, partNumber, bodyAsStream(req.body));

      await db.multipartPart.upsert({
        where: { uploadId_partNumber: { uploadId, partNumber } },
        create: { uploadId, partNumber, etag: part.etag, size: part.size, storagePath: part.storagePath },
        update: { etag: part.etag, size: part.size, storagePath: part.storagePath, createdAt: new Date() },
      });

      reply.header('Access-Control-Allow-Origin', bucket.corsOrigins || '*');
      reply.header('ETag', part.etag);
      return reply.status(200).send();
    }

    // PutObject (streamed to local disk)
    const existing = await db.object.findUnique({
      where: { bucketName_key: { bucketName, key } },
    });

    // Conditional writes: If-Match / If-None-Match: * / If-Unmodified-Since.
    // Checked before streaming the body so a failed precondition never
    // consumes the payload.
    const precondition = checkWritePreconditions(
      req.headers as Record<string, unknown>,
      existing ? { etag: existing.etag, updatedAt: existing.updatedAt } : null,
    );
    if (precondition === 'precondition-failed') {
      return reply.status(412).type('application/xml').send(renderS3ErrorXml('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'));
    }
    if (precondition === 'conflict') {
      return reply.status(409).type('application/xml').send(renderS3ErrorXml('ConditionalRequestConflict', 'The conditional request cannot succeed because the object already exists'));
    }

    // Early reject when the declared Content-Length already exceeds the quota
    // (avoids streaming a payload we know we will refuse).
    const contentLength = parseInt((req.headers['content-length'] as string) || '0', 10);
    if (contentLength > 0 && (await wouldExceedQuota(contentLength, existing?.size || 0))) {
      return reply.status(507).type('application/xml').send(
        renderS3ErrorXml('InsufficientStorage', 'Storage quota exceeded. Delete objects or upgrade your plan to free up space.')
      );
    }

    const { size, etag, storagePath } = await storageEngine.saveObjectFromStream(bucketName, key, bodyAsStream(req.body));

    // Authoritative post-write check (also covers requests without Content-Length).
    if (await wouldExceedQuota(size, existing?.size || 0)) {
      await storageEngine.deleteObjectFile(storagePath);
      return reply.status(507).type('application/xml').send(
        renderS3ErrorXml('InsufficientStorage', 'Storage quota exceeded. Delete objects or upgrade your plan to free up space.')
      );
    }

    await db.object.upsert({
      where: { bucketName_key: { bucketName, key } },
      create: {
        bucketName,
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

    reply.header('Access-Control-Allow-Origin', bucket.corsOrigins || '*');
    reply.header('ETag', etag);
    return reply.status(200).send();
  });

  // 4. DELETE /s3/:bucket/* (DeleteObject / AbortMultipartUpload)
  fastify.delete('/s3/:bucket/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const key = (req.params as any)['*'];
    const query = req.query as Record<string, string>;

    const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
    if (!auth.authenticated) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
    }

    // AbortMultipartUpload
    const uploadId = query['uploadId'];
    if (uploadId) {
      const writeDenied = permissionDenied(auth, bucketName, 'write');
      if (writeDenied) {
        return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', writeDenied));
      }
      const upload = await db.multipartUpload.findUnique({ where: { uploadId } });
      if (!upload) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchUpload', 'The specified upload does not exist.'));
      }
      await db.multipartUpload.delete({ where: { uploadId } });
      await storageEngine.deleteUploadParts(uploadId);
      return reply.status(204).send();
    }

    // DeleteObject
    const denied = permissionDenied(auth, bucketName, 'full');
    if (denied) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
    }

    const obj = await db.object.findUnique({
      where: { bucketName_key: { bucketName, key } },
    });

    if (obj) {
      await storageEngine.deleteObjectFile(obj.storagePath);
      await db.object.delete({ where: { id: obj.id } });
    }

    return reply.status(204).send();
  });

  // 5. HEAD /s3/:bucket/* (HeadObject)
  // fastify 5 auto-maps HEAD to the GET route (same headers, no body), so no
  // explicit HEAD registration is needed.

  // 6. POST /s3/:bucket/* (CreateMultipartUpload / CompleteMultipartUpload)
  fastify.post('/s3/:bucket/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const key = (req.params as any)['*'];
    const query = req.query as Record<string, string>;

    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'Bucket not found'));
    }

    const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
    if (!auth.authenticated) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
    }
    const denied = permissionDenied(auth, bucketName, 'write');
    if (denied) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
    }

    // CreateMultipartUpload
    if (query['uploads'] !== undefined) {
      const uploadId = crypto.randomUUID();
      const contentType = (req.headers['content-type'] as string) || mime.lookup(key) || 'application/octet-stream';
      await db.multipartUpload.create({
        data: { bucketName, key, uploadId, contentType },
      });
      return reply.status(200).type('application/xml').send(renderMultipartInitXml(bucketName, key, uploadId));
    }

    // CompleteMultipartUpload
    const uploadId = query['uploadId'];
    if (!uploadId) {
      return reply.status(400).type('application/xml').send(renderS3ErrorXml('InvalidRequest', 'Missing required parameter uploadId'));
    }

    const upload = await db.multipartUpload.findUnique({ where: { uploadId } });
    if (!upload) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchUpload', 'The specified upload does not exist.'));
    }

    let completeXml: string;
    try {
      completeXml = await streamToString(bodyAsStream(req.body), MAX_COMPLETE_XML_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return reply.status(413).type('application/xml').send(
          renderS3ErrorXml('EntityTooLarge', 'The CompleteMultipartUpload body exceeds the 1MB limit.')
        );
      }
      throw err;
    }
    const partNumbers = [...completeXml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => parseInt(m[1], 10));
    const etags = [...completeXml.matchAll(/<ETag>([^<]+)<\/ETag>/g)].map((m) => m[1].trim());

    const storedParts = await db.multipartPart.findMany({ where: { uploadId }, orderBy: { partNumber: 'asc' } });
    const storedByNumber = new Map(storedParts.map((p) => [p.partNumber, p]));

    const partsToUse: typeof storedParts = [];
    for (let i = 0; i < partNumbers.length; i++) {
      const partNumber = partNumbers[i];
      const expectedEtag = etags[i] || '';
      const stored = storedByNumber.get(partNumber);
      if (!stored || stored.etag !== expectedEtag) {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('InvalidPart', `One or more of the specified parts (partNumber=${partNumber}) could not be found or matched.`)
        );
      }
      partsToUse.push(stored);
    }
    if (partsToUse.length === 0) {
      return reply.status(400).type('application/xml').send(renderS3ErrorXml('InvalidPartOrder', 'The list of parts was empty or invalid.'));
    }

    // Quota check before assembling: the final size is exactly the sum of parts.
    const assembledSize = partsToUse.reduce((s, p) => s + p.size, 0);
    const existingObj = await db.object.findUnique({
      where: { bucketName_key: { bucketName, key } },
    });

    // Conditional writes apply to completion too (the upload's object already
    // exists). Same 412/409 semantics as PutObject.
    const precondition = checkWritePreconditions(
      req.headers as Record<string, unknown>,
      existingObj ? { etag: existingObj.etag, updatedAt: existingObj.updatedAt } : null,
    );
    if (precondition === 'precondition-failed') {
      return reply.status(412).type('application/xml').send(renderS3ErrorXml('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'));
    }
    if (precondition === 'conflict') {
      return reply.status(409).type('application/xml').send(renderS3ErrorXml('ConditionalRequestConflict', 'The conditional request cannot succeed because the object already exists'));
    }

    if (await wouldExceedQuota(assembledSize, existingObj?.size || 0)) {
      return reply.status(507).type('application/xml').send(
        renderS3ErrorXml('InsufficientStorage', 'Storage quota exceeded. Delete objects or upgrade your plan to free up space.')
      );
    }

    const { size, etag, storagePath } = await storageEngine.assembleUpload(bucketName, key, partsToUse);

    await db.object.upsert({
      where: { bucketName_key: { bucketName, key } },
      create: {
        bucketName,
        key,
        size,
        contentType: upload.contentType,
        etag,
        storagePath,
      },
      update: {
        size,
        contentType: upload.contentType,
        etag,
        storagePath,
        updatedAt: new Date(),
      },
    });

    await db.multipartUpload.delete({ where: { uploadId } });
    await storageEngine.deleteUploadParts(uploadId);

    return reply.status(200).type('application/xml').send(renderMultipartCompleteXml(bucketName, key, etag));
  });

  // 7. POST /s3/:bucket?delete (DeleteObjects batch)
  fastify.post('/s3/:bucket', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const query = req.query as Record<string, string>;

    if (query['delete'] === undefined) {
      return reply.status(400).type('application/xml').send(
        renderS3ErrorXml('InvalidRequest', 'Bucket-level POST only supports the DeleteObjects operation via ?delete')
      );
    }

    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'Bucket not found'));
    }

    const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
    if (!auth.authenticated) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
    }
    const denied = permissionDenied(auth, bucketName, 'full');
    if (denied) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
    }

    // The key list is capped the same way as the multipart part list: bounded
    // body (1MB) and a hard key count limit so a hostile batch can't blow up
    // memory or the loop.
    let deleteXml: string;
    try {
      deleteXml = await streamToString(bodyAsStream(req.body), MAX_COMPLETE_XML_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return reply.status(413).type('application/xml').send(
          renderS3ErrorXml('EntityTooLarge', 'The DeleteObjects body exceeds the 1MB limit.')
        );
      }
      throw err;
    }

    const quiet = /<Quiet>\s*(true|1)\s*<\/Quiet>/i.test(deleteXml);
    const keys = [...deleteXml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => k.length > 0);
    // S3 rejects duplicate keys in one batch; dedupe to stay safe regardless.
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) {
      return reply.status(400).type('application/xml').send(
        renderS3ErrorXml('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema')
      );
    }
    if (uniqueKeys.length > 1000) {
      return reply.status(400).type('application/xml').send(
        renderS3ErrorXml('MalformedXML', 'The DeleteObjects request contains more than 1000 keys')
      );
    }

    const objects = await db.object.findMany({
      where: { bucketName, key: { in: uniqueKeys } },
    });
    const byKey = new Map(objects.map((o) => [o.key, o]));

    const deleted: string[] = [];
    const errors: { key: string; code: string; message: string }[] = [];
    for (const key of uniqueKeys) {
      const obj = byKey.get(key);
      if (!obj) continue; // S3 silently ignores keys that don't exist
      try {
        await storageEngine.deleteObjectFile(obj.storagePath);
        await db.object.delete({ where: { id: obj.id } });
        deleted.push(key);
      } catch (err) {
        errors.push({ key, code: 'InternalError', message: 'We encountered an internal error. Please try again.' });
      }
    }

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n`;
    if (!quiet) {
      for (const key of deleted) xml += `  <Deleted><Key>${escapeXml(key)}</Key></Deleted>\n`;
    }
    for (const e of errors) {
      xml += `  <Error><Key>${escapeXml(e.key)}</Key><Code>${escapeXml(e.code)}</Code><Message>${escapeXml(e.message)}</Message></Error>\n`;
    }
    xml += `</DeleteResult>`;

    reply.header('Access-Control-Allow-Origin', bucket.corsOrigins || '*');
    return reply.status(200).type('application/xml').send(xml);
  });
}

function renderListObjectsV2Xml(bucketName: string, prefix: string, objects: any[]): string {
  const contents = objects
    .map(
      (o) => `
    <Contents>
      <Key>${escapeXml(o.key)}</Key>
      <LastModified>${o.updatedAt.toISOString()}</LastModified>
      <ETag>${o.etag}</ETag>
      <Size>${o.size}</Size>
      <StorageClass>STANDARD</StorageClass>
    </Contents>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${escapeXml(prefix)}</Prefix>
  <KeyCount>${objects.length}</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>${contents}
</ListBucketResult>`;
}

function renderS3ErrorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${escapeXml(code)}</Code>
  <Message>${escapeXml(message)}</Message>
</Error>`;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

async function streamToString(stream: NodeJS.ReadableStream, maxBytes = Infinity): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Thrown when a request body exceeds its declared cap (see CompleteMultipartUpload).
class BodyTooLargeError extends Error {}

// An S3 part list is tiny (tens of bytes per part); capping the XML body at 1MB
// stops an authenticated client from buffering gigabytes into memory to exhaust
// the server (the catch-all parser allows up to 10GB).
const MAX_COMPLETE_XML_BYTES = 1024 * 1024;
