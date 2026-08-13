import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db';
import { storageEngine } from '../storage/engine';
import { S3Auth, AuthResult } from '../auth/s3auth';
import { wouldExceedQuota } from '../quota';
import mime from 'mime-types';
import crypto from 'crypto';
import { Readable } from 'stream';
import { parseRangeHeader, notModified, readPreconditionFailed, checkWritePreconditions } from './range';
import { extractMetadataFromHeaders, serializeMetadata, metadataHeaders } from './metadata';
import {
  parseTaggingHeader,
  parseTaggingXml,
  serializeTags,
  deserializeTags,
  tagCount,
  renderTaggingXml,
} from './tags';
import {
  parseLifecycleXml,
  serializeLifecycleRules,
  deserializeLifecycleRules,
  renderLifecycleXml,
} from './lifecycle';
import {
  parseCorsXml,
  serializeCorsRules,
  deserializeCorsRules,
  renderCorsXml,
  corsHeadersForRequest,
} from './cors';
import { validateSseC, applySseCResponseHeaders } from './ssec';

function bodyAsStream(body: unknown): NodeJS.ReadableStream {
  if (body && typeof (body as any).pipe === 'function') {
    return body as NodeJS.ReadableStream;
  }
  return Readable.from((body as Buffer) || Buffer.alloc(0));
}

// Bucket-level CORS on object routes. When the bucket carries explicit CORS
// rules (PutBucketCors), the request's Origin is matched against them and the
// Access-Control-* headers follow; otherwise the admin-set corsOrigins string
// (default `*`) is sent verbatim, preserving the legacy behavior.
function applyCorsHeaders(
  reply: FastifyReply,
  bucket: { corsRules: string | null; corsOrigins: string },
  req: FastifyRequest
) {
  const rules = deserializeCorsRules(bucket.corsRules);
  if (rules.length > 0) {
    const origin = (req.headers.origin as string | undefined) || '';
    const headers = corsHeadersForRequest(rules, origin, {});
    for (const [name, value] of Object.entries(headers)) {
      reply.header(name, value);
    }
    return;
  }
  reply.header('Access-Control-Allow-Origin', bucket.corsOrigins || '*');
}

function renderMultipartInitXml(bucketName: string, key: string, uploadId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <UploadId>${escapeXml(uploadId)}</UploadId>
</InitiateMultipartUploadResult>`;
}

// ETag values are server-generated `"hex"` strings (quotes + hex are legal
// raw XML text), so no escaping is needed — escaping the quotes would corrupt
// client round-trips (e.g. feeding a CopyPartResult ETag back into a
// CompleteMultipartUpload). ChecksumCRC32 (base64, no XML-significant chars)
// is emitted verbatim too, matching what newer SDKs parse from the result.
function renderMultipartCompleteXml(bucketName: string, key: string, etag: string, checksumCrc32?: string | null): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <ETag>${etag}</ETag>${checksumCrc32 ? `\n  <ChecksumCRC32>${checksumCrc32}</ChecksumCRC32>` : ''}
</CompleteMultipartUploadResult>`;
}

// Validate a request's Content-MD5 header against the md5 ETag the storage
// engine just produced. Returns an S3 error XML to send, or null when the
// digest matches (or no header was supplied).
function contentMd5Mismatch(headers: Record<string, unknown>, etag: string): string | null {
  const raw = (headers['content-md5'] as string | undefined)?.trim();
  if (!raw) return null;
  const supplied = Buffer.from(raw, 'base64');
  if (supplied.length === 0 || supplied.toString('base64') !== raw) {
    return renderS3ErrorXml('InvalidDigest', 'The Content-MD5 you specified is not valid.');
  }
  const computed = Buffer.from(etag.slice(1, -1), 'hex');
  if (computed.length !== supplied.length || !crypto.timingSafeEqual(computed, supplied)) {
    return renderS3ErrorXml('BadDigest', 'The Content-MD5 you specified did not match what we received.');
  }
  return null;
}

// Validate a request's x-amz-checksum-crc32 header (base64 of the 4-byte
// CRC-32) against what the storage engine computed over the plaintext. A
// malformed header is InvalidRequest; a mismatch is BadDigest (same family as
// the Content-MD5 check). Absent header → no check, matching AWS behavior.
function checksumCrc32Mismatch(headers: Record<string, unknown>, computedBase64: string): string | null {
  const raw = (headers['x-amz-checksum-crc32'] as string | undefined)?.trim();
  if (!raw) return null;
  const supplied = Buffer.from(raw, 'base64');
  if (supplied.length === 0 || supplied.toString('base64') !== raw) {
    return renderS3ErrorXml('InvalidRequest', 'The x-amz-checksum-crc32 header is not valid base64 of a CRC-32.');
  }
  const computed = Buffer.from(computedBase64, 'base64');
  if (computed.length !== supplied.length || !crypto.timingSafeEqual(computed, supplied)) {
    return renderS3ErrorXml('BadDigest', 'The checksum you specified did not match what we received.');
  }
  return null;
}

