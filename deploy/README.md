# Self-Hosting Synap Backend

Deploy your own Synap instance in 5 minutes with our unified CLI.

## 🚀 Quick Start

### Option 1: Download CLI and Install (Recommended)

```bash
# Download the unified CLI
curl -fsSL https://raw.githubusercontent.com/synap-core/backend/main/synap -o synap
chmod +x synap

# Install (interactive prompts)
./synap install --clone --from-image latest --domain example.com --email me@example.com
```

### Option 2: Clone Repository First

```bash
# Clone repository
git clone https://github.com/synap-core/backend.git
cd backend

# Make CLI executable
chmod +x synap

# Install (use existing repo, no cloning)
./synap install --no-clone --from-image latest --domain example.com --email me@example.com
```

### Option 3: Development Mode (Build from Source)

```bash
# Clone repository
git clone https://github.com/synap-core/backend.git
cd backend
chmod +x synap

# Install and build from source
./synap install --no-clone --from-source --domain localhost
```

## 📋 Requirements

- **Linux server** (Ubuntu 22.04+ recommended)
- **4GB RAM** minimum (8GB recommended)
- **20GB disk space** minimum
- **Docker** & **Docker Compose** installed
- **Domain name** with DNS access (for production)
- **OpenAI API key** (required for AI features)

## 🎯 Installation Options

### Production (Docker Images)

```bash
# Clone repo and use pre-built images
./synap install --clone --from-image latest --domain example.com --email me@example.com
```

### Development (Build from Source)

```bash
# Use existing repo and build locally
./synap install --no-clone --from-source --domain localhost
```

### Automated (Non-Interactive)

```bash
# All parameters provided, no prompts
./synap install --clone --from-image latest --domain example.com --email me@example.com --non-interactive
```

## 🔧 Management

Use the unified `synap` CLI to manage your instance:

```bash
# Check system health
./synap health

# View logs (all services or specific)
./synap logs
./synap logs backend

# Restart services
./synap restart
./synap restart backend

# Start/stop services
./synap start
./synap stop

# Update to latest version
./synap update

# Update to specific version
./synap update v1.2.3

# Build from source
./synap update --build

# Create backup
./synap backup [name]

# Restore from backup
./synap restore backups/backup-20260127.tar.gz

# Manage configuration
./synap config list
./synap config get DOMAIN
./synap config set DOMAIN new-domain.com
./synap config edit
```

## 🆙 Updating

### Standard Update (Pull Image)

```bash
./synap update
```

This will:

1. Create automatic backup
2. Pull latest Docker image from registry
3. Run database migrations
4. Restart services

### Update to Specific Version

```bash
./synap update v1.2.3
```

### Build from Source

```bash
./synap update --build
```

Useful when:

- Image not available in registry
- Testing local changes
- Development workflow

## Single Operational Path

Synap now uses one controlled execution path for pod lifecycle operations:

- CP-managed pods: Control Plane command -> pod-agent -> canonical callback packet
- Operator-managed pods: `synap` CLI only (no legacy fallback installers)
- Terminal failures emit a structured packet (`phase`, `step`, `correlationId`, `errorSummary`, `logsSnippet`)
- Control Plane auto-creates or reuses a deduped ticket per failure fingerprint

If provisioning/update fails, inspect packet metadata first in pod diagnostics, then follow the linked ticket.

## 💾 Backups

### Create Backup

```bash
./synap backup
```

Backups are stored in `./backups/` and include:

- PostgreSQL database dump
- Environment configuration (`.env`)

### Restore from Backup

```bash
./synap restore backups/backup-20260127.tar.gz
```

### Scheduled Backups

Add to crontab for daily backups:

```bash
0 2 * * * cd /opt/synap-backend && ./synap backup >> /var/log/synap-backup.log 2>&1
```

## Docker Compose profiles

All optional services are gated behind Compose profiles. Enable with `--profile NAME`:

| Profile             | Services                                  | When to use                                             |
| ------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `monitoring`        | dozzle, prometheus, grafana, alertmanager | Full observability stack (logs UI + metrics + alerts)   |
| `canary`            | backend-canary                            | Pre-production image validation (used by update-pod.sh) |
| `openclaw`          | openclaw                                  | Self-hosted AI agent                                    |
| `rsshub`            | rsshub, browserless                       | RSS aggregation                                         |
| `cloudflare-tunnel` | cloudflared                               | Expose pod via Cloudflare Tunnel                        |
| `pangolin-tunnel`   | pangolin-tunnel                           | Expose pod via Pangolin                                 |
| `updater`           | updater                                   | One-shot self-update (triggered by update-pod.sh)       |

Example:

```bash
docker compose --profile monitoring --profile openclaw up -d
```

Services with `restart: always` (backend, postgres, etc.) always start by default.

## 📚 Documentation

- **[Installation Guide](./docs/installation.md)** - Detailed installation steps
- **[Configuration Options](./docs/configuration.md)** - All configuration variables
- **[Backup & Restore](./docs/backups.md)** - Backup strategies
- **[Troubleshooting](./docs/troubleshooting.md)** - Common issues and solutions
- **[DevOps Guide](./docs/DEVOPS.md)** - Complete deployment and operations guide

## 🔐 Security

- **Auto-generated secrets**: All passwords and keys generated during installation
- **Automatic SSL**: Let's Encrypt certificates auto-provisioned and renewed
- **Isolated network**: Services communicate via internal Docker network
- **Security headers**: Enforced by Caddy reverse proxy

**Important**: After installation, backup your secrets and delete them from the server!

## 🌐 Connecting Your Frontend

Point your Synap frontend to your self-hosted backend:

```env
# In your frontend .env
NEXT_PUBLIC_API_URL=https://your-domain.com/trpc
NEXT_PUBLIC_REALTIME_URL=https://your-domain.com/realtime
```

## 🐛 Troubleshooting

### Services Won't Start

```bash
# Check health
./synap health

# View logs
./synap logs

# Check Docker
docker compose ps
```

### SSL Certificate Issues

- Ensure DNS is properly configured (A record pointing to your server)
- Wait 1-2 minutes for Let's Encrypt to provision certificate
- Check Caddy logs: `./synap logs caddy`

### Database Connection Errors

- Check PostgreSQL is running: `docker compose ps postgres`
- Verify password in `.env` matches
- Restart backend: `./synap restart backend`

### AI Features Not Working

- Verify `OPENAI_API_KEY` is set in `.env`
- Check intelligence service logs: `./synap logs intelligence-service`

## 💬 Support

- **Documentation**: [docs.synap.live](https://docs.synap.live)
- **Discord Community**: [discord.gg/synap](https://discord.gg/synap)
- **GitHub Issues**: [github.com/synap-labs/synap-backend/issues](https://github.com/synap-labs/synap-backend/issues)

---

**Made with ❤️ by the Synap team**
