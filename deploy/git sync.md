Perfect! You're doing the right thing by backing up, but since you want the new repo to use the existing data, you don't need to do anything special - the data stays in place!

The key is that your new repo will use the same environment file (/etc/r2storage/env) which points to:

DATABASE_URL=file:/var/lib/r2storage/storage.db

STORAGE_DIR=/var/lib/r2storage/storage_blobs

So the data automatically stays connected!

Here's the streamlined approach:
bash
# 1. Stop the service
sudo systemctl stop r2storage

# 2. Backup (just in case - good practice)
sudo cp -r /var/lib/r2storage /var/lib/r2storage.backup.$(date +%Y%m%d)
sudo cp -r /opt/r2storage /opt/r2storage.backup.$(date +%Y%m%d)

# 3. Get your ADMIN_SECRET (save this)
ADMIN_SECRET=$(sudo cat /etc/r2storage/env | grep ADMIN_SECRET | cut -d= -f2)
echo "Your ADMIN_SECRET: $ADMIN_SECRET"

# 4. Remove old code (NOT the data!)
sudo rm -rf /opt/r2storage

# 5. Clone fresh repo
cd ~/apps
rm -rf r2storage  # remove old non-git version
git clone <your-repo-url> r2storage
sudo git clone ~/apps/r2storage /opt/r2storage

# 6. Fix ownership
sudo chown -R r2storage:r2storage /opt/r2storage

# 7. Install and build
cd /opt/r2storage/backend
sudo -u r2storage npm install --no-fund --no-audit
sudo -u r2storage npm run build

cd /opt/r2storage/frontend
sudo -u r2storage npm install --no-fund --no-audit
sudo -u r2storage npm run build

# 8. Copy frontend to backend public
sudo -u r2storage mkdir -p /opt/r2storage/backend/dist/public
sudo -u r2storage cp -R /opt/r2storage/frontend/dist/. /opt/r2storage/backend/dist/public/

# 9. Verify env is still there (it should be!)
sudo cat /etc/r2storage/env

# 10. Start the service
sudo systemctl start r2storage
sudo systemctl status r2storage

# 11. Test - should show existing data
curl http://127.0.0.1:4000/health
Verify Your Data Is Still There
bash
# Check database exists
ls -la /var/lib/r2storage/storage.db

# Check uploads exist
ls -la /var/lib/r2storage/storage_blobs/

# Check env still has correct paths
sudo cat /etc/r2storage/env | grep -E "DATABASE_URL|STORAGE_DIR"
The Backup is Just Safety
You won't need to restore from backup because:

You're only replacing /opt/r2storage/ (application code)

/var/lib/r2storage/ (data) stays untouched

/etc/r2storage/env (config) stays untouched

The backups are just in case something goes wrong. If everything works, you can delete them later:

bash
# After confirming everything works
sudo rm -rf /opt/r2storage.backup*
sudo rm -rf /var/lib/r2storage.backup*
Quick Verification
After setup, check that your data is still there:

bash
# Count records in database (if you have sqlite3)
sqlite3 /var/lib/r2storage/storage.db "SELECT COUNT(*) FROM buckets;" 2>/dev/null || echo "Database exists but no buckets table yet"

# Check file size
ls -lh /var/lib/r2storage/storage.db
Everything should work seamlessly! Your new code will use the existing database and uploaded files.