import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Server-only: never import this module from a client component.
// Uses the least-privilege key you created for this app (scoped to R2_BUCKET).
const s3 = new S3Client({
  region: process.env.R2_REGION ?? "us-east-1",
  endpoint: process.env.R2_ENDPOINT, // e.g. https://cdn.example.com/s3
  forcePathStyle: true, // REQUIRED
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET!;

export async function uploadFile(key: string, body: Buffer, contentType: string) {
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType })
  );
}

export async function presignGet(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn }
  );
}
