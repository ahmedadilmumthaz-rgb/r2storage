// S3 object metadata: user metadata (x-amz-meta-*) plus the system headers
// Content-Disposition / Content-Encoding / Cache-Control. Stored as a JSON
// string in the Object.metadata / MultipartUpload.metadata column:
//   { user?: {...}, contentDisposition?, contentEncoding?, cacheControl? }
// Emitted back verbatim on GET/HEAD. Keys are lowercased like S3 does.

export interface ObjectMetadata {
  user?: Record<string, string>;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
}

type StringMetadataField = 'contentDisposition' | 'contentEncoding' | 'cacheControl';

const SYSTEM_HEADERS: Array<[StringMetadataField, string]> = [
  ['contentDisposition', 'content-disposition'],
  ['contentEncoding', 'content-encoding'],
  ['cacheControl', 'cache-control'],
];

export function extractMetadataFromHeaders(headers: Record<string, unknown>): ObjectMetadata {
  const user: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith('x-amz-meta-') && typeof value === 'string' && value) {
      user[name.slice('x-amz-meta-'.length).toLowerCase()] = value;
    }
  }
  const out: ObjectMetadata = {};
  if (Object.keys(user).length) out.user = user;
  for (const [field, header] of SYSTEM_HEADERS) {
    const v = headers[header];
    if (typeof v === 'string' && v) out[field] = v;
  }
  return out;
}

export function serializeMetadata(m: ObjectMetadata): string | null {
  const out: ObjectMetadata = {};
  if (m.user && Object.keys(m.user).length) out.user = m.user;
  if (m.contentDisposition) out.contentDisposition = m.contentDisposition;
  if (m.contentEncoding) out.contentEncoding = m.contentEncoding;
  if (m.cacheControl) out.cacheControl = m.cacheControl;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

export function deserializeMetadata(raw: string | null | undefined): ObjectMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ObjectMetadata;
  } catch {
    return {};
  }
}

/** Header name/value pairs to emit on GET/HEAD from a stored metadata blob. */
export function metadataHeaders(raw: string | null | undefined): Record<string, string> {
  const m = deserializeMetadata(raw);
  const out: Record<string, string> = {};
  if (m.contentDisposition) out['content-disposition'] = m.contentDisposition;
  if (m.contentEncoding) out['content-encoding'] = m.contentEncoding;
  if (m.cacheControl) out['cache-control'] = m.cacheControl;
  for (const [k, v] of Object.entries(m.user || {})) out[`x-amz-meta-${k}`] = v;
  return out;
}
