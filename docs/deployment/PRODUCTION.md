# 🚀 Synap Backend - Deployment Guide

Complete guide for deploying Synap Backend to production.

---

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Database Setup](#database-setup)
4. [Storage Setup](#storage-setup)
5. [Deployment Steps](#deployment-steps)
6. [Post-Deployment Verification](#post-deployment-verification)
7. [Monitoring & Health Checks](#monitoring--health-checks)
8. [Rollback Procedures](#rollback-procedures)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Services

- **Database**: PostgreSQL (Neon, Supabase, Railway, or self-hosted)
- **Storage**: Cloudflare R2 (recommended) or MinIO
- **AI Services**: 
  - Anthropic API key (for conversational AI)
  - OpenAI API key (for embeddings)
- **Background Jobs**: Inngest account (optional, for async processing)

### Required Tools

- Node.js 20+
- pnpm 8+
- PostgreSQL client (psql) or database admin access
- Environment variable management (Vercel, Railway, or .env file)

---

## Environment Setup

### 1. Create Environment File

Create `.env.production` with all required variables:

```bash
# Database
DB_DIALECT=postgres
DATABASE_URL=postgresql://user:password@host:5432/synap

# Storage (Cloudflare R2)
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=your-r2-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=synap-storage
R2_PUBLIC_URL=https://your-bucket.r2.dev

# Auth (Better Auth)
BETTER_AUTH_SECRET=your-secret-key-here  # openssl rand -hex 32
BETTER_AUTH_URL=https://your-domain.com

# AI Services
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-proj-your-key-here
ANTHROPIC_MODEL=claude-3-haiku-20240307
ANTHROPIC_MAX_TOKENS=4096
ANTHROPIC_TEMPERATURE=0.7
EMBEDDINGS_MODEL=text-embedding-3-small

# Inngest (Optional)
INNGEST_EVENT_KEY=your-inngest-event-key
INNGEST_SIGNING_KEY=your-inngest-signing-key
INNGEST_BASE_URL=https://your-domain.com/api/inngest

# Server
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# CORS (if needed)
CORS_ORIGINS=https://your-frontend.com,https://app.your-domain.com
```

### 2. Validate Configuration

The application validates configuration at startup. Missing required variables will cause the server to exit with a clear error message.

**Test configuration locally before deploying:**

```bash
# Load production env
export $(cat .env.production | xargs)

# Run system tests
pnpm tsx scripts/test-system.ts
```

---

## Database Setup

### Option 1: Neon (Recommended for Serverless)

1. **Create Neon Account**: https://neon.tech
2. **Create Database**: 
   - Project name: `synap-production`
   - Region: Choose closest to your users
   - PostgreSQL version: 16
3. **Get Connection String**: Copy from Neon dashboard
4. **Enable Extensions**: Run initialization script

```bash
export DATABASE_URL=postgresql://...
pnpm --filter database db:init
```

Or manually:

```bash
# Enable pgvector
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Push schemas
cd packages/database
export DB_DIALECT=postgres
pnpm drizzle-kit push
```

### Option 2: Supabase

1. **Create Supabase Project**: https://supabase.com
2. **Get Connection String**: Settings → Database → Connection string
3. **Enable Extensions**: Supabase dashboard → Database → Extensions → Enable `vector`
4. **Push Schemas**: Same as Neon

### Option 3: Self-Hosted PostgreSQL

1. **Install PostgreSQL 16+** with TimescaleDB extension
2. **Create Database**:
   ```sql
   CREATE DATABASE synap;
   ```
3. **Enable Extensions**:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS timescaledb;
   ```
4. **Run Migrations**: Same as Neon

---

## Storage Setup

### Cloudflare R2 (Recommended)

1. **Create R2 Bucket**:
   - Go to Cloudflare Dashboard → R2
   - Create bucket: `synap-storage`
   - Set public access (optional, for public URLs)

2. **Create API Token**:
   - R2 → Manage R2 API Tokens
   - Create token with read/write permissions
   - Save: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

3. **Configure CORS** (if needed):
   ```json
   [
     {
       "AllowedOrigins": ["https://your-domain.com"],
       "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"]
     }
   ]
   ```

4. **Get Public URL**:
   - If bucket is public: `https://your-bucket.r2.dev`
   - If using custom domain: `https://storage.your-domain.com`
   - Set `R2_PUBLIC_URL` accordingly

### MinIO (Self-Hosted Alternative)

1. **Deploy MinIO**:
   ```bash
   docker run -d \
     -p 9000:9000 \
     -p 9001:9001 \
     -e MINIO_ROOT_USER=admin \
     -e MINIO_ROOT_PASSWORD=secure-password \
     -v /data/minio:/data \
     minio/minio server /data --console-address ":9001"
   ```

2. **Create Bucket**:
   - Access console: http://localhost:9001
   - Create bucket: `synap-storage`
   - Set public access policy

3. **Configure Environment**:
   ```bash
   STORAGE_PROVIDER=minio
   MINIO_ENDPOINT=https://storage.your-domain.com
   MINIO_ACCESS_KEY_ID=admin
   MINIO_SECRET_ACCESS_KEY=secure-password
   MINIO_BUCKET_NAME=synap-storage
   ```

---

## Deployment Steps

### Option 1: Vercel (Recommended)

1. **Install Vercel CLI**:
   ```bash
   npm i -g vercel
   ```

2. **Configure Project**:
   ```bash
   vercel --prod
   ```

3. **Set Environment Variables**:
   - Vercel Dashboard → Project → Settings → Environment Variables
   - Add all variables from `.env.production`
   - Set for "Production" environment

4. **Deploy**:
   ```bash
   vercel --prod
   ```

5. **Configure Build Settings**:
   - Root Directory: `/`
   - Build Command: `pnpm build`
   - Output Directory: `apps/api/dist` (if applicable)
   - Install Command: `pnpm install`

### Option 2: Railway

1. **Install Railway CLI**:
   ```bash
   npm i -g @railway/cli
   ```

2. **Login**:
   ```bash
   railway login
   ```

3. **Create Project**:
   ```bash
   railway init
   ```

4. **Add PostgreSQL**:
   ```bash
   railway add postgresql
   ```

5. **Set Environment Variables**:
   ```bash
   railway variables set DATABASE_URL=$DATABASE_URL
   railway variables set STORAGE_PROVIDER=r2
   # ... set all other variables
   ```

6. **Deploy**:
   ```bash
   railway up
   ```

### Option 3: Docker

1. **Build Image**:
   ```bash
   docker build -t synap-backend:latest .
   ```

2. **Run Container**:
   ```bash
   docker run -d \
     --name synap-api \
     -p 3000:3000 \
     --env-file .env.production \
     synap-backend:latest
   ```

3. **Docker Compose** (with PostgreSQL + MinIO):
   ```bash
   docker-compose -f docker-compose.production.yml up -d
   ```

### Option 4: Self-Hosted (PM2)

1. **Build Application**:
   ```bash
   pnpm build
   ```

2. **Install PM2**:
   ```bash
   npm i -g pm2
   ```

3. **Start Application**:
   ```bash
   pm2 start apps/api/dist/index.js \
     --name synap-api \
     --env production \
     --instances 2
   ```

4. **Save PM2 Configuration**:
   ```bash
   pm2 save
   pm2 startup
   ```

---

## Post-Deployment Verification

### 1. Health Check

```bash
curl https://your-domain.com/health
```

**Expected Response**:
```json
{
  "status": "ok",
  "timestamp": "2025-01-27T12:00:00.000Z",
  "version": "0.4.0",
  "mode": "multi-user",
  "auth": "better-auth"
}
```

### 2. Database Connection

```bash
# Test database query
curl -X POST https://your-domain.com/trpc/notes.list \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

### 3. Storage Operations

```bash
# Test storage (create a test note)
curl -X POST https://your-domain.com/trpc/notes.create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Test note"}'
```

### 4. AI Services

```bash
# Test conversational interface
curl -X POST https://your-domain.com/trpc/chat.send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello, test message"}'
```

### 5. Background Jobs

If using Inngest, verify jobs are processing:

```bash
# Check Inngest dashboard
# https://app.inngest.com
```

---

## Monitoring & Health Checks

### Health Check Endpoint

**URL**: `GET /health`

**Response**:
- `200 OK`: System is healthy
- `500 Internal Server Error`: System is unhealthy

**Use for**:
- Load balancer health checks
- Monitoring alerts
- Uptime monitoring (UptimeRobot, Pingdom, etc.)

### Logging

Structured logs are output to stdout/stderr in JSON format:

```json
{
  "level": "info",
  "time": 1706361600000,
  "module": "api-server",
  "msg": "Server running",
  "port": 3000
}
```

**Recommended Log Aggregation**:
- **Vercel**: Built-in logging
- **Railway**: Built-in logging
- **Self-Hosted**: Use Datadog, Logtail, or similar

### Metrics to Monitor

1. **API Response Times**: Should be < 500ms for most endpoints
2. **Error Rate**: Should be < 1%
3. **Database Connection Pool**: Monitor connection usage
4. **Storage Operations**: Monitor R2/MinIO latency
5. **AI API Usage**: Monitor Anthropic/OpenAI rate limits

---

## Rollback Procedures

### Option 1: Vercel

```bash
# List deployments
vercel ls

# Rollback to previous deployment
vercel rollback [deployment-url]
```

### Option 2: Railway

```bash
# List deployments
railway logs

# Rollback via dashboard
# Railway Dashboard → Deployments → Select previous deployment → Redeploy
```

### Option 3: Docker

```bash
# Stop current container
docker stop synap-api

# Start previous image
docker run -d \
  --name synap-api \
  -p 3000:3000 \
  --env-file .env.production \
  synap-backend:previous-version
```

### Option 4: PM2

```bash
# Stop current process
pm2 stop synap-api

# Start previous version
cd /path/to/previous/build
pm2 start apps/api/dist/index.js --name synap-api
```

### Database Rollback

If database migrations need to be rolled back:

```bash
# Manual rollback (if using Drizzle migrations)
cd packages/database
pnpm drizzle-kit drop  # ⚠️ DANGER: Drops all tables
# Then re-run migrations from previous version
```

**⚠️ Warning**: Database rollbacks are destructive. Always backup before deploying.

---

## Troubleshooting

### Common Issues

#### 1. Configuration Validation Fails

**Error**: `Configuration validation failed`

**Solution**:
- Check all required environment variables are set
- Verify variable names match exactly (case-sensitive)
- Run `pnpm tsx scripts/test-system.ts` locally to validate

#### 2. Database Connection Fails

**Error**: `Connection refused` or `timeout`

**Solution**:
- Verify `DATABASE_URL` is correct
- Check database firewall allows your IP
- Verify database is running and accessible
- Test connection: `psql "$DATABASE_URL" -c "SELECT 1;"`

#### 3. Storage Operations Fail

**Error**: `Access denied` or `Bucket not found`

**Solution**:
- Verify R2/MinIO credentials are correct
- Check bucket exists and is accessible
- Verify bucket name matches `R2_BUCKET_NAME` / `MINIO_BUCKET_NAME`
- Test with AWS CLI: `aws s3 ls s3://your-bucket --endpoint-url=https://your-r2-endpoint`

#### 4. AI API Errors

**Error**: `API key invalid` or `Rate limit exceeded`

**Solution**:
- Verify API keys are correct and active
- Check API usage limits in Anthropic/OpenAI dashboards
- Implement rate limiting if needed

#### 5. Build Fails

**Error**: `TypeScript errors` or `Module not found`

**Solution**:
- Run `pnpm install` to ensure dependencies are installed
- Run `pnpm build` locally to identify errors
- Check Node.js version matches (20+)
- Clear build cache: `rm -rf node_modules .turbo`

### Debug Mode

Enable debug logging:

```bash
LOG_LEVEL=debug
```

This will output detailed logs for troubleshooting.

### Support

If issues persist:
1. Check application logs
2. Review error messages (they include error IDs for tracking)
3. Verify all environment variables
4. Test locally with production config
5. Check service status (database, storage, AI APIs)

---

## Security Checklist

Before going live:

- [ ] All secrets are in environment variables (not in code)
- [ ] Database has strong password
- [ ] R2/MinIO credentials are secure
- [ ] API keys are rotated regularly
- [ ] CORS is configured correctly
- [ ] Rate limiting is enabled
- [ ] HTTPS is enforced
- [ ] Security headers are set
- [ ] Error messages don't leak sensitive info
- [ ] Database backups are configured
- [ ] Monitoring alerts are set up

---

## Next Steps

After successful deployment:

1. **Set up monitoring**: Configure alerts for errors, latency, and uptime
2. **Configure backups**: Set up automated database backups
3. **Set up CI/CD**: Automate deployments from git
4. **Performance testing**: Load test your endpoints
5. **Documentation**: Update API documentation with production URLs

---

**🎉 Your Synap Backend is now deployed and ready for production!**