// Reads the optional x-amz-checksum-mode header (ENABLED/FULL ask for the
// object's checksum on GET/HEAD). Returns 'enabled' | null, or a sentinel
// when the value is invalid so the caller can 400 it like AWS.
function checksumMode(headers: Record<string, unknown>): 'enabled' | 'none' | 'invalid' {
  const raw = (headers['x-amz-checksum-mode'] as string | undefined)?.trim().toLowerCase();
  if (!raw) return 'none';
  if (raw === 'enabled' || raw === 'full') return 'enabled';
  return 'invalid';
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

  // 0. GET /s3 (ListBuckets) — the service-level operation SDKs call to
  // enumerate buckets. Any valid key authenticates; keys scoped to one bucket
  // (the admin API's bucketFilter) only see that bucket, mirroring IAM scoping.
  fastify.get('/s3', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>;
    const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
    if (!auth.authenticated) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
    }
    const buckets = auth.bucketFilter
      ? await db.bucket.findMany({ where: { name: auth.bucketFilter } })
      : await db.bucket.findMany({ orderBy: { name: 'asc' } });
    const bucketsXml = buckets
      .map(
        (b) => `\n    <Bucket>\n      <Name>${escapeXml(b.name)}</Name>\n      <CreationDate>${b.createdAt.toISOString()}</CreationDate>\n    </Bucket>`
      )
      .join('');
    return reply.status(200).type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner>
    <ID>anon</ID>
    <DisplayName>admin</DisplayName>
  </Owner>
  <Buckets>${bucketsXml}
  </Buckets>
</ListAllMyBucketsResult>`
    );
  });

  // HeadBucket (HEAD /s3/:bucket) — SDKs ping this before listing/uploading.
  // Registered BEFORE the GET route so fastify's exposeHeadRoutes skips the
  // auto-created HEAD (which would otherwise run the full list handler).
  fastify.head('/s3/:bucket', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'The specified bucket does not exist.'));
    }
    if (!bucket.isPublic) {
      const query = req.query as Record<string, string>;
      const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
      if (!auth.authenticated) {
        return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
      }
      const denied = permissionDenied(auth, bucketName, 'read');
      if (denied) {
        return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
      }
    }
    return reply.status(200).send();
  });

  // 1. GET /s3/:bucket (ListObjectsV2, GetBucketLocation, ListMultipartUploads)
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

    // GetBucketLocation: SDKs (boto3, aws-sdk-v3) probe this on every client
    // init. Single-region, so the constraint is always empty (us-east-1).
    if (query['location'] !== undefined) {
      return reply.status(200).type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></LocationConstraint>`
      );
    }

    // ListMultipartUploads — in-progress uploads for the bucket, paginated the
    // same way ListObjects is: resume after key-marker (+upload-id-marker),
    // cap with max-uploads, fold shared prefixes with delimiter. Uploads are
    // ordered by (key, uploadId) so both markers resume deterministically;
    // upload-id-marker is ignored without key-marker, matching AWS.
    if (query['uploads'] !== undefined) {
      const prefix = query['prefix'] || '';
      const delimiter = query['delimiter'] || '';
      const encodingType = (query['encoding-type'] || '').toLowerCase() === 'url' ? 'url' : '';
      const enc = (v: string) => (encodingType ? escapeXml(encodeURIComponent(v)) : escapeXml(v));
      let maxUploads = parseInt(query['max-uploads'] || '1000', 10);
      if (!Number.isInteger(maxUploads) || maxUploads < 0) maxUploads = 1000;
      maxUploads = Math.min(maxUploads, 1000);
      const keyMarker = query['key-marker'] || '';
      const uploadIdMarker = query['upload-id-marker'] || '';

      const uploads = await db.multipartUpload.findMany({
        where: {
          bucketName,
          ...(prefix ? { key: { startsWith: prefix } } : {}),
        },
        orderBy: [{ key: 'asc' }, { uploadId: 'asc' }],
      });

      type UploadItem =
        | { kind: 'upload'; upload: (typeof uploads)[number] }
        | { kind: 'prefix'; prefix: string };
      const items: UploadItem[] = [];
      let truncated = false;
      for (const upload of uploads) {
        if (keyMarker) {
          // Resume strictly after (keyMarker, uploadIdMarker). A bare key-marker
          // skips the whole marker key (only lexicographically greater keys are
          // listed); with an upload-id-marker, that key's uploads resume too.
          if (upload.key < keyMarker) continue;
          if (upload.key === keyMarker) {
            if (!uploadIdMarker || upload.uploadId <= uploadIdMarker) continue;
          }
        }
        if (delimiter) {
          const rest = upload.key.slice(prefix.length);
          const di = rest.indexOf(delimiter);
          if (di !== -1) {
            const cp = upload.key.slice(0, prefix.length + di + delimiter.length);
            const prev = items[items.length - 1];
            if (prev && prev.kind === 'prefix' && prev.prefix === cp) continue;
            if (items.length >= maxUploads) { truncated = true; break; }
            items.push({ kind: 'prefix', prefix: cp });
            continue;
          }
        }
        if (items.length >= maxUploads) { truncated = true; break; }
        items.push({ kind: 'upload', upload });
      }

      // The next markers echo the last item consumed, so a page that ended on a
      // CommonPrefix resumes past the whole prefix with key-marker=<prefix>.
      const last = items[items.length - 1];
      const nextKeyMarker = truncated && last ? (last.kind === 'upload' ? last.upload.key : last.prefix) : '';
      const nextUploadIdMarker = truncated && last && last.kind === 'upload' ? last.upload.uploadId : '';

      const uploadXml = items
        .map((item) => {
          if (item.kind === 'prefix') {
            return `  <CommonPrefixes>\n    <Prefix>${enc(item.prefix)}</Prefix>\n  </CommonPrefixes>`;
          }
          const u = item.upload;
          return `
    <Upload>
      <Key>${enc(u.key)}</Key>
      <UploadId>${escapeXml(u.uploadId)}</UploadId>
      <Initiator>
        <ID>anon</ID>
      </Initiator>
      <Owner>
        <ID>anon</ID>
      </Owner>
      <StorageClass>STANDARD</StorageClass>
      <Initiated>${u.createdAt.toISOString()}</Initiated>
    </Upload>`;
        })
        .join('\n');

      return reply.status(200).type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <KeyMarker>${enc(keyMarker)}</KeyMarker>
  <UploadIdMarker>${escapeXml(uploadIdMarker)}</UploadIdMarker>
  <NextKeyMarker>${enc(nextKeyMarker)}</NextKeyMarker>
  <NextUploadIdMarker>${escapeXml(nextUploadIdMarker)}</NextUploadIdMarker>
  <MaxUploads>${maxUploads}</MaxUploads>
  <IsTruncated>${truncated}</IsTruncated>
  <Prefix>${enc(prefix)}</Prefix>${delimiter ? `\n  <Delimiter>${enc(delimiter)}</Delimiter>` : ''}${encodingType ? `\n  <EncodingType>url</EncodingType>` : ''}${uploadXml}
</ListMultipartUploadsResult>`
      );
    }

    // Bucket subresources probed by SDKs/tools on init. Without this, an
    // unknown `?subresource` would silently fall through to a 200 object
    // listing and corrupt client state. Respond with the correct "feature is
    // off/not configured" body, or NotImplemented for genuinely unsupported
    // operations — the S3-compliant way to signal "not here".
    const subresource = (
      ['versioning', 'acl', 'cors', 'policy', 'tagging', 'lifecycle', 'encryption', 'notification', 'replication', 'website'] as const
    ).find((s) => query[s] !== undefined);
    if (subresource) {
      switch (subresource) {
        case 'versioning':
          return reply.status(200).type('application/xml').send(
            `<?xml version="1.0" encoding="UTF-8"?>
<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`
          );
        case 'acl':
          return reply.status(200).type('application/xml').send(
            `<?xml version="1.0" encoding="UTF-8"?>
<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>anon</ID><DisplayName>admin</DisplayName></Owner>
  <AccessControlList>
    <Grant>
      <Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>anon</ID></Grantee>
      <Permission>FULL_CONTROL</Permission>
    </Grant>
  </AccessControlList>
</AccessControlPolicy>`
          );
        case 'cors': {
          const rules = deserializeCorsRules(bucket.corsRules);
          if (rules.length > 0) {
            return reply.status(200).type('application/xml').send(renderCorsXml(rules));
          }
          if (!bucket.corsOrigins) {
            return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchCORSConfiguration', 'The CORS configuration does not exist.'));
          }
          // Legacy buckets configured via the admin API carry a single origin
          // string; render it as the equivalent single-rule config.
          return reply.status(200).type('application/xml').send(
            `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>${escapeXml(bucket.corsOrigins)}</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>DELETE</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
  </CORSRule>
</CORSConfiguration>`
          );
        }
        case 'policy':
          return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucketPolicy', 'The bucket policy does not exist.'));
        case 'tagging':
          return reply.status(200).type('application/xml').send(renderTaggingXml(deserializeTags(bucket.tags)));
        case 'lifecycle': {
          const rules = deserializeLifecycleRules(bucket.lifecycleRules);
          if (rules.length === 0) {
            return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchLifecycleConfiguration', 'The lifecycle configuration does not exist.'));
          }
          return reply.status(200).type('application/xml').send(renderLifecycleXml(rules));
        }
        case 'encryption':
          return reply.status(404).type('application/xml').send(
            renderS3ErrorXml('ServerSideEncryptionConfigurationNotFoundError', 'The server side encryption configuration was not found.')
          );
        case 'notification':
          return reply.status(404).type('application/xml').send(renderS3ErrorXml('NotificationConfigurationNotFoundError', 'The notification configuration does not exist.'));
        case 'replication':
        case 'website':
        default:
          return reply.status(501).type('application/xml').send(renderS3ErrorXml('NotImplemented', 'This S3 operation is not supported.'));
      }
    }

    // ListObjectsV1 vs V2: `list-type=2` selects V2 (start-after /
    // continuation-token pagination); its absence is the legacy V1 API, which
    // paginates with `marker` and reports NextMarker. Older tools (s3cmd,
    // rclone, aws-sdk-v2) default to V1, so both must answer correctly.
    const isV2 = query['list-type'] === '2';
    const prefix = query['prefix'] || '';
    const delimiter = query['delimiter'] || '';
    let maxKeys = parseInt(query['max-keys'] || '1000', 10);
    if (!Number.isInteger(maxKeys) || maxKeys < 0) maxKeys = 1000;
    maxKeys = Math.min(maxKeys, 1000);
    const encodingType = (query['encoding-type'] || '').toLowerCase() === 'url' ? 'url' : '';
    let resumeAfter: string;
    let startAfter = '';
    let marker = '';
    if (isV2) {
      startAfter = query['start-after'] || '';
      resumeAfter = startAfter;
      // The continuation token is the base64url of the last raw key consumed by
      // the previous page; the client replays it as continuation-token and we
      // simply resume past that key. Tokens are opaque, so a malformed one is an
      // InvalidArgument.
      const ct = query['continuation-token'];
      if (ct !== undefined && ct !== '') {
        // Buffer.from(base64url) is lenient and never throws, so reject tokens
        // that don't round-trip to their own canonical encoding.
        const decoded = Buffer.from(ct, 'base64url').toString('utf8');
        if (Buffer.from(decoded).toString('base64url') !== ct) {
          return reply.status(400).type('application/xml').send(renderS3ErrorXml('InvalidArgument', 'The continuation token provided is incorrect'));
        }
        resumeAfter = decoded;
      }
    } else {
      marker = query['marker'] || '';
      resumeAfter = marker;
    }

    const objects = await db.object.findMany({
      where: {
        bucketName,
        ...(prefix ? { key: { startsWith: prefix } } : {}),
      },
      orderBy: { key: 'asc' },
    });
    const keys = objects.map((o) => o.key).filter((k) => (resumeAfter ? k > resumeAfter : true));

    // Fold keys past the first delimiter into CommonPrefixes (S3 folder
    // semantics), keeping contents + prefixes in lexicographic order and
    // honoring max-keys across both. The continuation token records the last
    // raw key consumed so a folded prefix is never re-listed on resume.
    type ListItem = { kind: 'content'; obj: (typeof objects)[number] } | { kind: 'prefix'; prefix: string };
    const objByKey = new Map(objects.map((o) => [o.key, o]));
    const items: ListItem[] = [];
    let truncated = false;
    let lastConsumed = '';
    for (const key of keys) {
      lastConsumed = key;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const di = rest.indexOf(delimiter);
        if (di !== -1) {
          const cp = key.slice(0, prefix.length + di + delimiter.length);
          const prev = items[items.length - 1];
          if (prev && prev.kind === 'prefix' && prev.prefix === cp) continue;
          if (items.length >= maxKeys) { truncated = true; break; }
          items.push({ kind: 'prefix', prefix: cp });
          continue;
        }
      }
      if (items.length >= maxKeys) { truncated = true; break; }
      items.push({ kind: 'content', obj: objByKey.get(key)! });
    }
    const token = truncated ? Buffer.from(lastConsumed).toString('base64url') : undefined;

    if (isV2) {
      const xml = renderListObjectsV2Xml(bucketName, {
        prefix,
        delimiter: delimiter || undefined,
        startAfter: startAfter || undefined,
        maxKeys,
        isTruncated: truncated,
        nextToken: token,
        items,
        encodingType: encodingType || undefined,
      });
      return reply.status(200).type('application/xml').send(xml);
    }
    const xml = renderListObjectsV1Xml(bucketName, {
      prefix,
      delimiter: delimiter || undefined,
      marker: marker || undefined,
      maxKeys,
      isTruncated: truncated,
      nextMarker: truncated ? lastConsumed : undefined,
      items,
      encodingType: encodingType || undefined,
    });
    return reply.status(200).type('application/xml').send(xml);
  });

  // 1b. PUT /s3/:bucket (PutBucketLifecycle / PutBucketCors / PutBucketTagging).
  // Bucket-level PUTs only support these three subresources; anything else is
  // InvalidRequest.
  fastify.put('/s3/:bucket', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const query = req.query as Record<string, string>;

    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'The specified bucket does not exist.'));
    }

    const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
    if (!auth.authenticated) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
    }
    const denied = permissionDenied(auth, bucketName, 'write');
    if (denied) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
    }

    const subresource = (['lifecycle', 'cors', 'tagging'] as const).find((s) => query[s] !== undefined);
    if (!subresource) {
      return reply.status(400).type('application/xml').send(
        renderS3ErrorXml('InvalidRequest', 'Bucket-level PUT only supports the lifecycle, cors, and tagging subresources.')
      );
    }

    let body: string;
    try {
      body = await streamToString(bodyAsStream(req.body), MAX_COMPLETE_XML_BYTES);
    } catch {
      return reply.status(413).type('application/xml').send(
        renderS3ErrorXml('EntityTooLarge', 'The bucket configuration body exceeds the 1MB limit.')
      );
    }

    // Content-MD5 is verified against the body when supplied (AWS makes it
    // mandatory here; we accept its absence but never skip a provided one).
    const md5Header = (req.headers['content-md5'] as string | undefined)?.trim();
    if (md5Header) {
      const supplied = Buffer.from(md5Header, 'base64');
      const computed = crypto.createHash('md5').update(body, 'utf8').digest();
      if (
        supplied.length === 0 ||
        supplied.toString('base64') !== md5Header ||
        supplied.length !== computed.length ||
        !crypto.timingSafeEqual(supplied, computed)
      ) {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('BadDigest', 'The Content-MD5 you specified did not match what we received.')
        );
      }
    }

    if (subresource === 'lifecycle') {
      const rules = parseLifecycleXml(body);
      if (!rules) {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.')
        );
      }
      await db.bucket.update({
        where: { id: bucket.id },
        data: { lifecycleRules: serializeLifecycleRules(rules) },
      });
      return reply.status(200).type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`
      );
    }

    if (subresource === 'cors') {
      const rules = parseCorsXml(body);
      if (!rules) {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.')
        );
      }
      await db.bucket.update({
        where: { id: bucket.id },
        data: { corsRules: serializeCorsRules(rules) },
      });
      applyCorsHeaders(reply, bucket, req);
      return reply.status(200).send();
    }

    const tags = parseTaggingXml(body);
    if (!tags) {
      return reply.status(400).type('application/xml').send(
        renderS3ErrorXml('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.')
      );
    }
    await db.bucket.update({
      where: { id: bucket.id },
      data: { tags: serializeTags(tags) },
    });
    applyCorsHeaders(reply, bucket, req);
    return reply.status(200).send();
  });

  // 1c. DELETE /s3/:bucket (DeleteBucketLifecycle / DeleteBucketCors /
  // DeleteBucketTagging).
  fastify.delete('/s3/:bucket', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket: bucketName } = req.params as { bucket: string };
    const query = req.query as Record<string, string>;

    const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
    if (!bucket) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchBucket', 'The specified bucket does not exist.'));
    }

    const auth = await S3Auth.authenticateRequest(req.headers, query, req.method, req.url);
    if (!auth.authenticated) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', auth.error || 'Access Denied'));
    }
    const denied = permissionDenied(auth, bucketName, 'write');
    if (denied) {
      return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
    }

    const subresource = (['lifecycle', 'cors', 'tagging'] as const).find((s) => query[s] !== undefined);
    if (!subresource) {
      return reply.status(400).type('application/xml').send(
        renderS3ErrorXml('InvalidRequest', 'Bucket-level DELETE only supports the lifecycle, cors, and tagging subresources.')
      );
    }

    if (subresource === 'lifecycle') {
      await db.bucket.update({ where: { id: bucket.id }, data: { lifecycleRules: null } });
    } else if (subresource === 'cors') {
      await db.bucket.update({ where: { id: bucket.id }, data: { corsRules: null } });
    } else {
      await db.bucket.update({ where: { id: bucket.id }, data: { tags: null } });
    }
    return reply.status(204).send();
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

    // x-amz-checksum-mode (GET/HEAD) asks for the object's integrity checksum;
    // aws-sdk-v3 sends it with default checksum settings. ENABLED/FULL are
    // accepted; anything else is rejected like AWS (400 InvalidArgument).
    const mode = checksumMode(req.headers as Record<string, unknown>);
    if (mode === 'invalid') {
      return reply.status(400).type('application/xml').send(
        renderS3ErrorXml('InvalidArgument', 'x-amz-checksum-mode only supports ENABLED and FULL.')
      );
    }

    // GetObjectTagging (?tagging): returns the stored tag set as XML (empty
    // TagSet when none) and 404 when the object is missing.
    if (query['tagging'] !== undefined) {
      const tagObj = await db.object.findUnique({ where: { bucketName_key: { bucketName, key } } });
      if (!tagObj) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'The specified key does not exist.'));
      }
      return reply.status(200).type('application/xml').send(renderTaggingXml(deserializeTags(tagObj.tags)));
    }

    // GetObjectAttributes (?attributes): compact object fingerprint used by
    // newer SDKs (aws-sdk-v3's GetObjectAttributesCommand). Only elements with
    // data are emitted; the Checksum block appears only when the caller asks
    // (x-amz-checksum-mode) AND the object has a stored CRC-32.
    if (query['attributes'] !== undefined) {
      const attrObj = await db.object.findUnique({ where: { bucketName_key: { bucketName, key } } });
      if (!attrObj) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'The specified key does not exist.'));
      }
      const attrChecksum =
        mode === 'enabled' && attrObj.checksumCrc32
          ? `\n  <Checksum>\n    <ChecksumCRC32>${attrObj.checksumCrc32}</ChecksumCRC32>\n  </Checksum>`
          : '';
      return reply.status(200).type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<GetObjectAttributesResponse xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <ETag>${attrObj.etag}</ETag>
  <StorageClass>STANDARD</StorageClass>
  <ObjectSize>${attrObj.size}</ObjectSize>
  <LastModified>${attrObj.updatedAt.toISOString()}</LastModified>${attrChecksum}
