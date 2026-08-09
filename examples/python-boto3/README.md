# R2 Storage — Python / boto3 example

Upload/download/list/delete, multipart, and presigned URLs against your self-hosted storage.

## Run

```bash
cd examples/python-boto3
pip install boto3
export R2_ENDPOINT="https://cdn.example.com/s3"      # MUST end in /s3
export R2_ACCESS_KEY_ID="r2_..."
export R2_SECRET_ACCESS_KEY="..."
export R2_BUCKET="my-app-assets"
python upload.py
```

## Two settings that matter

| Setting | Value | Why |
| --- | --- | --- |
| `addressing_style` | `path` | the server uses path-style buckets |
| `signature_version` | `s3v4` | presigned URLs require SigV4 |

> For Django, the same settings map to `AWS_S3_ADDRESSING_STYLE="path"` and
> `AWS_S3_SIGNATURE_VERSION="s3v4"` on the S3 storage backend (see USAGE.md § 3.2).
