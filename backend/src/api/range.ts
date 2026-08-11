// S3-compatible byte-range and conditional-GET semantics, shared by the S3
// route (/api/s3.ts) and the custom-domain public route (/api/public.ts).
// AWS serves a single `bytes=` range only; anything else falls back to a full
// 200 response rather than multipart/byteranges.

export interface RangeSpec {
  kind: 'full' | 'partial' | 'invalid';
  start?: number;
  end?: number;
  length?: number;
}

export function parseRangeHeader(range: string | undefined, size: number): RangeSpec {
  if (!range) return { kind: 'full' };
  // Only a single `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range is
  // honored. Malformed or multi-range requests fall through to the full object.
  const m = /^\s*bytes=(\d*)-(\d*)\s*$/.exec(range);
  if (!m) return { kind: 'full' };
  const [, startStr, endStr] = m;

  if (startStr === '') {
    // Suffix range: the last N bytes.
    if (endStr === '') return { kind: 'full' }; // `bytes=-`
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0 || size <= 0) return { kind: 'invalid' };
    const length = Math.min(suffix, size);
    return { kind: 'partial', start: size - length, end: size - 1, length };
  }

  const start = parseInt(startStr, 10);
  if (!Number.isFinite(start) || start < 0) return { kind: 'full' };
  const end = endStr === '' ? size - 1 : Math.min(parseInt(endStr, 10), size - 1);
  if (!Number.isFinite(end) || start >= size || start > end) return { kind: 'invalid' };
  return { kind: 'partial', start, end, length: end - start + 1 };
}

// RFC 7232 §3.2/§3.3 evaluation. If-None-Match takes precedence over
// If-Modified-Since when both are present. Last-modified is compared with
// second granularity, matching how S3 truncates the Last-Modified header.
export function notModified(
  headers: Record<string, unknown>,
  etag: string,
  lastModified: Date,
): boolean {
  const inm = headers['if-none-match'];
  if (typeof inm === 'string' && inm) {
    const normalized = (tag: string) => tag.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
    const et = normalized(etag);
    return inm
      .split(',')
      .some((tag) => tag.trim() === '*' || normalized(tag) === et);
  }
  const ims = headers['if-modified-since'];
  if (typeof ims === 'string' && ims) {
    const since = Date.parse(ims);
    if (Number.isNaN(since)) return false;
    return Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000);
  }
  return false;
}

// Read-side 412 evaluation (RFC 7232 §3.1): If-Match / If-Unmodified-Since on
// GET/HEAD. If-Match takes precedence over If-Unmodified-Since, mirroring the
// write-side semantics in checkWritePreconditions.
export function readPreconditionFailed(
  headers: Record<string, unknown>,
  etag: string,
  lastModified: Date,
): boolean {
  const normalized = (tag: string) => tag.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  const ifMatch = headers['if-match'];
  if (typeof ifMatch === 'string' && ifMatch) {
    if (ifMatch.trim() === '*') return false;
    const et = normalized(etag);
    return !ifMatch.split(',').some((tag) => normalized(tag) === et);
  }
  const ifUnmodified = headers['if-unmodified-since'];
  if (typeof ifUnmodified === 'string' && ifUnmodified) {
    const since = Date.parse(ifUnmodified);
    if (Number.isNaN(since)) return false;
    return Math.floor(lastModified.getTime() / 1000) > Math.floor(since / 1000);
  }
  return false;
}

// Write-precondition evaluation (conditional writes). Mirrors S3's PutObject
// semantics: If-Match and If-Unmodified-Since fail with 412 PreconditionFailed
// when the current object doesn't match, and If-None-Match: * fails with
// 409 Conflict (ConditionalRequestConflict) when the object already exists.
// If-Match takes precedence over If-Unmodified-Since (RFC 7232 §3.4).
export type WritePrecondition = 'ok' | 'precondition-failed' | 'conflict';

export function checkWritePreconditions(
  headers: Record<string, unknown>,
  existing: { etag: string; updatedAt: Date } | null,
): WritePrecondition {
  const normalized = (tag: string) => tag.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');

  const ifMatch = headers['if-match'];
  if (typeof ifMatch === 'string' && ifMatch) {
    if (!existing) return 'precondition-failed';
    if (ifMatch.trim() === '*') return 'ok';
    const et = normalized(existing.etag);
    return ifMatch.split(',').some((tag) => normalized(tag) === et) ? 'ok' : 'precondition-failed';
  }

  const ifUnmodified = headers['if-unmodified-since'];
  if (typeof ifUnmodified === 'string' && ifUnmodified) {
    const since = Date.parse(ifUnmodified);
    if (Number.isNaN(since)) return 'ok';
    if (!existing) return 'ok'; // a brand-new key is trivially unmodified
    const modified = Math.floor(existing.updatedAt.getTime() / 1000);
    return modified <= Math.floor(since / 1000) ? 'ok' : 'precondition-failed';
  }

  const ifNoneMatch = headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch) {
    const tag = ifNoneMatch.trim();
    if (tag === '*' && existing) return 'conflict';
    // S3 only honors the bare `*` form on writes; a specific tag isn't
    // supported, so treat any other value as unsatisfiable if it matches.
    if (tag !== '*' && existing && normalized(tag) === normalized(existing.etag)) return 'conflict';
  }

  return 'ok';
}