</GetObjectAttributesResponse>`
      );
    }

    // ListParts: SDKs inspect an in-progress upload's parts before completing.
    // The uploadId must belong to this bucket and key, like S3 (a stray id for
    // another object is NoSuchUpload, not a listing of that object's parts).
    if (query['uploadId'] !== undefined) {
      const upload = await db.multipartUpload.findUnique({ where: { uploadId: query['uploadId'] } });
      if (!upload || upload.bucketName !== bucketName || upload.key !== key) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchUpload', 'The specified upload does not exist.'));
      }
      let marker = parseInt(query['part-number-marker'] || '0', 10);
      if (!Number.isInteger(marker) || marker < 0) marker = 0;
      let maxParts = parseInt(query['max-parts'] || '1000', 10);
      if (!Number.isInteger(maxParts) || maxParts < 0) maxParts = 1000;
      maxParts = Math.min(maxParts, 1000);

      const parts = await db.multipartPart.findMany({
        where: { uploadId: query['uploadId'], partNumber: { gt: marker } },
        orderBy: { partNumber: 'asc' },
      });
      const page = parts.slice(0, maxParts);
      const isTruncated = parts.length > maxParts;
      const partsXml = page
        .map(
          (p) => `
    <Part>
      <PartNumber>${p.partNumber}</PartNumber>
      <LastModified>${p.createdAt.toISOString()}</LastModified>
      <ETag>${p.etag}</ETag>
      <Size>${p.size}</Size>
    </Part>`
        )
        .join('');

      return reply.status(200).type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <UploadId>${escapeXml(upload.uploadId)}</UploadId>
  <StorageClass>STANDARD</StorageClass>
  <PartNumberMarker>${marker}</PartNumberMarker>
  <NextPartNumberMarker>${page.length ? page[page.length - 1].partNumber : 0}</NextPartNumberMarker>
  <MaxParts>${maxParts}</MaxParts>
  <IsTruncated>${isTruncated}</IsTruncated>${partsXml}
</ListPartsResult>`
      );
    }

    const obj = await db.object.findUnique({
      where: { bucketName_key: { bucketName, key } },
    });

    if (!obj) {
      return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'The specified key does not exist.'));
    }

    // Set CORS headers (matched against PutBucketCors rules when configured)
    applyCorsHeaders(reply, bucket, req);
    // SSE-C request headers are validated against the wire protocol and echoed
    // back; the blob's real protection is the server-managed at-rest cipher.
    const ssecGet = validateSseC(req.headers as Record<string, unknown>);
    if (ssecGet.kind === 'error') {
      return reply.status(ssecGet.error.status).type('application/xml').send(renderS3ErrorXml(ssecGet.error.code, ssecGet.error.message));
    }
    applySseCResponseHeaders(reply, ssecGet);
    reply.header('Content-Type', obj.contentType);
    reply.header('ETag', obj.etag);
    // Object metadata (x-amz-meta-*, Content-Disposition/Encoding/Cache-Control)
    // comes back verbatim; the default cache-control applies only when the
    // object doesn't carry its own.
    for (const [h, v] of Object.entries(metadataHeaders(obj.metadata))) {
      reply.header(h, v);
    }
    if (!reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'public, max-age=31536000');
    }
    reply.header('Accept-Ranges', 'bytes');
    // S3 reports the number of tags on a GetObject response.
    const count = tagCount(obj.tags);
    if (count > 0) reply.header('x-amz-tagging-count', String(count));

    // Checksum request honored: report the stored CRC-32 (aws-sdk-v3 verifies
    // integrity against it). Legacy objects without a stored checksum simply
    // omit the headers, like objects S3 never checksummed.
    if (mode === 'enabled' && obj.checksumCrc32) {
      reply.header('x-amz-checksum-crc32', obj.checksumCrc32);
      reply.header('x-amz-checksum-type', 'FULL_OBJECT');
    }

    // Presigned-URL response overrides (response-content-type etc.): clients
    // bake these into the query string of a presigned GET.
    const overrides: Array<[string, string | undefined]> = [
      ['content-type', query['response-content-type']],
      ['content-disposition', query['response-content-disposition']],
      ['content-encoding', query['response-content-encoding']],
      ['content-language', query['response-content-language']],
      ['cache-control', query['response-cache-control']],
      ['expires', query['response-expires']],
    ];
    for (const [header, value] of overrides) {
      if (value !== undefined) reply.header(header, value);
    }

    // Conditional GET: If-Match / If-Unmodified-Since fail with 412;
    // If-None-Match / If-Modified-Since short-circuit with 304 (RFC 7232).
    if (readPreconditionFailed(req.headers as Record<string, unknown>, obj.etag, obj.updatedAt)) {
      return reply.status(412).type('application/xml').send(renderS3ErrorXml('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'));
    }
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

    // PutObjectTagging (?tagging): replace the object's tag set from an XML
    // body. Content-MD5 is verified against the body when supplied (AWS makes
    // it mandatory here; we accept its absence but never skip a provided one).
    if (query['tagging'] !== undefined) {
      const tagObj = await db.object.findUnique({ where: { bucketName_key: { bucketName, key } } });
      if (!tagObj) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'The specified key does not exist.'));
      }
      let body: string;
      try {
        body = await streamToString(bodyAsStream(req.body), MAX_COMPLETE_XML_BYTES);
      } catch {
        return reply.status(413).type('application/xml').send(
          renderS3ErrorXml('EntityTooLarge', 'The PutObjectTagging body exceeds the 1MB limit.')
        );
      }
      const md5Header = (req.headers['content-md5'] as string | undefined)?.trim();
      if (md5Header) {
        const supplied = Buffer.from(md5Header, 'base64');
        const computed = crypto.createHash('md5').update(body, 'utf8').digest();
        if (
          supplied.length === 0 ||
          supplied.toString('base64') !== md5Header ||
          supplied.length !== computed.length ||
          !crypto.timingSafeEqual(supplied, computed)
        ) {
          return reply.status(400).type('application/xml').send(
            renderS3ErrorXml('BadDigest', 'The Content-MD5 you specified did not match what we received.')
          );
        }
      }
      const tags = parseTaggingXml(body);
      if (!tags) {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('InvalidTag', 'The tag provided was not valid, or the tag set contained duplicate or too many tags.')
        );
      }
      await db.object.update({ where: { id: tagObj.id }, data: { tags: serializeTags(tags) } });
      return reply.status(200).type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`
      );
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

      // SSE-C header trios (destination + copy-source) are validated like S3;
      // see ./ssec for the validate-and-echo facade this server uses.
      const destSsec = validateSseC(req.headers as Record<string, unknown>);
      if (destSsec.kind === 'error') {
        return reply.status(destSsec.error.status).type('application/xml').send(renderS3ErrorXml(destSsec.error.code, destSsec.error.message));
      }
      const srcSsec = validateSseC(req.headers as Record<string, unknown>, true);
      if (srcSsec.kind === 'error') {
        return reply.status(srcSsec.error.status).type('application/xml').send(renderS3ErrorXml(srcSsec.error.code, srcSsec.error.message));
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

      // UploadPartCopy — PUT ?uploadId=&partNumber= with an x-amz-copy-source
      // copies the whole source (or an x-amz-copy-source-range slice) into a
      // part of an in-progress upload. This is how SDKs copy large objects
      // without pulling bytes through the client.
      const uploadId = query['uploadId'];
      const partNumber = query['partNumber'] !== undefined ? parseInt(query['partNumber'], 10) : NaN;
      if (uploadId && Number.isInteger(partNumber) && partNumber >= 1) {
        const upload = await db.multipartUpload.findUnique({ where: { uploadId } });
        if (!upload) {
          return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchUpload', 'The specified upload does not exist.'));
        }

        const rangeHeader = req.headers['x-amz-copy-source-range'] as string | undefined;
        let copyStart = 0;
        let copyEnd = srcObj.size - 1;
        if (rangeHeader) {
          const m = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
          if (!m) {
            return reply.status(400).type('application/xml').send(
              renderS3ErrorXml('InvalidArgument', 'The x-amz-copy-source-range header is malformed.')
            );
          }
          const s = parseInt(m[1], 10);
          const e = parseInt(m[2], 10);
          if (s > e || s >= srcObj.size) {
            return reply.status(400).type('application/xml').send(
              renderS3ErrorXml('InvalidRange', 'The specified copy range is not satisfiable.')
            );
          }
          copyStart = s;
          copyEnd = Math.min(e, srcObj.size - 1);
        }
        const copyLength = copyEnd - copyStart + 1;

        // Same part-time quota accounting as UploadPart (parts consume disk
        // before completion; re-copying a part replaces its bytes).
        const existingPart = await db.multipartPart.findUnique({
          where: { uploadId_partNumber: { uploadId, partNumber } },
        });
        const partsSum = (await db.multipartPart.aggregate({ where: { uploadId }, _sum: { size: true } }))._sum.size || 0;
        const addedBytes = partsSum - (existingPart?.size || 0) + copyLength;
        if (addedBytes > 0 && (await wouldExceedQuota(addedBytes))) {
          return reply.status(507).type('application/xml').send(
            renderS3ErrorXml('InsufficientStorage', 'Storage quota exceeded. Delete objects or upgrade your plan to free up space.')
          );
        }

        // The source blob is decrypted on read (magic detection) and the part
        // re-encrypted via savePartFromStream, so the assembled object stays a
        // clean plaintext+encrypt chain.
        let stream: NodeJS.ReadableStream | null;
        if (copyStart === 0 && copyEnd === srcObj.size - 1) {
          stream = await storageEngine.getObjectStream(srcObj.storagePath);
        } else {
          stream = await storageEngine.getObjectStreamRange(srcObj.storagePath, copyStart, copyEnd);
        }
        if (!stream) {
          return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'Object storage file missing'));
        }

        const part = await storageEngine.savePartFromStream(uploadId, partNumber, stream);
        await db.multipartPart.upsert({
          where: { uploadId_partNumber: { uploadId, partNumber } },
          create: { uploadId, partNumber, etag: part.etag, size: part.size, storagePath: part.storagePath },
          update: { etag: part.etag, size: part.size, storagePath: part.storagePath, createdAt: new Date() },
        });

        applyCorsHeaders(reply, bucket, req);
        reply.header('Access-Control-Expose-Headers', 'ETag');
        applySseCResponseHeaders(reply, destSsec);
        return reply.status(200).type('application/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?>
<CopyPartResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <ETag>${part.etag}</ETag>
  <LastModified>${new Date().toISOString()}</LastModified>
</CopyPartResult>`
        );
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
      // COPY inherits the source's metadata blob; REPLACE re-derives it from
      // the request's headers (making the directive meaningful beyond Content-Type).
      const destMetadata =
        directive === 'REPLACE'
          ? serializeMetadata(extractMetadataFromHeaders(req.headers as Record<string, unknown>))
          : srcObj.metadata;
      // Tags follow the same COPY/REPLACE semantics via x-amz-tagging-directive.
      const tagDirective = (req.headers['x-amz-tagging-directive'] as string || 'COPY').trim().toUpperCase();
      let destTags: string | null;
      if (tagDirective === 'REPLACE') {
        const header = req.headers['x-amz-tagging'] as string | undefined;
        if (header !== undefined) {
          const parsed = parseTaggingHeader(header);
          if (!parsed) {
            return reply.status(400).type('application/xml').send(
              renderS3ErrorXml('InvalidTag', 'The tag provided was not valid, or the tag set contained duplicate or too many tags.')
            );
          }
          destTags = serializeTags(parsed);
        } else {
          destTags = null;
        }
      } else {
        destTags = srcObj.tags;
      }
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
          metadata: destMetadata,
          tags: destTags,
          checksumCrc32: srcObj.checksumCrc32,
        },
        update: {
          size: srcObj.size,
          contentType: destContentType,
          etag: srcObj.etag,
          storagePath,
          metadata: destMetadata,
          tags: destTags,
          checksumCrc32: srcObj.checksumCrc32,
          updatedAt: new Date(),
        },
      });

      applyCorsHeaders(reply, bucket, req);
      reply.header('Access-Control-Expose-Headers', 'ETag');
      applySseCResponseHeaders(reply, destSsec);
      return reply.status(200).type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <ETag>${srcObj.etag}</ETag>
  <LastModified>${new Date().toISOString()}</LastModified>
