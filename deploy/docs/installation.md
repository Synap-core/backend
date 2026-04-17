# Installation Guide

Complete guide to installing Synap Backend on your server.

## Prerequisites

### Server Requirements

- **Operating System**: Ubuntu 22.04 LTS or newer (Debian-based recommended)
- **CPU**: 2+ cores (4+ recommended)
- **RAM**: 4GB minimum (8GB recommended)
- **Disk**: 20GB minimum (50GB+ recommended for production)
- **Network**: Public IP address or port forwarding configured

### Software Requirements

- **Docker**: Version 20.10 or newer
- **Docker Compose**: Version 2.0 or newer

Install Docker if needed:

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

### External Requirements

- **Domain Name**: A domain you control with DNS access (for production)
- **OpenAI API Key**: Required for AI features ([Get one here](https://platform.openai.com/api-keys))

## Installation Methods

### Method 1: Quick Install (Recommended)

The fastest way to get started:

```bash
# Download unified CLI
curl -fsSL https://raw.githubusercontent.com/synap-core/backend/main/synap -o synap
chmod +x synap

# Install (interactive mode)
./synap install --clone --from-image latest --domain example.com --email me@example.com
```

This will:

1. Clone the repository
2. Generate secure secrets
3. Create configuration
4. Pull Docker images
5. Start all services
6. Run database migrations

### Method 2: Clone Repository First

For developers or if you want to review the code:

```bash
# Clone repository
git clone https://github.com/synap-core/backend.git
cd backend

# Make CLI executable
chmod +x synap

# Install (use existing repo)
./synap install --no-clone --from-image latest --domain example.com --email me@example.com
```

### Method 3: Development Mode (Build from Source)

For testing or development:

```bash
# Clone repository
git clone https://github.com/synap-core/backend.git
cd backend
chmod +x synap

# Install and build from source
./synap install --no-clone --from-source --domain localhost
```

## Installation Parameters

### Required Parameters

- `--domain <domain>` - Your domain name (or `localhost` for testing)
- `--email <email>` - Email for SSL certificates (required for production domains)

### Optional Parameters

- `--clone` - Clone repository (default if not in git repo)
- `--no-clone` / `--use-repo` - Use existing repository
- `--from-image <tag>` - Use Docker image (default: `latest`)
- `--from-source` / `--build` - Build from source code
- `--dir <path>` - Installation directory (default: `/opt/synap-backend`)
- `--non-interactive` - Automated mode (no prompts)

### Examples

```bash
# Production: Clone + Image
./synap install --clone --from-image latest --domain example.com --email me@example.com

# Production: Use existing repo + Image
./synap install --no-clone --from-image latest --domain example.com --email me@example.com

# Development: Use existing repo + Build
./synap install --no-clone --from-source --domain localhost

# Automated (no prompts)
./synap install --clone --from-image latest --domain example.com --email me@example.com --non-interactive
```

## Post-Installation

### 1. Configure DNS (Production Only)

Add an A record pointing your domain to your server's IP:

```
Type: A
Name: @ (or subdomain like 'synap')
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
./synap health
```

You should see all services marked as ✅ healthy.

### 4. Backup Secrets

**CRITICAL**: Save your secrets and delete them from the server:

```bash
# The installation creates a secrets backup file
# Copy it to your local machine
scp user@server:/opt/synap-backend/synap-backend-secrets.txt ~/synap-secrets.txt

# Delete from server
rm /opt/synap-backend/synap-backend-secrets.txt
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
./synap health
```

Expected output:

```
✅ Backend API
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
./synap logs
```

Look for any errors or warnings.

## Failure Triage Flow

Provisioning and update failures use one terminal failure path:

1. Pod command finishes with terminal failure.
2. Pod-agent sends a canonical failure packet callback.
3. Control Plane persists the failure packet and links it to pod diagnostics.
4. Control Plane auto-creates (or dedupes) a ticket using packet fingerprint + pod.

Operator runbook:

- Open pod detail in Control Plane and review the latest failure packet.
- Use `correlationId`, `phase`, `step`, and `logsSnippet` from the packet as primary debug context.
- Continue triage in the linked auto-ticket (or existing deduped open ticket).

## Troubleshooting

### Services Won't Start

```bash
# Check Docker daemon
sudo systemctl status docker

# Check logs
./synap logs

# Restart services
./synap restart
```

### SSL Certificate Issues

**Symptoms**: Browser shows "Not Secure" or certificate errors

**Solutions**:

1. Verify DNS is configured correctly: `dig your-domain.com`
2. Wait 2-5 minutes for Let's Encrypt
3. Check Caddy logs: `./synap logs caddy`
4. Ensure ports 80 and 443 are open in firewall

### Database Connection Errors

**Symptoms**: Backend logs show "connection refused" or "authentication failed"

**Solutions**:

1. Check PostgreSQL is running: `docker compose ps postgres`
2. Verify password in `.env` matches
3. Restart backend: `./synap restart backend`

### AI Features Not Working

**Symptoms**: AI responses fail or timeout

**Solutions**:

1. Verify `OPENAI_API_KEY` is set in `.env`
2. Check intelligence service: `./synap logs intelligence-service`
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
- [Connect your frontend](../README.md#-connecting-your-frontend)
- [Update your instance](../README.md#-updating)

## Getting Help

- **Documentation**: [docs.synap.live](https://docs.synap.live)
- **Discord**: [discord.gg/synap](https://discord.gg/synap)
- **GitHub Issues**: [github.com/synap-labs/synap-backend/issues](https://github.com/synap-labs/synap-backend/issues)
