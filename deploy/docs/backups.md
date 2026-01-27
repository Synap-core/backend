# Backup & Restore Guide

Complete guide to backing up and restoring your Synap instance.

## Quick Backup

Create a backup with one command:

```bash
./synap-cli backup
```

This creates a timestamped backup in `./backups/`:

- Database dump (PostgreSQL)
- Environment configuration

## Automated Backups

### Daily Backups

Add to crontab for daily backups at 2 AM:

```bash
crontab -e
```

Add this line:

```
0 2 * * * cd /opt/synap && ./synap-cli backup >> /var/log/synap-backup.log 2>&1
```

### Weekly Backups

For weekly backups on Sunday at 3 AM:

```
0 3 * * 0 cd /opt/synap && ./synap-cli backup weekly-$(date +\%Y\%m\%d)
```

### Backup Retention

Automatically delete backups older than 30 days:

```bash
# Add to crontab
0 4 * * * find /opt/synap/backups -name "*.tar.gz" -mtime +30 -delete
```

## What Gets Backed Up

### Included

- ✅ PostgreSQL database (all tables)
- ✅ Environment configuration (`.env`)
- ✅ User data
- ✅ Workspaces
- ✅ Entities and relationships
- ✅ Search indices metadata

### Not Included

- ❌ Docker volumes (MinIO files)
- ❌ Docker images
- ❌ Log files
- ❌ Temporary files

## Full Backup (Including Files)

For a complete backup including uploaded files:

```bash
#!/bin/bash
# full-backup.sh

# Database and config
./synap-cli backup full-$(date +%Y%m%d)

# MinIO files
docker run --rm \
  -v synap_minio_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/minio-$(date +%Y%m%d).tar.gz /data

echo "Full backup complete"
```

## Restore from Backup

### Basic Restore

```bash
./synap-cli restore backups/backup-20260127.tar.gz
```

**Warning**: This will overwrite current data!

### Manual Restore

If you need more control:

```bash
# Extract backup
tar -xzf backup-20260127.tar.gz

# Stop backend
docker compose stop backend

# Restore database
cat backup-20260127-database.sql | \
  docker compose exec -T postgres psql -U synap synap

# Restore .env
cp backup-20260127.env .env

# Restart
docker compose up -d
```

## Off-Site Backups

### Upload to S3

```bash
#!/bin/bash
# backup-to-s3.sh

BACKUP_FILE=$(./synap-cli backup | grep -o 'backup-.*\.tar\.gz')

aws s3 cp "backups/$BACKUP_FILE" \
  s3://my-synap-backups/ \
  --storage-class STANDARD_IA
```

### Upload to Google Cloud Storage

```bash
#!/bin/bash
# backup-to-gcs.sh

BACKUP_FILE=$(./synap-cli backup | grep -o 'backup-.*\.tar\.gz')

gsutil cp "backups/$BACKUP_FILE" \
  gs://my-synap-backups/
```

### Rsync to Remote Server

```bash
#!/bin/bash
# backup-to-remote.sh

./synap-cli backup

rsync -avz --delete \
  backups/ \
  user@backup-server:/backups/synap/
```

## Disaster Recovery

### Complete System Failure

If your server fails completely:

1. **Provision new server** with same specs
2. **Install Docker** and Docker Compose
3. **Clone repository**:
   ```bash
   git clone https://github.com/synap-labs/synap-backend.git
   cd synap-backend/deploy
   ```
4. **Download latest backup** from off-site storage
5. **Restore**:
   ```bash
   ./synap-cli restore /path/to/backup.tar.gz
   ```
6. **Update DNS** to point to new server

### Database Corruption

If database is corrupted but files are intact:

```bash
# Stop services
docker compose stop backend

# Drop and recreate database
docker compose exec postgres psql -U synap -c "DROP DATABASE synap;"
docker compose exec postgres psql -U synap -c "CREATE DATABASE synap;"

# Restore from backup
cat backup-database.sql | \
  docker compose exec -T postgres psql -U synap synap

# Restart
docker compose up -d
```

## Backup Verification

### Test Restore

Periodically test your backups:

```bash
#!/bin/bash
# test-restore.sh

# Create test directory
mkdir -p /tmp/synap-test
cd /tmp/synap-test

# Copy compose files
cp /opt/synap/docker-compose.yml .
cp /opt/synap/Caddyfile .

# Restore backup
/opt/synap/synap-cli restore /opt/synap/backups/latest.tar.gz

# Start services
docker compose up -d

# Test health
sleep 30
curl http://localhost:4000/health

# Cleanup
docker compose down -v
cd /opt/synap
rm -rf /tmp/synap-test
```

### Backup Size Monitoring

Monitor backup sizes:

```bash
# List backups by size
ls -lh backups/

# Alert if backup size changes significantly
CURRENT_SIZE=$(du -sb backups/latest.tar.gz | cut -f1)
EXPECTED_SIZE=1000000000  # 1GB

if [ $CURRENT_SIZE -lt $((EXPECTED_SIZE / 2)) ]; then
  echo "WARNING: Backup size unusually small!"
fi
```

## Backup Best Practices

1. **3-2-1 Rule**:
   - 3 copies of data
   - 2 different storage types
   - 1 off-site backup

2. **Test Restores** monthly

3. **Encrypt Backups** before uploading:

   ```bash
   gpg --encrypt --recipient you@example.com backup.tar.gz
   ```

4. **Monitor Backup Jobs**:

   ```bash
   # Check last backup
   ls -lt backups/ | head -n 2

   # Alert if no backup in 24h
   find backups/ -name "*.tar.gz" -mtime -1 | grep -q . || \
     echo "No recent backup!"
   ```

5. **Document Recovery Procedures**

6. **Keep Backup Scripts in Version Control**

## Backup Storage Requirements

### Estimate Backup Size

```bash
# Database size
docker compose exec postgres psql -U synap -c "\
  SELECT pg_size_pretty(pg_database_size('synap'));"

# MinIO files size
docker run --rm \
  -v synap_minio_data:/data \
  alpine du -sh /data

# Total estimate
echo "Total backup size: ~$(du -sh backups/ | cut -f1)"
```

### Retention Policy

Recommended retention:

- **Daily backups**: Keep 7 days
- **Weekly backups**: Keep 4 weeks
- **Monthly backups**: Keep 12 months

```bash
#!/bin/bash
# cleanup-old-backups.sh

# Delete daily backups older than 7 days
find backups/ -name "backup-*.tar.gz" -mtime +7 -delete

# Keep weekly backups for 4 weeks
find backups/ -name "weekly-*.tar.gz" -mtime +28 -delete

# Keep monthly backups for 1 year
find backups/ -name "monthly-*.tar.gz" -mtime +365 -delete
```

## Troubleshooting

### Backup Fails

```bash
# Check disk space
df -h

# Check permissions
ls -la backups/

# Check Docker volumes
docker volume ls
```

### Restore Fails

```bash
# Verify backup integrity
tar -tzf backup.tar.gz

# Check PostgreSQL logs
docker compose logs postgres

# Manual database restore
docker compose exec -T postgres psql -U synap synap < backup-database.sql
```

## Next Steps

- [Monitoring](./monitoring.md)
- [Scaling](./scaling.md)
- [Security](./security.md)
