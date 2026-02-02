# Hybrid Development Setup

**Run API locally, connect to remote services**

---

## 🎯 Overview

This setup allows you to:

- ✅ Run the API locally on your machine
- ✅ Connect to services running on your server (database, Kratos, etc.)
- ✅ Rapidly iterate on API code without rebuilding Docker images
- ✅ Use real production data for testing
- ✅ Reduce local resource usage (no need to run all services locally)

> **💡 Recommended**: Start with [Progressive Setup](./PROGRESSIVE_SETUP.md) - test locally first, then gradually move to remote services.

---

## 📋 Prerequisites

1. **Server running Synap services** (via Docker Compose)
2. **Network access** to your server
3. **Secrets from server** (database password, Kratos secrets, etc.)

---

## 🚀 Quick Start

### 1. Get Server Information

**SSH into your server** and get the connection details:

```bash
ssh user@your-server
cd /opt/synap-backend/deploy

# View .env file to get secrets
cat .env | grep -E "POSTGRES_PASSWORD|KRATOS_SECRETS|MINIO_ACCESS_KEY|TYPESENSE_API_KEY"
```

**Note down**:

- Server IP or domain
- Database password
- Kratos secrets
- MinIO credentials
- Typesense API keys
- Redis password (if set)

---

### 2. Configure Local Environment

**Option A: Use setup script** (recommended):

```bash
cd synap-backend
./scripts/setup-remote-dev.sh
```

**Option B: Manual setup**:

```bash
cd synap-backend
cp .env.development.remote.example .env.development.remote
```

**Edit `.env.development.remote`**:

```bash
# Set your server host
SERVER_HOST=your-server-ip-or-domain.com

# Update all connection strings
# They will automatically use ${SERVER_HOST}
```

**Get secrets from server** and update:

- `POSTGRES_PASSWORD`
- `KRATOS_SECRETS_COOKIE`
- `KRATOS_SECRETS_CIPHER`
- `KRATOS_WEBHOOK_SECRET`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `TYPESENSE_API_KEY`
- `JWT_SECRET`

---

### 3. Ensure Server Ports Are Accessible

**On your server**, check which ports are exposed:

```bash
# Check docker-compose.yml
cd /opt/synap-backend/deploy
grep -E "ports:|5432|4433|4444|9000|6379|8108" docker-compose.yml
```

**Required ports**:

- `5432` - PostgreSQL
- `4433`, `4434` - Kratos (public, admin)
- `4444`, `4445` - Hydra (public, admin)
- `9000` - MinIO
- `6379` - Redis
- `8108` - Typesense

**Configure firewall** (if needed):

```bash
# On server, allow your IP
sudo ufw allow from YOUR_IP to any port 5432
sudo ufw allow from YOUR_IP to any port 4433
sudo ufw allow from YOUR_IP to any port 4434
sudo ufw allow from YOUR_IP to any port 4444
sudo ufw allow from YOUR_IP to any port 4445
sudo ufw allow from YOUR_IP to any port 9000
sudo ufw allow from YOUR_IP to any port 6379
sudo ufw allow from YOUR_IP to any port 8108
```

---

### 4. Start Local Services

**Start Inngest locally** (for background jobs):

```bash
# In a separate terminal
npx inngest-cli@latest dev
# Inngest will run on http://localhost:8288
```

**Start Local API**:

```bash
# This will load .env.development.remote
pnpm dev:remote
```

**Alternative (manual)**:

```bash
# Load remote config
export $(cat .env.development.remote | xargs)

# Start API
pnpm --filter api dev
```

---

## 🔧 Configuration Details

### Database Connection

**Remote PostgreSQL**:

```env
DATABASE_URL=postgresql://synap:password@server-ip:5432/synap
```

**Verify connection**:

```bash
psql postgresql://synap:password@server-ip:5432/synap -c "SELECT 1;"
```

---

### Kratos Connection

**Public URL** (for frontend):

```env
KRATOS_PUBLIC_URL=http://server-ip:4433
```

**Admin URL** (for backend):

```env
KRATOS_ADMIN_URL=http://server-ip:4434
```

**Verify**:

```bash
curl http://server-ip:4433/health/ready
curl http://server-ip:4434/health/ready
```

---

### MinIO Connection

**Endpoint**:

