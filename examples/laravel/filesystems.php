<?php
// config/filesystems.php — add this disk.
'r2storage' => [
    'driver' => 's3',
    'key' => env('R2_ACCESS_KEY_ID'),
    'secret' => env('R2_SECRET_ACCESS_KEY'),
    'region' => env('R2_REGION', 'us-east-1'),
    'bucket' => env('R2_BUCKET'),
    'url' => env('R2_ENDPOINT', 'https://cdn.example.com/s3'),
    'endpoint' => env('R2_ENDPOINT', 'https://cdn.example.com/s3'),
    'use_path_style_endpoint' => true,           // REQUIRED for R2 storage
    'scheme' => 'https',
    'visibility' => 'private',                   // or 'public' for a public bucket
],
