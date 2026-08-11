// S3 bucket-lifecycle helpers. Rules are stored as a JSON array on the Bucket
// row and travel on the wire as
// <LifecycleConfiguration><Rule><ID>..</ID><Filter><Prefix>..</Prefix></Filter>
// <Status>Enabled</Status><Expiration><Days>N</Days></Expiration></Rule>
// </LifecycleConfiguration> XML (the ?lifecycle subresource). Parsed via regex
// only — same no-XML-parser policy as the rest of the API (no XXE surface).
// Only object *expiration* is implemented (the feature a media CDN actually
// uses); transitions are rejected as unsupported.

const MAX_RULES = 1000;
const MAX_ID_LENGTH = 255;

export type LifecycleRule = {
  id: string;
  prefix: string; // '' = whole bucket
  status: 'Enabled' | 'Disabled';
  days?: number; // expire N days after Last-Modified
  date?: string; // expire on ISO date (midnight UTC); mutually exclusive with days
};

// Parse a PutBucketLifecycle body. Returns null when the XML is malformed or a
// rule violates the wire contract — the caller maps that to MalformedXML.
export function parseLifecycleXml(xml: string): LifecycleRule[] | null {
  const ruleBlocks = [...xml.matchAll(/<Rule>([\s\S]*?)<\/Rule>/g)];
  if (ruleBlocks.length === 0 || ruleBlocks.length > MAX_RULES) return null;

  const inner = (s: string, tag: string): string | null => {
    const m = new RegExp(`<\\s*${tag}\\s*>\\s*([\\s\\S]*?)\\s*<\\s*/\\s*${tag}\\s*>`).exec(s);
    return m ? m[1] : null;
  };

  const rules: LifecycleRule[] = [];
  for (let i = 0; i < ruleBlocks.length; i++) {
    const block = ruleBlocks[i][1];

    const status = inner(block, 'Status');
    if (status !== 'Enabled' && status !== 'Disabled') return null;

    // Modern <Filter><Prefix>..</Prefix></Filter> or the legacy bare <Prefix>..
    // form AWS still accepts; a <Filter> that isn't a bare prefix is rejected.
    let prefix = inner(block, 'Filter');
    if (prefix !== null) {
      const p = inner(prefix, 'Prefix');
      if (p === null) return null; // Filter with And/Tag/... is unsupported
      prefix = p;
    } else {
      prefix = inner(block, 'Prefix') ?? '';
    }

    const exp = inner(block, 'Expiration');
    if (exp === null) return null; // a rule must expire something
    const daysRaw = inner(exp, 'Days');
    const dateRaw = inner(exp, 'Date');
    if (daysRaw === null && dateRaw === null) return null;
    if (daysRaw !== null && dateRaw !== null) return null;

    const rule: LifecycleRule = { id: '', prefix, status };
    if (daysRaw !== null) {
      const days = parseInt(daysRaw, 10);
      if (!Number.isInteger(days) || days < 1) return null;
      rule.days = days;
    } else {
      // ISO date YYYY-MM-DD that must actually exist on the calendar.
      const date = dateRaw!.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const d = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
      rule.date = date;
    }

    const id = inner(block, 'ID');
    if (id !== null) {
      if (id.length === 0 || id.length > MAX_ID_LENGTH) return null;
      rule.id = id;
    } else {
      rule.id = `rule-${i + 1}`; // AWS auto-assigns when omitted
    }

    rules.push(rule);
  }
  return rules;
}

export function serializeLifecycleRules(rules: LifecycleRule[] | null | undefined): string | null {
  if (!rules || rules.length === 0) return null;
  return JSON.stringify(rules);
}

export function deserializeLifecycleRules(raw: string | null | undefined): LifecycleRule[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LifecycleRule[]) : [];
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

export function renderLifecycleXml(rules: LifecycleRule[]): string {
  const rulesXml = rules
    .map((r) => {
      const expiration = r.days !== undefined
        ? `<Days>${r.days}</Days>`
        : r.date !== undefined
          ? `<Date>${escapeXml(r.date)}</Date>`
          : '';
      return `  <Rule>
    <ID>${escapeXml(r.id)}</ID>
    <Filter><Prefix>${escapeXml(r.prefix)}</Prefix></Filter>
    <Status>${r.status}</Status>
    <Expiration>${expiration}</Expiration>
  </Rule>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
${rulesXml}
</LifecycleConfiguration>`;
}