```env
MINIO_ENDPOINT=http://server-ip:9000
```

**Verify**:

```bash
curl http://server-ip:9000/minio/health/live
```

---

### Redis Connection

**URL**:

```env
REDIS_URL=redis://server-ip:6379
```

**Verify**:

```bash
redis-cli -h server-ip -p 6379 ping
```

---

## 🔒 Security Considerations

### Option 1: Direct Connection (Simple)

**Pros**:

- ✅ Simple setup
- ✅ No additional tools needed

**Cons**:

- ❌ Exposes services to network
- ❌ Requires firewall configuration
- ❌ Less secure

**Use when**: Development on trusted network

---

### Option 2: SSH Tunnels (Recommended)

**Pros**:

- ✅ More secure (encrypted)
- ✅ No need to expose ports publicly
- ✅ Works through firewalls

**Cons**:

- ⚠️ Requires SSH access
- ⚠️ Slightly more complex setup

**Setup**:

```bash
# Create SSH tunnels for all services
ssh -L 5432:localhost:5432 \
    -L 4433:localhost:4433 \
    -L 4434:localhost:4434 \
    -L 4444:localhost:4444 \
    -L 4445:localhost:4445 \
    -L 9000:localhost:9000 \
    -L 6379:localhost:6379 \
    -L 8108:localhost:8108 \
    user@server

# Then use localhost in .env.development.remote
SERVER_HOST=localhost
```

---

### Option 3: VPN (Most Secure)

**Pros**:

- ✅ Most secure
- ✅ Full network access
- ✅ No port forwarding needed

**Cons**:

- ❌ Requires VPN setup
- ❌ More complex infrastructure

**Use when**: Enterprise setup or multiple developers

---

## 🐛 Troubleshooting

### Connection Refused

**Problem**: Can't connect to server services

**Check**:

1. Is server running? `ssh server "docker compose ps"`
2. Are ports exposed? Check `docker-compose.yml`
3. Is firewall blocking? Check `sudo ufw status`
4. Can you ping server? `ping server-ip`

**Solution**:

- Verify ports in `docker-compose.yml`
- Check firewall rules
- Test connection: `telnet server-ip 5432`

---

### Authentication Failed

**Problem**: Database/Kratos authentication fails

**Check**:

1. Are credentials correct? Compare with server `.env`
2. Is user allowed? Check PostgreSQL `pg_hba.conf`
3. Are secrets matching? Kratos needs exact secrets

**Solution**:

- Double-check all secrets match server `.env`
- Verify database user exists: `psql -U synap -d synap -c "SELECT 1;"`

---

### Slow Performance

**Problem**: API is slow when connecting to remote services

**Causes**:

- Network latency
- Firewall rules
- Server resource constraints

**Solutions**:

- Use SSH tunnels (reduces latency)
- Check network speed: `ping server-ip`
- Monitor server resources: `htop` on server

---

## 📝 Example Workflow

### Daily Development

1. **Start SSH tunnels** (if using):

   ```bash
   ./scripts/ssh-tunnel.sh
   ```

2. **Start local API**:

   ```bash
   pnpm dev:remote
   ```

3. **Make changes** to API code

4. **See changes immediately** (hot reload)

5. **Test with real data** from server

---

## 🔄 Switching Between Local and Remote

### Use Remote Services

```bash
# Load remote config
export $(cat .env.development.remote | xargs)
pnpm --filter api dev
```

### Use Local Services

```bash
# Load local config (if exists)
export $(cat .env.development.local | xargs)
# Or use default .env
pnpm --filter api dev
```

---

## 📚 Related Documentation

- **[Docker Compose Setup](./DOCKER.md)** - Server services configuration
- **[Environment Variables](../deploy/docs/configuration.md)** - All configuration options
- **[Development Guide](../DEVELOPER_GUIDE.md)** - General development workflow

---

## ✅ Checklist

- [ ] Server services running (Docker Compose)
- [ ] Ports accessible from your machine
- [ ] `.env.development.remote` configured
- [ ] Secrets copied from server
- [ ] SSH tunnels set up (if using)
- [ ] Local API starts successfully
- [ ] Can connect to database
- [ ] Can connect to Kratos
- [ ] Can connect to MinIO
- [ ] API responds to requests

---

**Last Updated**: 2026-02-02
