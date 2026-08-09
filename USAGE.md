# Using R2 Storage in Other Projects

How to plug this self-hosted R2/S3-compatible object store into your own apps — Node.js/Next.js, Python/Django, Rails, Laravel, browser uploads, and backups. Full S3 + Admin API reference: [API.md](API.md). Runnable examples live in [`examples/`](examples/).

---

## 0. Before you integrate

Every app follows the same provisioning pattern — do this **once** per project (control panel or Admin API):

1. **Create a bucket** for the app.
2. **Create a least-privilege access key** scoped to *that bucket only* (`bucketFilter`) with the narrowest permission it needs:
   - server-side read/write of user files → `FULL`
   - only downloads → `READ_ONLY`
   - only uploads (never read/delete) → `WRITE_ONLY`
3. Keep the **secret in server-side env vars**, never ship it in client JS.

With the `curl` script (replace `$ADMIN_SECRET`, host, and names):

```bash
H="Content-Type: application/json"
A="-H X-Admin-Secret:$ADMIN_SECRET"
S="https://panel.example.com"

# 1. bucket
curl -s $A -H "$H" -d '{"name":"my-app-assets","isPublic":false}' $S/api/admin/buckets

# 2. write-only key scoped to that bucket
curl -s $A -H "$H" -d '{"name":"my-app","permission":"FULL","bucketFilter":"my-app-assets"}' $S/api/admin/keys
# -> save the returned accessKeyId + secretAccessKey to your app's env
```

---

## 1. Configuration cheat sheet

Every S3 SDK/client needs these four settings — **all of them are mandatory**:

| Setting | Value | Why |
| --- | --- | --- |
| `endpoint` | `https://cdn.example.com/s3` | Must end in `/s3` — the S3 protocol lives at that path prefix. Any configured host (`cdn.`, `panel.`, or a bucket subdomain) works. |
| `region` | `us-east-1` | Arbitrary but required by every SDK; the server does not use it beyond SigV4. |
| path-style addressing | `forcePathStyle: true` / `addressing_style = path` | **Required** — no virtual-host buckets. |
| signature version | `s3v4` (boto3/curl) | **Required** so presigned URLs verify. AWS SDKs default to SigV4 already. |

Scripts can skip SigV4 entirely and authenticate with request headers:

| Header | For |
| --- | --- |
| `x-api-key: <secretAccessKey>` | full access (for simple tools) |
| `x-access-key-id: <accessKeyId>` | PUT/GET/HEAD with that key's permissions (the panel uses this) |

---

## 2. Serving files to end users

- **Public bucket + custom domain** (no auth, no signing): set the bucket **Public** and map a domain (e.g. `https://cdn.example.com`). Objects are then streamed at `https://cdn.example.com/<key>`. Perfect for images, CSS/JS, downloads. See README § "Custom Domains".
- **Private objects**: the S3 API returns 403 for unauthenticated reads. Share individual files with **presigned URLs** (see below).

---

## 3. Recipes by framework

### 3.1 Next.js / Node.js

Runnable app: [`examples/nextjs-uploader/`](examples/nextjs-uploader) — server-side upload + presigned GET.

Server Action / Route Handler pattern:

```ts
// lib/s3.ts — server-only (never import from a client component)
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.R2_ENDPOINT,      // https://cdn.example.com/s3
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function uploadFile(key: string, body: Buffer, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key, Body: body, ContentType: contentType }));
}

export async function presignDownload(key: string, expiresIn = 3600) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }), { expiresIn });
}
```

```ts
// app/api/upload/route.ts
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get('file') as File;
  const key = `${crypto.randomUUID()}-${file.name}`;
  await uploadFile(key, Buffer.from(await file.arrayBuffer()), file.type);
  return Response.json({ key });
}
```

Then the client shows `<img src={await presignDownload(key)} />` for private objects.

### 3.2 Python / Django

Script: [`examples/python-boto3/`](examples/python-boto3). With `django-storages` use the `S3` storage backend:

```python
# settings.py
AWS_S3_ENDPOINT_URL = "https://cdn.example.com/s3"
AWS_S3_REGION_NAME = "us-east-1"
AWS_ACCESS_KEY_ID = "..."
AWS_SECRET_ACCESS_KEY = "..."
AWS_STORAGE_BUCKET_NAME = "my-app-assets"
AWS_S3_SIGNATURE_VERSION = "s3v4"
AWS_S3_ADDRESSING_STYLE = "path"
STORAGES = {"default": {"BACKEND": "storages.backends.s3boto3.S3Boto3Storage"}}
```

Uploads then just work in your forms/ModelForms (`FileField`), and the SDK equivalent (boto3) is in the example script.

### 3.3 Rails ActiveStorage

