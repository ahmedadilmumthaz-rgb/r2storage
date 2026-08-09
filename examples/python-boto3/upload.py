#!/usr/bin/env python3
"""
R2 Storage — boto3 usage example.

Shows upload / download / list / delete, multipart, and presigned URLs against
your self-hosted S3-compatible storage.

Usage:
    pip install boto3
    export R2_ENDPOINT="https://cdn.example.com/s3"
    export R2_ACCESS_KEY_ID="r2_..."
    export R2_SECRET_ACCESS_KEY="..."
    export R2_BUCKET="my-app-assets"
    python upload.py
"""
import io
import os

import boto3

ENDPOINT = os.environ["R2_ENDPOINT"]                 # must end in /s3
ACCESS_KEY_ID = os.environ["R2_ACCESS_KEY_ID"]
SECRET_ACCESS_KEY = os.environ["R2_SECRET_ACCESS_KEY"]
BUCKET = os.environ["R2_BUCKET"]

s3 = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    region_name=os.environ.get("R2_REGION", "us-east-1"),
    aws_access_key_id=ACCESS_KEY_ID,
    aws_secret_access_key=SECRET_ACCESS_KEY,
    config=boto3.session.Config(
        s3={"addressing_style": "path"},   # REQUIRED: path-style addressing
        signature_version="s3v4",          # REQUIRED for presigned URLs
    ),
)


def main() -> None:
    # 1. Upload a file-like object with a content type
    s3.put_object(Bucket=BUCKET, Key="hello.txt", Body=b"hello world\n", ContentType="text/plain")

    # 2. Upload from disk (auto multipart for large files)
    s3.upload_file("/etc/hostname", BUCKET, "hostname.txt")

    # 3. List
    print("Objects:")
    for obj in s3.list_objects_v2(Bucket=BUCKET).get("Contents", []):
        print(f"  {obj['Key']}  ({obj['Size']} bytes)")

    # 4. Download to memory + to disk
    data = s3.get_object(Bucket=BUCKET, Key="hello.txt")["Body"].read()
    print("hello.txt:", data.decode().strip())
    s3.download_fileobj(BUCKET, "hostname.txt", io.BytesIO())

    # 5. Presigned GET (1 hour) — works because signature_version="s3v4"
    url = s3.generate_presigned_url(
        "get_object", Params={"Bucket": BUCKET, "Key": "hello.txt"}, ExpiresIn=3600
    )
    print("Presigned URL (1h):", url[:90] + "…")

    # 6. Delete
    s3.delete_object(Bucket=BUCKET, Key="hostname.txt")

    print("Done.")


if __name__ == "__main__":
    main()
