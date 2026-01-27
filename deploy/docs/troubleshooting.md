# Troubleshooting Guide

Common issues and solutions for self-hosted Synap instances.

## Installation Issues

### Docker Not Found

**Error**: `docker: command not found`

**Solution**:

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker
```

### Permission Denied

**Error**: `permission denied while trying to connect to Docker daemon`

**Solution**:

```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Log out and back in, or:
newgrp docker
```

### Port Already in Use

**Error**: `port is already allocated`

**Solution**:

```bash
# Find what's using port 80/443
sudo lsof -i :80
sudo lsof -i :443

# Stop conflicting service (e.g., nginx, apache)
sudo systemctl stop nginx
sudo systemctl disable nginx
```

## SSL/Certificate Issues

### Certificate Not Provisioning

**Symptoms**: Browser shows "Not Secure" or certificate errors

**Solutions**:

1. **Check DNS**:

   ```bash
   dig your-domain.com
   # Should return your server's IP
   ```

2. **Wait**: Let's Encrypt can take 1-2 minutes

3. **Check Caddy logs**:

   ```bash
   ./synap-cli logs caddy
   ```

4. **Verify ports are open**:

   ```bash
   sudo ufw status
   # Ensure 80 and 443 are allowed
   ```

5. **Test manually**:
   ```bash
   curl -I http://your-domain.com
   # Should redirect to HTTPS
   ```

### Certificate Renewal Failed

**Error**: Certificate expired

**Solution**:

```bash
# Restart Caddy to force renewal
./synap-cli restart caddy

# Check logs
./synap-cli logs caddy
```

## Database Issues

### Connection Refused

**Error**: `connection refused` or `could not connect to server`

**Solutions**:

1. **Check PostgreSQL is running**:

   ```bash
   docker compose ps postgres
   ```

2. **Restart PostgreSQL**:

   ```bash
   ./synap-cli restart postgres
   ```

3. **Check logs**:
   ```bash
   ./synap-cli logs postgres
   ```

### Authentication Failed

**Error**: `password authentication failed for user "synap"`

**Solutions**:

1. **Verify password in `.env`**:

   ```bash
   grep POSTGRES_PASSWORD .env
   ```

2. **Reset database** (⚠️ DESTROYS DATA):
   ```bash
   docker compose down -v
   docker compose up -d
   ./synap-cli restore latest-backup.tar.gz
   ```

### Database Corruption

**Symptoms**: Queries fail, data inconsistencies

**Solution**:

```bash
# Stop backend
docker compose stop backend

# Run PostgreSQL recovery
docker compose exec postgres pg_resetwal /var/lib/postgresql/data

