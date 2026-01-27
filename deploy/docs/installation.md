# Installation Guide

Complete guide to installing Synap Backend on your server.

## Prerequisites

Before you begin, ensure you have:

### Server Requirements

- **Operating System**: Ubuntu 22.04 LTS or newer (Debian-based recommended)
- **CPU**: 2+ cores (4+ recommended)
- **RAM**: 4GB minimum (8GB recommended)
- **Disk**: 20GB minimum (50GB+ recommended for production)
- **Network**: Public IP address or port forwarding configured

### Software Requirements

- **Docker**: Version 20.10 or newer
- **Docker Compose**: Version 2.0 or newer

### External Requirements

- **Domain Name**: A domain you control with DNS access
- **OpenAI API Key**: Required for AI features ([Get one here](https://platform.openai.com/api-keys))

## Installation Methods

### Method 1: One-Command Install (Recommended)

The fastest way to get started:

```bash
curl -fsSL https://get.synap.live/install.sh | bash
```

This will:

1. Check prerequisites
2. Prompt for configuration
3. Generate secure secrets
4. Download and start services
5. Run database migrations

**Follow the interactive prompts** to configure your instance.

### Method 2: Manual Installation

For more control over the installation process:

#### Step 1: Install Docker

If Docker isn't installed:

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

#### Step 2: Clone Repository

```bash
cd /opt
sudo git clone https://github.com/synap-labs/synap-backend.git synap
cd synap/deploy
```

#### Step 3: Configure Environment

```bash
# Copy template
cp .env.example .env

# Edit configuration
nano .env
```

**Required variables**:

- `DOMAIN`: Your domain (e.g., `synap.example.com`)
- `LETSENCRYPT_EMAIL`: Your email for SSL certificates
- `OPENAI_API_KEY`: Your OpenAI API key

**Generate secrets**:

```bash
# PostgreSQL password
openssl rand -base64 32 | tr -d "=+/" | cut -c1-32

# JWT secret
openssl rand -base64 64 | tr -d "=+/" | cut -c1-64

# Other secrets (repeat for each)
openssl rand -base64 32 | tr -d "=+/" | cut -c1-32
```

#### Step 4: Start Services

```bash
docker compose up -d
```

#### Step 5: Run Migrations

```bash
docker compose exec backend sh -c 'cd packages/database && pnpm db:push'
```

## Post-Installation

### 1. Configure DNS

Add an A record pointing your domain to your server's IP:

```
Type: A
Name: synap (or @)
Value: YOUR_SERVER_IP
TTL: 300
```

**Wait 5-10 minutes** for DNS to propagate.

### 2. Verify SSL Certificate

Check if SSL is working:

```bash
curl https://your-domain.com/health
```

If you get an SSL error, wait a few more minutes. Let's Encrypt can take 1-2 minutes to provision certificates.

### 3. Check System Health

```bash
./synap-cli health
```

You should see all services marked as ✅ healthy.

### 4. Backup Secrets

**CRITICAL**: Save your secrets file and delete it from the server:

```bash
# On your local machine
scp user@server:/opt/synap/.secrets-backup.txt ~/synap-secrets.txt

# On the server
rm /opt/synap/.secrets-backup.txt
```

Store this file securely (password manager, encrypted storage, etc.).

### 5. Create First User

Visit your domain in a browser:

```
https://your-domain.com
```

You'll see the first-run setup wizard. Create your admin account and first workspace.

## Verification

### Check All Services

```bash
./synap-cli health
```

Expected output:

```
✅ Backend API
✅ Intelligence Service
✅ Database
✅ Redis
✅ Storage
✅ Search
✅ Authentication
✅ OAuth2
✅ Reverse Proxy
```

### Test API

```bash
curl https://your-domain.com/health
```

Expected response:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "services": {
    "database": "connected",
    "redis": "connected",
    "storage": "connected",
    "ai": "connected"
  }
}
```

### View Logs

```bash
./synap-cli logs
```

Look for any errors or warnings.

## Troubleshooting

### Services Won't Start

```bash
# Check Docker daemon
sudo systemctl status docker

# Check logs
docker compose logs

# Restart services
docker compose restart
```

### SSL Certificate Issues

**Symptoms**: Browser shows "Not Secure" or certificate errors

**Solutions**:

1. Verify DNS is configured correctly: `dig your-domain.com`
2. Wait 2-5 minutes for Let's Encrypt
3. Check Caddy logs: `./synap-cli logs caddy`
4. Ensure ports 80 and 443 are open in firewall

### Database Connection Errors

**Symptoms**: Backend logs show "connection refused" or "authentication failed"

**Solutions**:

1. Check PostgreSQL is running: `docker compose ps postgres`
2. Verify password in `.env` matches
3. Restart backend: `./synap-cli restart backend`

### AI Features Not Working

**Symptoms**: AI responses fail or timeout

**Solutions**:

1. Verify `OPENAI_API_KEY` is set in `.env`
2. Check intelligence service: `./synap-cli logs intelligence-service`
3. Test API key: `curl https://api.openai.com/v1/models -H "Authorization: Bearer YOUR_KEY"`

### Port Already in Use

**Symptoms**: "port is already allocated" error

**Solutions**:

```bash
# Find what's using port 80/443
sudo lsof -i :80
sudo lsof -i :443

# Stop conflicting service (e.g., nginx)
sudo systemctl stop nginx
sudo systemctl disable nginx
```

## Next Steps

- [Configure your instance](./configuration.md)
- [Set up backups](./backups.md)
- [Connect your frontend](./frontend-connection.md)
- [Invite team members](./user-management.md)

## Getting Help

- **Documentation**: [docs.synap.live](https://docs.synap.live)
- **Discord**: [discord.gg/synap](https://discord.gg/synap)
- **GitHub Issues**: [github.com/synap-labs/synap-backend/issues](https://github.com/synap-labs/synap-backend/issues)