</CopyObjectResult>`
      );
    }

    const contentType = (req.headers['content-type'] as string) || mime.lookup(key) || 'application/octet-stream';

    // SSE-C on plain PUTs / UploadPart: validated once for both paths below.
    const ssec = validateSseC(req.headers as Record<string, unknown>);
    if (ssec.kind === 'error') {
      return reply.status(ssec.error.status).type('application/xml').send(renderS3ErrorXml(ssec.error.code, ssec.error.message));
    }

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

    // Content-MD5 integrity check on the part, same as PutObject.
    const md5Error = contentMd5Mismatch(req.headers as Record<string, unknown>, part.etag);
    if (md5Error) {
      await storageEngine.deleteObjectFile(part.storagePath);
      return reply.status(400).type('application/xml').send(md5Error);
    }
    // Same for the CRC-32 checksum header aws-sdk-v3 sends on part uploads.
    const crcError = checksumCrc32Mismatch(req.headers as Record<string, unknown>, part.crc32);
    if (crcError) {
      await storageEngine.deleteObjectFile(part.storagePath);
      return reply.status(400).type('application/xml').send(crcError);
    }

      await db.multipartPart.upsert({
        where: { uploadId_partNumber: { uploadId, partNumber } },
        create: { uploadId, partNumber, etag: part.etag, size: part.size, storagePath: part.storagePath },
        update: { etag: part.etag, size: part.size, storagePath: part.storagePath, createdAt: new Date() },
      });

      applyCorsHeaders(reply, bucket, req);
      applySseCResponseHeaders(reply, ssec);
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

    const { size, etag, storagePath, crc32 } = await storageEngine.saveObjectFromStream(bucketName, key, bodyAsStream(req.body));

    // Content-MD5 integrity check: the ETag is the md5 of the payload, so a
    // mismatching header means corrupted (or tampered) bytes in flight — reject
    // and clean up the freshly written blob.
    const md5Error = contentMd5Mismatch(req.headers as Record<string, unknown>, etag);
    if (md5Error) {
      await storageEngine.deleteObjectFile(storagePath);
      return reply.status(400).type('application/xml').send(md5Error);
    }
    // aws-sdk-v3 sends x-amz-checksum-crc32 (base64 CRC-32) on every PutObject
    // by default since 2024; verify it the same way and store it so GET with
    // x-amz-checksum-mode can return it.
    const crcError = checksumCrc32Mismatch(req.headers as Record<string, unknown>, crc32);
    if (crcError) {
      await storageEngine.deleteObjectFile(storagePath);
      return reply.status(400).type('application/xml').send(crcError);
    }

    // x-amz-tagging stores tags alongside the object on PUT.
    const tagHeader = req.headers['x-amz-tagging'] as string | undefined;
    let storedTags: string | null = null;
    if (tagHeader !== undefined) {
      const parsed = parseTaggingHeader(tagHeader);
      if (!parsed) {
        await storageEngine.deleteObjectFile(storagePath);
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('InvalidTag', 'The tag provided was not valid, or the tag set contained duplicate or too many tags.')
        );
      }
      storedTags = serializeTags(parsed);
    }

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
        metadata: serializeMetadata(extractMetadataFromHeaders(req.headers as Record<string, unknown>)),
        tags: storedTags,
        checksumCrc32: crc32,
      },
      update: {
        size,
        contentType,
        etag,
        storagePath,
        metadata: serializeMetadata(extractMetadataFromHeaders(req.headers as Record<string, unknown>)),
        tags: storedTags,
        checksumCrc32: crc32,
        updatedAt: new Date(),
      },
    });

    applyCorsHeaders(reply, bucket, req);
    applySseCResponseHeaders(reply, ssec);
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

    // DeleteObjectTagging (?tagging): clears the tag set, keeping the object.
    if (query['tagging'] !== undefined) {
      const denied = permissionDenied(auth, bucketName, 'full');
      if (denied) {
        return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessDenied', denied));
      }
      const tagObj = await db.object.findUnique({ where: { bucketName_key: { bucketName, key } } });
      if (!tagObj) {
        return reply.status(404).type('application/xml').send(renderS3ErrorXml('NoSuchKey', 'The specified key does not exist.'));
      }
      await db.object.update({ where: { id: tagObj.id }, data: { tags: null } });
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
      const tagHeader = req.headers['x-amz-tagging'] as string | undefined;
      const tags = tagHeader !== undefined ? parseTaggingHeader(tagHeader) : undefined;
      if (tagHeader !== undefined && !tags) {
        return reply.status(400).type('application/xml').send(
          renderS3ErrorXml('InvalidTag', 'The tag provided was not valid, or the tag set contained duplicate or too many tags.')
        );
      }
      const ssec = validateSseC(req.headers as Record<string, unknown>);
      if (ssec.kind === 'error') {
        return reply.status(ssec.error.status).type('application/xml').send(renderS3ErrorXml(ssec.error.code, ssec.error.message));
      }
      await db.multipartUpload.create({
        data: {
          bucketName,
          key,
          uploadId,
          contentType,
          metadata: serializeMetadata(extractMetadataFromHeaders(req.headers as Record<string, unknown>)),
          tags: tags ? serializeTags(tags) : null,
        },
      });
      applySseCResponseHeaders(reply, ssec);
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

    const { size, etag, storagePath, crc32 } = await storageEngine.assembleUpload(bucketName, key, partsToUse);

    await db.object.upsert({
      where: { bucketName_key: { bucketName, key } },
      create: {
        bucketName,
        key,
        size,
        contentType: upload.contentType,
        etag,
        storagePath,
        metadata: upload.metadata,
        tags: upload.tags,
        checksumCrc32: crc32,
      },
      update: {
        size,
        contentType: upload.contentType,
        etag,
        storagePath,
        metadata: upload.metadata,
        tags: upload.tags,
        checksumCrc32: crc32,
        updatedAt: new Date(),
      },
    });

    await db.multipartUpload.delete({ where: { uploadId } });
    await storageEngine.deleteUploadParts(uploadId);

    return reply.status(200).type('application/xml').send(renderMultipartCompleteXml(bucketName, key, etag, crc32));
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

    applyCorsHeaders(reply, bucket, req);
    return reply.status(200).type('application/xml').send(xml);
  });

  // 5. OPTIONS /s3/:bucket and /s3/:bucket/* — CORS preflight for browser
  // clients (e.g. presigned PUT uploads from the browser-upload example).
  // Answered purely from the bucket's CORS rules with no auth: the browser
  // cannot sign a preflight, and the follow-up request carries credentials.
  // A disallowed origin gets 403 AccessForbidden, like S3.
  fastify.options('/s3/:bucket/*', preflightHandler);
  fastify.options('/s3/:bucket', preflightHandler);
}

async function preflightHandler(req: FastifyRequest, reply: FastifyReply) {
  const { bucket: bucketName } = req.params as { bucket: string };
  const bucket = await db.bucket.findUnique({ where: { name: bucketName } });
  if (!bucket) return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessForbidden', 'CORS is not enabled for this bucket.'));

  const rules = deserializeCorsRules(bucket.corsRules);
  const origin = (req.headers.origin as string | undefined) || '';
  const requestMethod = (req.headers['access-control-request-method'] as string | undefined) || '';
  const requestHeaders = ((req.headers['access-control-request-headers'] as string | undefined) || '')
    .split(/,\s*/)
    .filter(Boolean);
  const headers = corsHeadersForRequest(rules, origin, { preflight: true, requestMethod, requestHeaders });
  if (Object.keys(headers).length === 0) {
    return reply.status(403).type('application/xml').send(renderS3ErrorXml('AccessForbidden', 'CORS is not enabled for this origin.'));
  }
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
  return reply.status(200).send();
}

// Shared listing body: Contents entries + CommonPrefixes. `enc` applies the
// requested encoding (plain XML-escape, or URL-encode then escape for
// encoding-type=url).
function renderListItems(
  items: Array<{ kind: 'content'; obj: any } | { kind: 'prefix'; prefix: string }>,
  enc: (v: string) => string,
): string {
  const contents = items
    .filter((i): i is { kind: 'content'; obj: any } => i.kind === 'content')
    .map(
      (i) => `
    <Contents>
      <Key>${enc(i.obj.key)}</Key>
      <LastModified>${i.obj.updatedAt.toISOString()}</LastModified>
      <ETag>${i.obj.etag}</ETag>
      <Size>${i.obj.size}</Size>
      <StorageClass>STANDARD</StorageClass>
    </Contents>`
    )
    .join('');
  const commonPrefixes = items
    .filter((i): i is { kind: 'prefix'; prefix: string } => i.kind === 'prefix')
    .map((i) => `  <CommonPrefixes>\n    <Prefix>${enc(i.prefix)}</Prefix>\n  </CommonPrefixes>`)
    .join('\n');
  return `${contents}${contents && commonPrefixes ? '\n' : ''}${commonPrefixes}`;
}

function renderListObjectsV1Xml(
  bucketName: string,
  opts: {
    prefix: string;
    delimiter?: string;
    marker?: string;
    maxKeys: number;
    isTruncated: boolean;
    nextMarker?: string;
    items: Array<{ kind: 'content'; obj: any } | { kind: 'prefix'; prefix: string }>;
    encodingType?: string;
  }
): string {
  const enc = (v: string) => (opts.encodingType ? escapeXml(encodeURIComponent(v)) : escapeXml(v));
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${enc(opts.prefix)}</Prefix>
  ${opts.marker ? `<Marker>${enc(opts.marker)}</Marker>` : ''}
  ${opts.delimiter ? `<Delimiter>${enc(opts.delimiter)}</Delimiter>` : ''}
  <MaxKeys>${opts.maxKeys}</MaxKeys>
  <IsTruncated>${opts.isTruncated}</IsTruncated>
  ${opts.encodingType ? `<EncodingType>${escapeXml(opts.encodingType)}</EncodingType>` : ''}
  ${opts.isTruncated && opts.nextMarker !== undefined ? `<NextMarker>${enc(opts.nextMarker)}</NextMarker>` : ''}${renderListItems(opts.items, enc)}
</ListBucketResult>`;
}

