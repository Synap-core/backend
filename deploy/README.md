# Self-Hosting Synap Backend

Deploy your own Synap instance in 5 minutes.

## 🚀 Quick Start

**Recommended: Download first, then execute (most reliable):**

```bash
# Download the installer
curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/deploy/install.sh -o install.sh

# Make it executable
chmod +x install.sh

# Run it
./install.sh
```

**Or clone and run (best for development):**

```bash
git clone https://github.com/Synap-core/backend.git
cd backend/deploy
chmod +x install.sh
./install.sh
```

**Quick method (piping - less reliable, but works):**

```bash
curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/deploy/install.sh | bash
```

> ⚠️ **Note**: Piping can sometimes cause parsing issues. If you encounter errors, download the script first instead.

That's it! Follow the interactive prompts.

## 📋 Requirements

- **Linux server** (Ubuntu 22.04+ recommended)
- **4GB RAM** minimum (8GB recommended)
- **20GB disk space** minimum
- **Docker** & **Docker Compose** installed
- **Domain name** with DNS access
- **OpenAI API key** (required for AI features)

## 🛠️ Manual Installation

If you prefer to install manually:

1. **Clone the repository**:

   ```bash
   git clone https://github.com/synap-labs/synap-backend.git
   cd synap-backend/deploy
   ```

2. **Copy environment template**:

   ```bash
   cp .env.example .env
   ```

3. **Edit `.env` file**:
   - Set your `DOMAIN`
   - Set your `LETSENCRYPT_EMAIL`
   - Add your `OPENAI_API_KEY`
   - Generate secrets (or let the setup script do it)

4. **Run setup script**:
   ```bash
   ./install.sh
   ```

## 🎯 What You Get

- ✅ **Full Synap backend** with all features
- ✅ **AI-powered intelligence** service
- ✅ **Automatic SSL** certificates (Let's Encrypt)
- ✅ **PostgreSQL database** for data storage
- ✅ **MinIO object storage** for files
- ✅ **Typesense search** engine
- ✅ **Ory authentication** (Kratos + Hydra)
- ✅ **Automatic backups** via CLI
- ✅ **Easy updates** with one command

## 📚 Documentation

- [Installation Guide](./docs/installation.md)
- [Configuration Options](./docs/configuration.md)
- [Backup & Restore](./docs/backups.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [API Reference](https://docs.synap.live/api)

  [API Reference](https://docs.synap.live/api)

## 👀 Monitoring & Debugging

For better observability of your self-hosted instance, we recommend the following tools:

### Dozzle (Log Viewer)

We include a pre-configured [Dozzle](https://dozzle.dev/) instance in our Docker Compose setup. It provides a real-time log viewer for all your containers.

To enable it, run:

```bash
docker compose --profile monitoring up -d
```

Access the dashboard at `http://your-server-ip:8888`.

### Dockge (Management UI)

For a complete management interface for your Docker Compose stacks, we highly recommend [Dockge](https://dockge.kuma.pet/). It's a lightweight, reactive alternative to Portainer that works perfectly with our `compose.yaml` file structure.

1. Install Dockge following their [official guide](https://github.com/louislam/dockge#install).
2. Point it to your `synap-backend/deploy` directory.
3. You'll get a full UI to manage, update, and monitor your Synap stack.

## 🔧 Management

Use the `synap-cli` tool to manage your instance:

```bash
# Check system health
./synap-cli health

# View logs
./synap-cli logs

# Restart services
./synap-cli restart

# Update to latest version
./synap-cli update

# Create backup
./synap-cli backup

# Restore from backup
./synap-cli restore backups/backup-20260127.tar.gz
```

## 🔐 Security

- All secrets are auto-generated during installation
- SSL certificates are automatically provisioned and renewed
- Database and storage are isolated in Docker network
- Security headers are enforced by Caddy reverse proxy

**Important**: After installation, backup your `.secrets-backup.txt` file and delete it from the server!

## 🆙 Updating

Update to the latest version with one command:

```bash
./synap-cli update
```

This will:

1. Create an automatic backup
2. Pull latest Docker images
3. Restart services
4. Run database migrations

## 💾 Backups

### Automatic Backups

Create a backup:

```bash
./synap-cli backup
```

Backups are stored in `./backups/` and include:

- PostgreSQL database dump
- Environment configuration

### Restore

```bash
./synap-cli restore backups/backup-20260127.tar.gz
```

### Scheduled Backups

Add to crontab for daily backups:

```bash
0 2 * * * cd /opt/synap && ./synap-cli backup >> /var/log/synap-backup.log 2>&1
```

## 🌐 Connecting Your Frontend

Point your Synap frontend to your self-hosted backend:

```env
# In your frontend .env
NEXT_PUBLIC_API_URL=https://your-domain.com/trpc
NEXT_PUBLIC_REALTIME_URL=https://your-domain.com/realtime
```

## 🐛 Troubleshooting

### Services won't start

```bash
# Check logs
./synap-cli logs

# Check Docker
docker compose ps
```

### SSL certificate issues

- Ensure DNS is properly configured (A record pointing to your server)
- Wait 1-2 minutes for Let's Encrypt to provision certificate
- Check Caddy logs: `./synap-cli logs caddy`

### Database connection errors

- Check PostgreSQL is running: `docker compose ps postgres`
- Verify password in `.env` matches what's in Docker

### AI features not working

- Verify `OPENAI_API_KEY` is set in `.env`
- Check intelligence service logs: `./synap-cli logs intelligence-service`

## 💬 Support

- **Documentation**: [docs.synap.live](https://docs.synap.live)
- **Discord Community**: [discord.gg/synap](https://discord.gg/synap)
- **GitHub Issues**: [github.com/synap-labs/synap-backend/issues](https://github.com/synap-labs/synap-backend/issues)

## 📄 License

MIT License - see [LICENSE](../LICENSE) for details

## 🙏 Contributing

We welcome contributions! See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

---

**Made with ❤️ by the Synap team**
