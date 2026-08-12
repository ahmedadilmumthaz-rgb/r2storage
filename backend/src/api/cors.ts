// S3 bucket-CORS helpers. Rules are stored as a JSON array on the Bucket row
// and travel as <CORSConfiguration><CORSRule>… XML (the ?cors subresource).
// Parsed via regex only — same no-XML-parser policy as the rest of the API
// (no XXE surface). Serving: the request's Origin is matched against a rule's
// AllowedOrigins; preflight OPTIONS additionally requires the requested method,
// and replies with Allow-Methods / Allow-Headers / Max-Age.

const MAX_RULES = 100;
const VALID_METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'];
const MAX_AGE_CAP_SEC = 86400;

export type CorsRule = {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number;
};

// Parse a PutBucketCors body. Returns null when the XML is malformed (no
// CORSRule, a rule missing AllowedOrigin/AllowedMethod, an unknown method, or
// too many rules). An empty <CORSConfiguration/> is rejected like AWS.
export function parseCorsXml(xml: string): CorsRule[] | null {
  const blocks = [...xml.matchAll(/<CORSRule>([\s\S]*?)<\/CORSRule>/g)];
  if (blocks.length === 0 || blocks.length > MAX_RULES) return null;
  const rules: CorsRule[] = [];
  for (const [, block] of blocks) {
    const origins = [...block.matchAll(/<AllowedOrigin>([^<]*)<\/AllowedOrigin>/g)].map((m) => m[1]);
    const methods = [...block.matchAll(/<AllowedMethod>([^<]*)<\/AllowedMethod>/g)].map((m) => m[1]);
    if (origins.length === 0 || methods.length === 0) return null;
    if (!methods.every((m) => VALID_METHODS.includes(m))) return null;
    const headers = [...block.matchAll(/<AllowedHeader>([^<]*)<\/AllowedHeader>/g)].map((m) => m[1]);
    const expose = [...block.matchAll(/<ExposeHeader>([^<]*)<\/ExposeHeader>/g)].map((m) => m[1]);
    const maxAgeMatch = block.match(/<MaxAgeSeconds>(\d+)<\/MaxAgeSeconds>/);
    let maxAgeSeconds = 0;
    if (maxAgeMatch) {
      maxAgeSeconds = parseInt(maxAgeMatch[1], 10);
      if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) return null;
      maxAgeSeconds = Math.min(maxAgeSeconds, MAX_AGE_CAP_SEC);
    }
    rules.push({ allowedOrigins: origins, allowedMethods: methods, allowedHeaders: headers, exposeHeaders: expose, maxAgeSeconds });
  }
  return rules;
}

export function serializeCorsRules(rules: CorsRule[]): string {
  return JSON.stringify(rules);
}

export function deserializeCorsRules(raw: string | null | undefined): CorsRule[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CorsRule[];
  } catch {
    return [];
  }
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

export function renderCorsXml(rules: CorsRule[]): string {
  const rulesXml = rules
    .map((r) => {
      const parts = [
        ...r.allowedOrigins.map((o) => `<AllowedOrigin>${escapeXml(o)}</AllowedOrigin>`),
        ...r.allowedMethods.map((m) => `<AllowedMethod>${escapeXml(m)}</AllowedMethod>`),
        ...r.allowedHeaders.map((h) => `<AllowedHeader>${escapeXml(h)}</AllowedHeader>`),
        ...r.exposeHeaders.map((h) => `<ExposeHeader>${escapeXml(h)}</ExposeHeader>`),
        ...(r.maxAgeSeconds > 0 ? [`<MaxAgeSeconds>${r.maxAgeSeconds}</MaxAgeSeconds>`] : []),
      ];
      return `  <CORSRule>\n    ${parts.join('')}\n  </CORSRule>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
${rulesXml}
</CORSConfiguration>`;
}

type CorsRequest = {
  preflight?: boolean;
  requestMethod?: string;
  requestHeaders?: string[];
};

// Compute the Access-Control-* headers for a request against the stored rules.
// Returns an empty map when no rule allows the origin (caller then omits ACAO
// entirely, or rejects a preflight). `*` in AllowedOrigins wildcards; the
// echoed origin is used otherwise so credentialed requests can't be confused
// with a wildcard grant.
export function corsHeadersForRequest(rules: CorsRule[], origin: string, req: CorsRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (rules.length === 0 || !origin) return headers;
  const matched = rules.find((r) => {
    const originOk = r.allowedOrigins.includes('*') || r.allowedOrigins.includes(origin);
    if (!originOk) return false;
    if (req.preflight && req.requestMethod && !r.allowedMethods.includes(req.requestMethod)) return false;
    return true;
  });
  if (!matched) return headers;
  headers['Access-Control-Allow-Origin'] = matched.allowedOrigins.includes('*') ? '*' : origin;
  headers['Vary'] = 'Origin';
  if (matched.exposeHeaders.length) {
    headers['Access-Control-Expose-Headers'] = matched.exposeHeaders.join(', ');
  }
  if (req.preflight) {
    headers['Access-Control-Allow-Methods'] = matched.allowedMethods.join(', ');
    if (req.requestHeaders && req.requestHeaders.length) {
      headers['Access-Control-Allow-Headers'] = req.requestHeaders.join(', ');
    } else if (matched.allowedHeaders.length) {
      headers['Access-Control-Allow-Headers'] = matched.allowedHeaders.join(', ');
    }
    if (matched.maxAgeSeconds > 0) {
      headers['Access-Control-Max-Age'] = String(matched.maxAgeSeconds);
    }
  }
  return headers;
}
