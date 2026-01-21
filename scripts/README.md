# Production Deployment Scripts

## 📋 Overview

Two-script deployment system for Synap Backend:

1. **`setup-production.sh`** - Interactive configuration generator
2. **`start.sh`** - Service launcher with validation

---

## 🚀 Quick Start

### On Server

```bash
# 1. Copy scripts to server
scp scripts/setup-production.sh root@<server-ip>:/srv/synap/
scp scripts/start.sh root@<server-ip>:/srv/synap/

# 2. SSH into server
ssh root@<server-ip>

# 3. Make executable
cd /srv/synap
chmod +x setup-production.sh start.sh

# 4. Run setup (interactive)
./setup-production.sh

# 5. Start services
./start.sh
```

---

## 📝 Script 1: setup-production.sh

### What It Does

- ✅ Prompts for deployment mode (demo/production)
- ✅ Asks for domain configuration
- ✅ Generates all secrets automatically (passwords, JWT, etc.)
- ✅ Prompts for API keys (OpenAI, Stripe, etc.)
- ✅ Creates 3 .env files:
  - `/srv/synap/.env` (root, for docker-compose)
  - `/srv/synap/synap-backend/.env.production`
  - `/srv/synap/intelligence-service/.env.production`
- ✅ Creates backup file with all secrets
- ✅ Sets correct permissions (600)

### Interactive Prompts

```
1. Deployment Mode
   - Demo (shared backend)
   - Production (per-user backends)

2. Domain Configuration
   - Base domain (demo.synap.live or synap.live)

3. API Keys
   - OpenAI API Key (required)
   - Anthropic API Key (optional)
   - Google AI API Key (optional)
   - Stripe keys (required for production)

4. Cloud Providers (production only)
   - Hetzner API Token
   - OVH credentials
```

### Generated Files

```
/srv/synap/
├── .env                                    # Root env (docker-compose)
├── .secrets-backup.txt                     # All secrets (BACKUP & DELETE)
├── synap-backend/.env.production           # Backend config
└── intelligence-service/.env.production    # AI service config
```

### Example Run

```bash
$ ./setup-production.sh

╔════════════════════════════════════════╗
║  Synap Backend Production Setup       ║
╚════════════════════════════════════════╝

🚀 Deployment Mode
1) Demo Mode
2) Production Mode
Select mode (1/2): 1
✓ Demo mode selected

🌐 Domain Configuration
Enter demo domain (default: demo.synap.live):
✓ Backend URL: https://backend.demo.synap.live

🔐 Generating Secure Secrets...
✓ All secrets generated

🔑 API Keys Configuration
OpenAI API Key: sk-proj-...
Anthropic API Key (optional):
✓ API keys collected

📋 Configuration Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Deployment Mode: demo
Backend URL: https://backend.demo.synap.live
OpenAI: sk-proj-XX...
Continue? (y/n): y

📁 Creating directory structure...
✓ Directories created

📝 Creating root .env file...
✓ Root .env created

📝 Creating backend .env.production...
✓ Backend .env.production created

📝 Creating intelligence-service .env.production...
✓ Intelligence Service .env.production created

✅ Setup Complete!

📋 Next Steps:
  1. Review generated .env files
  2. Copy .secrets-backup.txt to secure location
  3. Delete .secrets-backup.txt from server
  4. Run: ./start.sh
```

---

## 📝 Script 2: start.sh

### What It Does

- ✅ Validates .env files exist
- ✅ Checks required environment variables
- ✅ Verifies Docker is running
- ✅ Shows configuration summary
- ✅ Asks for confirmation
- ✅ Pulls Docker images
- ✅ Builds services
- ✅ Starts containers
- ✅ Waits for health checks
- ✅ Shows service status
- ✅ Displays next steps

### Example Run

```bash
$ ./start.sh

╔════════════════════════════════════════╗
║    Synap Backend - Start Services     ║
╚════════════════════════════════════════╝

🔍 Verifying Configuration...
✓ All required variables present
✓ Docker is running

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Configuration:
  Mode: demo
  Database: PostgreSQL
  Search: Typesense
  Storage: MinIO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Start all services? (y/n): y

🚀 Starting Services...

📦 Pulling Docker images...
▶️  Starting containers...
✓ Services started

⏳ Waiting for services to be healthy...
Checking PostgreSQL... ✓
Checking Typesense... ✓
Checking MinIO... ✓
Checking Backend... ✓
Checking Intelligence Service... ✓

✅ Deployment Complete!

📊 Service Status:
NAME                    STATUS    PORTS
synap-postgres-1        Up        5432
synap-backend-1         Up        4000
synap-intelligence-1    Up        3001
...

📋 Next Steps:
  1. Run database migrations
  2. Seed demo workspace (if demo mode)
  3. Check logs for errors
```