function renderListObjectsV2Xml(
  bucketName: string,
  opts: {
    prefix: string;
    delimiter?: string;
    startAfter?: string;
    maxKeys: number;
    isTruncated: boolean;
    nextToken?: string;
    items: Array<{ kind: 'content'; obj: any } | { kind: 'prefix'; prefix: string }>;
    encodingType?: string;
  }
): string {
  const enc = (v: string) => (opts.encodingType ? escapeXml(encodeURIComponent(v)) : escapeXml(v));
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${enc(opts.prefix)}</Prefix>
  ${opts.delimiter ? `<Delimiter>${enc(opts.delimiter)}</Delimiter>` : ''}
  ${opts.startAfter ? `<StartAfter>${enc(opts.startAfter)}</StartAfter>` : ''}
  <KeyCount>${opts.items.length}</KeyCount>
  <MaxKeys>${opts.maxKeys}</MaxKeys>
  <IsTruncated>${opts.isTruncated}</IsTruncated>
  ${opts.encodingType ? `<EncodingType>${escapeXml(opts.encodingType)}</EncodingType>` : ''}
  ${opts.nextToken ? `<NextContinuationToken>${escapeXml(opts.nextToken)}</NextContinuationToken>` : ''}${renderListItems(opts.items, enc)}
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
