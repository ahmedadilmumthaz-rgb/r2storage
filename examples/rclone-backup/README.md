# R2 Storage — rclone backup example

Use your self-hosted storage as an offsite backup target. Any folder becomes a bucket:
nothing about rclone here is special — it's the plain S3 remote with path-style on.

## One-time setup

```bash
rclone config create r2storage s3 provider Other \
  access_key_id "r2_..." secret_access_key "..." \
  endpoint "https://cdn.example.com/s3" \
  region us-east-1 force_path_style true
```

(or paste the `rclone.conf` from this directory into `~/.config/rclone/`.)

## Test

```bash
rclone copy /srv/data r2storage:backups/data --progress
rclone ls r2storage:backups
```

## Scheduled backup (cron)

```bash
# every night at 02:30 — sync (destructive: mirrors source, deletes remote-only files)
30 2 * * * rclone sync /srv/data r2storage:backups/data --log-file /var/log/rclone-backup.log --log-level INFO
```

## Restore

```bash
rclone copy r2storage:backups/data /srv/data/restore --progress
```

> Use a `WRITE_ONLY` key scoped to the backup bucket for the `sync` job so a
> compromised backup host can only write, never read or destroy.