Snippet + config: [`examples/rails-activestorage/`](examples/rails-activestorage). Point the S3 service at the endpoint with path-style:

```yaml
# config/storage.yml
r2storage:
  service: S3
  bucket: my-app-assets
  endpoint: https://cdn.example.com/s3
  region: us-east-1
  access_key_id: <%= ENV["R2_ACCESS_KEY_ID"] %>
  secret_access_key: <%= ENV["R2_SECRET_ACCESS_KEY"] %>
  force_path_style: true
```

```ruby
# config/environments/production.rb
config.active_storage.service = :r2storage
```

### 3.4 Laravel

Disk config: [`examples/laravel/`](examples/laravel).

```php
// config/filesystems.php
'r2storage' => [
    'driver' => 's3',
    'key' => env('R2_ACCESS_KEY_ID'),
    'secret' => env('R2_SECRET_ACCESS_KEY'),
    'region' => env('R2_REGION', 'us-east-1'),
    'bucket' => env('R2_BUCKET'),
    'url' => env('R2_ENDPOINT', 'https://cdn.example.com/s3'),
    'endpoint' => env('R2_ENDPOINT', 'https://cdn.example.com/s3'),
    'use_path_style_endpoint' => true,
],
```

```php
// usage
Storage::disk('r2storage')->put('photos/' . $file->getClientOriginalName(), $file);
$url = Storage::disk('r2storage')->temporaryUrl('photos/photo.jpg', now()->addHour());
```

### 3.5 Direct browser uploads (presigned PUT + CORS)

For large files (or to keep your server from proxying megabytes), mint a **presigned PUT URL** server-side and have the browser `fetch`/`XMLHttpRequest` PUT the object straight to storage. This requires:

1. The bucket's `corsOrigins` set to your web app's origin(s) (comma-separated, or `*` for dev). Panel → bucket edit, or:
   ```bash
   curl -s $A -X PATCH -H "$H" -d '{"corsOrigins":"https://myapp.example.com"}' $S/api/admin/buckets/my-app-assets
   ```
2. A tiny endpoint in your app that returns a presigned PUT URL:

   ```ts
   import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
   import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
   const s3 = new S3Client({ region: 'us-east-1', endpoint: process.env.R2_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });

   // app/api/presign-put/route.ts
   export async function POST(req: Request) {
     const { key, contentType } = await req.json();
     const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key, ContentType: contentType }), { expiresIn: 900 });
     return Response.json({ url });
   }
   ```

3. The browser uploads straight to that URL:

   ```js
   const { url } = await fetch('/api/presign-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'user123/avatar.png', contentType: file.type }) }).then(r => r.json());
   await fetch(url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
   ```

Runnable static page + server: [`examples/browser-upload/`](examples/browser-upload).

### 3.6 Backups with rclone

Config + cron: [`examples/rclone-backup/`](examples/rclone-backup). The R2 protocol itself is the backup target — `rclone sync` any folder to a bucket:

```bash
rclone copy /srv/data r2storage:backups/data
```

---

## 4. Pitfalls & gotchas

- **`InvalidAccessKeyId` / `SignatureDoesNotMatch`**: endpoint must end in `/s3`; region must be `us-east-1`; if you changed keys, both client and server must agree.
- **"Host header must be signed"**: some minimal clients sign `Authorization` without `host` in `SignedHeaders`. The AWS SDKs/CLI and boto3 do this correctly.
- **Path-style is mandatory** — forgetting `forcePathStyle` sends virtual-host requests the server doesn't implement.
- **boto3 presigned URLs** only work with `signature_version="s3v4"`.
- **Browser uploads silently fail** (CORS) if the bucket `corsOrigins` doesn't include your page's origin — check the browser console for a CORS error, not the network tab.
- **Private by default**: buckets are private until you mark them Public; only mark Public what should be world-readable.
- **Rate limits**: `/s3/*` is limited to 600 req/min/IP and `/api/*` to 30/min/IP (behind Cloudflare, per `CF-Connecting-IP`). For bulk jobs, serialize and add retries.

---

## 5. The examples

| Example | Stack | What it shows |
| --- | --- | --- |
| [`examples/nextjs-uploader`](examples/nextjs-uploader) | Next.js (App Router) | server-side upload, presigned GET, `.env` config |
| [`examples/browser-upload`](examples/browser-upload) | Node + static page | presigned PUT straight from the browser, bucket CORS |
| [`examples/python-boto3`](examples/python-boto3) | Python | upload/download/list/multipart/presign with boto3 |
| [`examples/rails-activestorage`](examples/rails-activestorage) | Rails | ActiveStorage S3 service config |
| [`examples/laravel`](examples/laravel) | Laravel | filesystem S3 disk config |
| [`examples/rclone-backup`](examples/rclone-backup) | rclone | offsite backup config + cron |
