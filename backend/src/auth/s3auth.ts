import crypto from 'crypto';
import { db } from '../db';
import { secretsEqual } from './secrets';

export interface AuthResult {
  authenticated: boolean;
  accessKeyId?: string;
  permission?: string;
  bucketFilter?: string | null;
  error?: string;
  // Set when the request was authorized by a SigV4 Authorization header whose
  // payload hash is STREAMING-AWS4-HMAC-SHA256-PAYLOAD (or STREAMING-UNSIGNED-
  // PAYLOAD): the derived signing key, scope and seed signature the body's
  // aws-chunked decoder needs to verify each chunk as it is consumed.
  streaming?: { signingKey: Buffer; amzDate: string; scopeStr: string; seedSignature: string };
}

const REGION = 'us-east-1';
const SERVICE = 's3';
const TERMINATOR = 'aws4_request';

// Max allowed clock drift between the client and server. AWS enforces the same
// 15-minute window so that a captured signed request cannot be replayed for the
// rest of the day (signatures otherwise stay valid until the credential scope's
// date rolls over).
const REQUEST_SKEW_MS = 15 * 60 * 1000;

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hmac(key: Buffer | string, input: string): Buffer {
  return crypto.createHmac('sha256', key).update(input).digest();
}

function signingKey(secret: string, dateStamp: string): Buffer {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, TERMINATOR);
}

function signaturesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// RFC 3986 URI encoding per AWS SigV4 rules
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Canonical URI: the transmitted path IS the canonical form (clients sign the exact
// URL-encoded path they send). No re-encoding, to avoid double-encoding mismatches.
function canonicalUri(rawPath: string): string {
  return rawPath;
}

// Canonical URI candidates accepted when verifying a signature. Our S3 surface
// is /s3/<bucket>/<key>, which is the form admin-generated presigned URLs sign.
// AWS SDKs pointed at this endpoint sign as if it were S3, producing path-style
// canonical URIs of /<bucket>/<key> — they can't know about the /s3 prefix —
// so accept that form too. The signature must still verify over the exact form,
// so this adds compatibility without loosening authentication.
function canonicalUriCandidates(rawPath: string): string[] {
  if (rawPath.startsWith('/s3/')) {
    return [rawPath, rawPath.slice(3)];
  }
  return [rawPath];
}

// Canonical query string: preserve the transmitted (already-encoded) pairs, sorted by name then value
function canonicalQueryString(rawQuery: string): string {
  if (!rawQuery) return '';
  const pairs: Array<[string, string]> = [];
  for (const rawPair of rawQuery.split('&')) {
    if (!rawPair) continue;
    const eq = rawPair.indexOf('=');
    const name = eq === -1 ? rawPair : rawPair.slice(0, eq);
    const value = eq === -1 ? '' : rawPair.slice(eq + 1);
    pairs.push([name, value]);
  }
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  return pairs.map(([n, v]) => `${n}=${v}`).join('&');
}

function buildCanonicalHeaders(headers: Record<string, string | string[] | undefined>, signedHeaders: string[]): string {
  const sorted = [...signedHeaders].sort();
  return sorted
    .map((name) => {
      const value = headers[name] ?? headers[name.toLowerCase()] ?? '';
      const trimmed = String(value)
        .trim()
        .replace(/\s{2,}/g, ' ');
      return `${name}:${trimmed}\n`;
    })
    .join('');
}

function parseAmzDate(amzDateStr: string): number {
  try {
    const year = parseInt(amzDateStr.slice(0, 4), 10);
    const month = parseInt(amzDateStr.slice(4, 6), 10) - 1;
    const day = parseInt(amzDateStr.slice(6, 8), 10);
    const hour = parseInt(amzDateStr.slice(9, 11), 10) || 0;
    const min = parseInt(amzDateStr.slice(11, 13), 10) || 0;
    const sec = parseInt(amzDateStr.slice(13, 15), 10) || 0;
    return Date.UTC(year, month, day, hour, min, sec);
  } catch {
    return NaN;
  }
}

function formatDateHeaderToAmz(value: string): string {
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return '';
  return parsed.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function parseCredentialScope(credential: string): { accessKeyId: string; dateStamp: string; region: string; service: string } | null {
  const parts = credential.split('/');
  if (parts.length !== 5) return null;
  const [accessKeyId, dateStamp, region, service] = parts;
  if (service !== SERVICE) return null;
  return { accessKeyId, dateStamp, region, service };
}

function successfulAuth(
  keyRecord: { accessKeyId: string; permission: string; bucketFilter: string | null },
  streaming?: AuthResult['streaming']
): AuthResult {
  return {
    authenticated: true,
    accessKeyId: keyRecord.accessKeyId,
    permission: keyRecord.permission,
    bucketFilter: keyRecord.bucketFilter,
    ...(streaming ? { streaming } : {}),
  };
}

export class S3Auth {
  /**
   * Validates presigned URL tokens or HMAC SigV4 authorization headers.
   */
  static async authenticateRequest(
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string | string[] | undefined>,
    method: string,
    path: string
  ): Promise<AuthResult> {
    const queryIdx = path.indexOf('?');
    const rawPath = queryIdx === -1 ? path : path.slice(0, queryIdx);
    const rawQuery = queryIdx === -1 ? '' : path.slice(queryIdx + 1);

    // 1. Presigned URL (X-Amz-* query params)
    const presignedResult = await S3Auth.verifyPresignedSignature(headers, query, method, rawPath, rawQuery);
    if (presignedResult) return presignedResult;

    // 2. SigV4 Authorization header
    const headerResult = await S3Auth.verifyHeaderSignature(headers, method, rawPath, rawQuery);
    if (headerResult) return headerResult;

    // 3. Convenience headers for simple tools. Both credentials are required:
    //    - x-api-key: <secretAccessKey>   (looked up by secret; full access)
    //    - x-access-key-id: <accessKeyId> + x-access-key-secret: <secretAccessKey>
    //    An Access Key ID alone is NOT a credential (it appears in presigned
    //    URLs and dashboards), so a bare x-access-key-id is rejected.
    const apiKeyId = headers['x-access-key-id'] as string | undefined;
    const apiKeySecret = (headers['x-access-key-secret'] || headers['x-api-key']) as string | undefined;
    if (apiKeyId && apiKeySecret) {
      const keyRecord = await db.accessKey.findUnique({ where: { accessKeyId: apiKeyId } });
      if (keyRecord && secretsEqual(apiKeySecret, keyRecord.secretAccessKey)) return successfulAuth(keyRecord);
      return { authenticated: false, error: 'Invalid access key credentials' };
    }
    if (!apiKeyId && apiKeySecret) {
      const keyRecord = await db.accessKey.findFirst({ where: { secretAccessKey: apiKeySecret } });
      if (keyRecord) return successfulAuth(keyRecord);
      return { authenticated: false, error: 'Invalid access key credentials' };
    }

    return { authenticated: false, error: 'Missing or invalid authentication credentials' };
  }

  private static async verifyPresignedSignature(
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string | string[] | undefined>,
    method: string,
    rawPath: string,
    rawQuery: string
  ): Promise<AuthResult | null> {
    const amzCred = query['X-Amz-Credential'] as string | undefined;
    const amzSig = query['X-Amz-Signature'] as string | undefined;
    if (!amzCred || !amzSig) return null;

    const scope = parseCredentialScope(amzCred);
    if (!scope) return { authenticated: false, error: 'Malformed credential scope' };

    const keyRecord = await db.accessKey.findUnique({ where: { accessKeyId: scope.accessKeyId } });
    if (!keyRecord) return { authenticated: false, error: 'Invalid Access Key ID' };

    // Verify expiration. X-Amz-Date is the issue time, so it must not be too
    // far in the future (prevents minting long-lived URLs with a forged date)
    // and the URL must not have passed its expiry.
    const amzExpires = query['X-Amz-Expires'] as string | undefined;
    const amzDate = query['X-Amz-Date'] as string | undefined;
    if (amzExpires && amzDate) {
      const reqTime = parseAmzDate(amzDate);
      const expiresSeconds = parseInt(amzExpires, 10);
      if (isNaN(reqTime) || reqTime - Date.now() > REQUEST_SKEW_MS || Date.now() > reqTime + expiresSeconds * 1000) {
        return { authenticated: false, error: 'Presigned URL has expired' };
      }
    }

    const signedQuery = rawQuery
      .split('&')
      .filter((pair) => pair && !pair.startsWith('X-Amz-Signature='))
      .join('&');

    const host = (headers['host'] as string) || '';
    const scopeStr = `${scope.dateStamp}/${scope.region}/${SERVICE}/${TERMINATOR}`;
    const key = signingKey(keyRecord.secretAccessKey, scope.dateStamp);
    for (const uri of canonicalUriCandidates(rawPath)) {
      const canonicalRequest = [
        method,
        uri,
        canonicalQueryString(signedQuery),
        `host:${host}\n`,
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scopeStr}\n${sha256Hex(canonicalRequest)}`;
      if (signaturesMatch(hmac(key, stringToSign).toString('hex'), amzSig)) {
        return successfulAuth(keyRecord);
      }
    }

    return { authenticated: false, error: 'Signature mismatch' };
  }

  private static async verifyHeaderSignature(
    headers: Record<string, string | string[] | undefined>,
    method: string,
    rawPath: string,
    rawQuery: string
  ): Promise<AuthResult | null> {
    const authHeader = (headers['authorization'] || headers['Authorization']) as string | undefined;
    if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256')) return null;

    const credMatch = authHeader.match(/Credential=([^,\s]+)/);
    const signedMatch = authHeader.match(/SignedHeaders=([^,\s]+)/);
    const sigMatch = authHeader.match(/Signature=([0-9a-f]+)/i);
    if (!credMatch || !signedMatch || !sigMatch) {
      return { authenticated: false, error: 'Malformed Authorization header' };
    }

    const scope = parseCredentialScope(credMatch[1]);
    if (!scope) return { authenticated: false, error: 'Malformed credential scope' };

    const keyRecord = await db.accessKey.findUnique({ where: { accessKeyId: scope.accessKeyId } });
    if (!keyRecord) return { authenticated: false, error: 'Invalid Access Key ID' };

    const signedHeaders = signedMatch[1].split(';').map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!signedHeaders.includes('host')) {
      return { authenticated: false, error: 'Host header must be signed' };
    }

    const amzDate = (headers['x-amz-date'] as string) || formatDateHeaderToAmz((headers['date'] as string) || '');
    if (!amzDate) {
      return { authenticated: false, error: 'Missing request timestamp (x-amz-date)' };
    }

    // Replay protection: reject timestamps outside a 15-minute skew window.
    const reqTime = parseAmzDate(amzDate);
    if (isNaN(reqTime) || Math.abs(Date.now() - reqTime) > REQUEST_SKEW_MS) {
      return { authenticated: false, error: 'Request timestamp is not recent enough (x-amz-date skew)' };
    }

    const canonicalHeaders = buildCanonicalHeaders(headers, signedHeaders);
    const payloadHash = (headers['x-amz-content-sha256'] as string) || 'UNSIGNED-PAYLOAD';
    const scopeStr = `${scope.dateStamp}/${scope.region}/${SERVICE}/${TERMINATOR}`;
    const key = signingKey(keyRecord.secretAccessKey, scope.dateStamp);
    for (const uri of canonicalUriCandidates(rawPath)) {
      const canonicalRequest = [
        method,
        uri,
        canonicalQueryString(rawQuery),
        canonicalHeaders,
        signedHeaders.join(';'),
        payloadHash,
      ].join('\n');
      const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scopeStr}\n${sha256Hex(canonicalRequest)}`;
      if (signaturesMatch(hmac(key, stringToSign).toString('hex'), sigMatch[1])) {
        return successfulAuth(
          keyRecord,
          payloadHash.startsWith('STREAMING-') ? { signingKey: key, amzDate, scopeStr, seedSignature: sigMatch[1] } : undefined
        );
      }
    }

    return { authenticated: false, error: 'Signature mismatch' };
  }

  /**
   * Generate a SigV4 presigned URL for an object.
   */
  static generatePresignedUrl(
    baseUrl: string,
    bucketName: string,
    key: string,
    accessKeyId: string,
    secretKey: string,
    expiresInSeconds: number = 3600
  ): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scopeStr = `${dateStamp}/${REGION}/${SERVICE}/${TERMINATOR}`;
    const credential = `${accessKeyId}/${scopeStr}`;

    const keySegments = [bucketName, ...key.split('/')];
    const s3Path = '/s3/' + keySegments.map((seg) => uriEncode(seg)).join('/');

    const queryParams: Array<[string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', credential],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', expiresInSeconds.toString()],
      ['X-Amz-SignedHeaders', 'host'],
    ];

    // Canonical query: URI-encode each name/value, sorted (all X-Amz- names sort naturally)
    const canonicalQuery = queryParams
      .map(([n, v]) => `${uriEncode(n)}${v ? '=' + uriEncode(v) : ''}`)
      .sort()
      .join('&');

    const host = new URL(baseUrl).host;
    const canonicalRequest = [
      'GET',
      canonicalUri(s3Path),
      canonicalQuery,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scopeStr}\n${sha256Hex(canonicalRequest)}`;
    const signature = hmac(signingKey(secretKey, dateStamp), stringToSign).toString('hex');

    return `${baseUrl}${s3Path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }
}