# Restore from backup
./synap-cli restore backups/latest.tar.gz
```

## Service Crashes

### Backend Won't Start

**Symptoms**: Backend container keeps restarting

**Solutions**:

1. **Check logs**:

   ```bash
   ./synap-cli logs backend
   ```

2. **Common causes**:
   - Missing environment variables
   - Database connection failed
   - Port conflict

3. **Verify configuration**:

   ```bash
   docker compose config
   ```

4. **Restart with fresh logs**:
   ```bash
   docker compose restart backend
   ./synap-cli logs backend
   ```

### Out of Memory

**Symptoms**: Services crash with "OOM" errors

**Solutions**:

1. **Check memory usage**:

   ```bash
   docker stats
   ```

2. **Increase swap**:

   ```bash
   sudo fallocate -l 4G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   ```

3. **Add resource limits**:
   ```yaml
   # docker-compose.override.yml
   services:
     backend:
       deploy:
         resources:
           limits:
             memory: 2G
   ```

## Performance Issues

### Slow Response Times

**Solutions**:

1. **Check resource usage**:

   ```bash
   docker stats
   htop
   ```

2. **Increase database pool**:

   ```env
   # .env
   DB_POOL_SIZE=20
   ```

3. **Add Redis memory**:

   ```env
   REDIS_MAX_MEMORY=512mb
   ```

4. **Scale backend**:
   ```yaml
   # docker-compose.override.yml
   services:
     backend:
       deploy:
         replicas: 3
   ```

### High CPU Usage

**Solutions**:

1. **Identify culprit**:

   ```bash
   docker stats
   ```

2. **Check logs for errors**:

   ```bash
   ./synap-cli logs
   ```

3. **Restart services**:
   ```bash
   ./synap-cli restart
   ```

## AI Features Not Working

### OpenAI API Errors

**Error**: `401 Unauthorized` or `API key invalid`

**Solutions**:

1. **Verify API key**:

   ```bash
   grep OPENAI_API_KEY .env
   ```

2. **Test API key**:

   ```bash
   curl https://api.openai.com/v1/models \
     -H "Authorization: Bearer YOUR_KEY"
   ```

3. **Check quota**:
   - Visit https://platform.openai.com/usage

4. **Restart intelligence service**:
   ```bash
   ./synap-cli restart intelligence-service
   ```

### Slow AI Responses

**Solutions**:

1. **Check intelligence service logs**:

   ```bash
   ./synap-cli logs intelligence-service
   ```

2. **Verify network connectivity**:

   ```bash
   docker compose exec intelligence-service ping -c 3 api.openai.com
   ```

3. **Increase timeout** (if using proxy)

## Storage Issues

### MinIO Not Accessible

**Symptoms**: File uploads fail

**Solutions**:

1. **Check MinIO is running**:

   ```bash
   docker compose ps minio
   ```

2. **Verify credentials**:

   ```bash
   grep MINIO .env
   ```

3. **Access MinIO console**:

   ```
   https://your-domain.com/storage
   ```

4. **Check disk space**:
   ```bash
   df -h
   ```

### Files Not Uploading

**Solutions**:

1. **Check max upload size**:

   ```env
   MAX_UPLOAD_SIZE=500MB
   ```

2. **Check MinIO logs**:

   ```bash
   ./synap-cli logs minio
   ```

3. **Verify bucket exists**:
   ```bash
   docker compose exec minio mc ls local/
   ```

## Search Issues

### Typesense Not Indexing

**Solutions**:

1. **Check Typesense is running**:

   ```bash
   docker compose ps typesense
   ```

2. **Verify API key**:

   ```bash
   grep TYPESENSE .env
   ```

3. **Reindex manually**:

   ```bash
   docker compose exec backend sh -c 'cd packages/search && pnpm reindex'
   ```

4. **Check logs**:
   ```bash
   ./synap-cli logs typesense
   ```

## Update Issues

### Update Failed

**Symptoms**: Services won't start after update

**Solutions**:

1. **Rollback**:

   ```bash
   docker compose down
   docker compose pull
   docker compose up -d
   ```

2. **Restore from backup**:

   ```bash
   ./synap-cli restore backups/pre-update-*.tar.gz
   ```

3. **Check migration logs**:
   ```bash
   ./synap-cli logs backend | grep migration
   ```

## Network Issues

### Can't Access from Outside

**Solutions**:

1. **Check firewall**:

   ```bash
   sudo ufw status
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   ```

2. **Verify DNS**:

   ```bash
   dig your-domain.com
   nslookup your-domain.com
   ```

3. **Test locally first**:

   ```bash
   curl http://localhost:4000/health
   ```

4. **Check Caddy is listening**:
   ```bash
   docker compose ps caddy
   netstat -tlnp | grep :443
   ```

## Getting Help

If you're still stuck:

1. **Collect diagnostic info**:

   ```bash
   ./synap-cli health > health.txt
   docker compose logs > logs.txt
   docker compose config > config.txt
   ```

2. **Search existing issues**:
   https://github.com/synap-labs/synap-backend/issues

3. **Ask for help**:
   - Discord: https://discord.gg/synap
   - GitHub: Create new issue with diagnostic files

4. **Include**:
   - Synap version
   - Operating system
   - Docker version
   - Error messages
   - Steps to reproduce
