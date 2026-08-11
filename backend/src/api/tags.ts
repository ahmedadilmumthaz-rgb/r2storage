// S3 object-tag helpers. Tags are stored as a JSON map on the Object row and
// travel on the wire as `key=value&...` (x-amz-tagging header) or as
// <Tagging><TagSet><Tag><Key>..</Key><Value>..</Value></Tag></TagSet></Tagging>
// XML (the ?tagging subresource). Parsed via regex only — same no-XML-parser
// policy as the rest of the API (no XXE surface).

const MAX_TAGS = 10;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 256;
// S3's allowed tag charset (plus anything URL-encoded on the wire); decoded
// values keep UTF-8 as-is, so we only reject structurally impossible input.
const TAG_CHARSET = /^[A-Za-z0-9 +\-=._:/@]*$/;

export type ObjectTags = Record<string, string>;

// Parse an x-amz-tagging header value. Returns null when the header is
// malformed (empty key, missing `=`, duplicate keys, too many tags, or an
// over-long key/value) — the caller maps that to InvalidTag.
export function parseTaggingHeader(value: string): ObjectTags | null {
  const tags: ObjectTags = {};
  for (const pair of value.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    let key: string;
    let val: string;
    try {
      key = decodeURIComponent(pair.slice(0, eq));
      val = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return null;
    }
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || val.length > MAX_VALUE_LENGTH) return null;
    if (key in tags) return null; // duplicate key
    tags[key] = val;
  }
  if (Object.keys(tags).length > MAX_TAGS) return null;
  for (const [k, v] of Object.entries(tags)) {
    if (!TAG_CHARSET.test(k) || !TAG_CHARSET.test(v)) return null;
  }
  return tags;
}

// Parse the ?tagging PUT body. Returns null when the XML is malformed.
export function parseTaggingXml(xml: string): ObjectTags | null {
  const pairs = [...xml.matchAll(/<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g)];
  // No tags AND no empty container (<TagSet/> or <TagSet></TagSet>) is malformed.
  if (pairs.length === 0 && !/<TagSet\s*\/>|<TagSet>\s*<\/TagSet>/.test(xml)) {
    return null;
  }
  const tags: ObjectTags = {};
  for (const [, k, v] of pairs) {
    if (k.length === 0 || k.length > MAX_KEY_LENGTH || v.length > MAX_VALUE_LENGTH) return null;
    if (k in tags) return null;
    tags[k] = v;
  }
  if (Object.keys(tags).length > MAX_TAGS) return null;
  for (const [k, val] of Object.entries(tags)) {
    if (!TAG_CHARSET.test(k) || !TAG_CHARSET.test(val)) return null;
  }
  return tags;
}

export function serializeTags(tags: ObjectTags | undefined | null): string | null {
  if (!tags || Object.keys(tags).length === 0) return null;
  return JSON.stringify(tags);
}

export function deserializeTags(raw: string | null | undefined): ObjectTags {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ObjectTags;
  } catch {
    return {};
  }
}

export function tagCount(raw: string | null | undefined): number {
  return Object.keys(deserializeTags(raw)).length;
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

export function renderTaggingXml(tags: ObjectTags): string {
  const tagsXml = Object.entries(tags)
    .map(([k, v]) => `  <Tag><Key>${escapeXml(k)}</Key><Value>${escapeXml(v)}</Value></Tag>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <TagSet>
${tagsXml}
  </TagSet>
</Tagging>`;
}
