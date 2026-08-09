# R2 Storage — Laravel example

## Setup

1. Add the `r2storage` disk from `filesystems.php` to `config/filesystems.php`.
2. Export env vars in `.env`:

```env
R2_ENDPOINT=https://cdn.example.com/s3        # MUST end in /s3
R2_ACCESS_KEY_ID=r2_...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=my-app-assets
```

## Usage

```php
use Illuminate\Support\Facades\Storage;

// Store
$path = Storage::disk('r2storage')->putFileAs('photos', $request->file('photo'), 'photo.jpg');

// Read / delete
$exists = Storage::disk('r2storage')->exists($path);
Storage::disk('r2storage')->delete($path);

// Temporary (presigned) download URL — private bucket, expires in 1 hour
$url = Storage::disk('r2storage')->temporaryUrl($path, now()->addHour());
```

> `use_path_style_endpoint => true` is the line that makes this work with the
> server's path-style buckets.
