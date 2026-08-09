# R2 Storage — direct browser upload example

Uploads a file **straight from the browser** to your bucket using a **presigned PUT URL**
(no server-side proxying of file bytes). Demonstrates the per-bucket CORS feature.

## Prerequisites

1. A bucket where you'll allow browser uploads.
2. Its `corsOrigins` must include the page's origin (or `*` for dev). In the control panel:
   *Buckets → edit → CORS origins*, or:

   ```bash
   curl -X PATCH -H "Content-Type: application/json" -H "X-Admin-Secret: $ADMIN_SECRET" \
     -d '{"corsOrigins":"http://localhost:3000"}' \
     https://panel.example.com/api/admin/buckets/my-app-assets
   ```

## Run

```bash
cd examples/browser-upload
cp .env.example .env       # endpoint + scoped key (WRITE_ONLY or FULL for that bucket)
npm install
npm start                  # http://localhost:3000
```

## Flow

1. Page asks `/presign-put` for a 15-minute presigned PUT URL for a random key.
2. Page `fetch`es the object directly to `https://cdn.example.com/s3/...` (cross-origin —
   this is exactly why `corsOrigins` must allow the page origin).
3. The presigned URL expires in 15 minutes; the object stays stored.

> For production, keep the presign endpoint behind your own auth — anyone with access
> to it can upload to the bucket within the key's permissions.
