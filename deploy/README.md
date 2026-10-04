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

## 💾 Data & backups

### Where the data lives (and why it matters)

| Data                                    | Where                                                                                                     | Survives `prune --volumes` / `down -v`? |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Postgres cluster (synap, kratos, hydra) | volume `<project>_postgres_data` mounted at `/home/postgres/pgdata` (`PGDATA=/home/postgres/pgdata/data`) | ❌ no — that is why dumps exist         |
| Daily dumps                             | `deploy/backups/postgres/<UTC>-daily/<db>.dump` (host directory)                                          | ✅ yes                                  |
| Pre-update / manual dumps               | `deploy/backups/postgres/<UTC>-pre-update/…`                                                              | ✅ yes                                  |
| "This pod has data" marker              | `deploy/state/postgres-initialized` (host directory)                                                      | ✅ yes                                  |
| Files / search                          | volumes `minio_data`, `typesense_data`                                                                    | ❌ no — cover them with host backup     |

**2026-10-02 incident.** The volume used to be mounted at `/var/lib/postgresql/data`,
which `timescaledb-ha` does not use. The volume stayed empty and the whole database
lived in the container layer, so one recreate wiped a pod. Four layers now prevent
that — see the header of `pgdata-safety.sh`:

1. `PGDATA` is pinned and the volume is mounted at its parent.
2. Postgres **refuses to start** (exit 78, `FATAL[synap]` in its logs) if that path is
   not a mount, or if `deploy/state/postgres-initialized` exists but the cluster is
   empty. To start blank on purpose: `SYNAP_ALLOW_PG_REINIT=1 docker compose up -d postgres`.
3. Every update/install door (`synap`, `update-pod.sh`, `install.sh`, `eve update synap`)
   runs `pgdata-safety.sh guard` first: a cluster still in a container layer is
   dumped, committed to a `pgdata-rescue/*` image, copied onto the volume and
   verified by row counts before anything is recreated. Updates also take a
   verified `pre-update` dump of every database before migrations.
4. `postgres-backup` dumps every database daily (`PG_BACKUP_INTERVAL_SECONDS`,
   default 86400; keeps `PG_BACKUP_KEEP`, default 7) and turns **unhealthy** when no
   fresh dump exists.

### Commands

```bash
./synap backup [label]                         # every database → backups/postgres/<ts>-<label>/ (+ env.backup)
./synap restore deploy/backups/postgres/<dir>  # restore a dump set (stops writers, pg_restore --clean)
deploy/pgdata-safety.sh layout                 # ok | legacy | absent
docker compose ps postgres-backup              # healthy = a dump newer than 2× the interval exists
```

### Off-host copies (required — the host is a single failure domain)

On-host dumps protect against Docker accidents, not against losing the disk or
the host. Ship `deploy/backups/postgres/` **and** `deploy/.env` (the secrets the
data is encrypted/signed with) off the host — restic to B2/S3, or Proxmox Backup
Server for the whole CT. A restore needs both the dump and the matching `.env`.

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
- **Discord Community**: [discord.gg/xhRdQ7hG5h](https://discord.gg/xhRdQ7hG5h)
- **GitHub Issues**: [github.com/synap-labs/synap-backend/issues](https://github.com/synap-labs/synap-backend/issues)

---

**Made with ❤️ by the Synap team**