---

## 🔧 Workflow Integration

### First Time Setup

```bash
# 1. Clone repositories on server
cd /srv/synap
git clone git@github.com:Synap-core/backend.git synap-backend
git clone git@github.com:Synap-core/intelligence-hub.git intelligence-service

# 2. Copy scripts
cd synap-backend
cp scripts/setup-production.sh /srv/synap/
cp scripts/start.sh /srv/synap/

# 3. Run setup
cd /srv/synap
chmod +x setup-production.sh start.sh
./setup-production.sh

# 4. Backup secrets
scp /srv/synap/.secrets-backup.txt local-machine:~/synap-secrets/
rm /srv/synap/.secrets-backup.txt

# 5. Start services
./start.sh

# 6. Run migrations
docker compose exec backend sh -c 'cd packages/database && pnpm db:migrate'

# 7. Verify
curl https://backend.demo.synap.live/health
```

### Update Deployment

```bash
# 1. Pull latest code
cd /srv/synap/synap-backend
git pull origin main

cd /srv/synap/intelligence-service
git pull origin main

# 2. Rebuild and restart
cd /srv/synap
docker compose build
docker compose up -d
```

### Re-run Setup (if needed)

```bash
# If you want to regenerate configs
cd /srv/synap
./setup-production.sh

# This will overwrite existing .env files
# Backup current .env first if needed:
cp .env .env.backup
```

---

## 🔐 Security Notes

### Secrets Backup

The `.secrets-backup.txt` file contains ALL secrets:

- **DO**: Copy to secure password manager
- **DO**: Store offline backup
- **DON'T**: Leave on server
- **DON'T**: Commit to git

```bash
# After setup, immediately backup and delete
scp /srv/synap/.secrets-backup.txt local-machine:~/
rm /srv/synap/.secrets-backup.txt
```

### File Permissions

All .env files are created with `chmod 600` (owner read/write only):

```bash
-rw------- 1 root root .env
-rw------- 1 root root synap-backend/.env.production
-rw------- 1 root root intelligence-service/.env.production
```

### Environment Variables

Never expose via:

- Logs
- Error messages
- API responses
- Git commits

---

## 🐛 Troubleshooting

### "Missing required environment variables"

```bash
# Check if setup was run
ls -la /srv/synap/.env

# Re-run if missing
./setup-production.sh
```

### "Docker is not running"

```bash
# Start Docker
systemctl start docker

# Enable on boot
systemctl enable docker
```

### "Service health check failed"

```bash
# Check logs
docker compose logs backend
docker compose logs intelligence-service

# Restart specific service
docker compose restart backend
```

### "Port already in use"

```bash
# Check what's using the port
lsof -i :4000

# Stop conflicting service or change port in .env
```

---

## 📋 Checklist

### Before Running

- [ ] Server has Docker installed
- [ ] Repositories cloned to /srv/synap
- [ ] Have API keys ready (OpenAI, Stripe, etc.)
- [ ] DNS configured (for production)

### After Setup

- [ ] Review generated .env files
- [ ] Backup .secrets-backup.txt
- [ ] Delete .secrets-backup.txt from server
- [ ] Start services with ./start.sh
- [ ] Run database migrations
- [ ] Test health endpoints

### Production Checklist

- [ ] Stripe webhooks configured
- [ ] Cloud provider APIs configured (Hetzner/OVH)
- [ ] DNS automation configured (Namecheap)
- [ ] SSL certificates (Caddy auto)
- [ ] Monitoring configured
- [ ] Backups configured

---

## 🎯 Summary

**Two scripts, complete deployment:**

1. `setup-production.sh` → Generates all configs (run once)
2. `start.sh` → Starts Docker services (run anytime)

**Benefits:**

- ✅ No manual .env editing
- ✅ Secure secret generation
- ✅ Interactive and guided
- ✅ Validation before start
- ✅ Clear next steps
- ✅ Reusable and consistent
