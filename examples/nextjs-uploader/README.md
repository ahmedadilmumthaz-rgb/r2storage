# R2 Storage — Next.js uploader example

Minimal App-Router app that uploads files to a bucket on your self-hosted R2 storage and serves a presigned download link.

## Setup

```bash
cd examples/nextjs-uploader
cp .env.example .env.local    # fill in your endpoint + scoped access key
npm install
npm run dev                   # http://localhost:3000
```

## Env vars (from the r2storage control panel → Access Keys)

| Var | Example | Notes |
| --- | --- | --- |
| `R2_ENDPOINT` | `https://cdn.example.com/s3` | MUST end in `/s3` |
| `R2_REGION` | `us-east-1` | required by the SDK, any value works |
| `R2_ACCESS_KEY_ID` | `r2_...` | create a key scoped to your bucket |
| `R2_SECRET_ACCESS_KEY` | `...` | server-side only, never in client JS |
| `R2_BUCKET` | `my-app-assets` | the bucket you created for this app |

## Flow

1. `app/page.tsx` (client) posts the file to `/api/upload`.
2. `app/api/upload/route.ts` (server) uploads it to storage with `PutObjectCommand`.
3. `app/api/presign/route.ts` returns a SigV4 presigned GET URL the page can open.

The bucket can stay **private** — downloads go through presigned URLs. Make the bucket
**Public** + map a custom domain only if you want anonymous `https://cdn.example.com/<key>` links.
