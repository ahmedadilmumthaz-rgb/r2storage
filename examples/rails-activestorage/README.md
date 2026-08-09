# R2 Storage — Rails ActiveStorage example

Wire your self-hosted S3-compatible storage into ActiveStorage.

## Setup

1. Add the service from `storage.yml` to `config/storage.yml`.
2. Set `config.active_storage.service = :r2storage` in `config/environments/production.rb`.
3. Export env vars (from the control panel → Access Keys):

```bash
export R2_ENDPOINT="https://cdn.example.com/s3"      # MUST end in /s3
export R2_ACCESS_KEY_ID="r2_..."
export R2_SECRET_ACCESS_KEY="..."
export R2_BUCKET="my-app-assets"
```

## Usage

```ruby
class Avatar < ApplicationRecord
  has_one_attached :image
end
```

Uploads/reads/purge then hit storage transparently:

```ruby
avatar.image.attach(io: File.open("avatar.png"), filename: "avatar.png", content_type: "image/png")
avatar.image.url   # presigned download URL
```

> `force_path_style: true` is the one non-default line that makes this work —
> without it ActiveStorage emits virtual-host requests.
