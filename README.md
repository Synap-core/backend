# Synap Backend

**Open-source, self-hostable knowledge management and AI-powered workspace platform.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=flat&logo=docker&logoColor=white)](https://hub.docker.com/r/synap/backend)
[![Discord](https://img.shields.io/discord/YOUR_DISCORD_ID?color=7289da&label=Discord&logo=discord&logoColor=white)](https://discord.gg/synap)

---

## 🚀 Quick Start

Deploy your own Synap instance in 5 minutes:

```bash
# Download and run the installer
curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/deploy/install.sh -o install.sh
chmod +x install.sh
./install.sh
```

Or clone and run:

```bash
git clone https://github.com/Synap-core/backend.git
cd backend/deploy
chmod +x install.sh
./install.sh
```

Follow the interactive prompts to configure your instance.

## ✨ Features

- **🧠 AI-Powered Intelligence**: Built-in AI agents with OpenAI, Anthropic, and Google AI support
- **📊 Knowledge Graph**: Automatic relationship discovery and entity management
- **🔍 Semantic Search**: Powered by Typesense for lightning-fast full-text search
- **🔐 Enterprise Auth**: Ory Kratos + Hydra for secure authentication and OAuth2
- **📁 File Storage**: MinIO-based object storage with S3 compatibility
- **⚡ Real-time Collaboration**: Server-Sent Events for live updates
- **🔄 Background Jobs**: Inngest-powered job processing
- **🐳 Docker-First**: One-command deployment with Docker Compose

## 📋 Requirements

- **Server**: Linux (Ubuntu 22.04+ recommended)
- **Resources**: 4GB RAM minimum, 20GB disk space
- **Software**: Docker & Docker Compose
- **Domain**: With DNS access for SSL
- **API Key**: OpenAI API key (required for AI features)

## 📚 Documentation

- **[Self-Hosting Guide](./deploy/README.md)** - Complete installation and setup
- **[Configuration Reference](./deploy/docs/configuration.md)** - All configuration options
- **[Backup & Restore](./deploy/docs/backups.md)** - Data protection strategies
- **[Troubleshooting](./deploy/docs/troubleshooting.md)** - Common issues and solutions
- **[API Documentation](https://docs.synap.live/api)** - API reference
- **[Architecture](./ARCHITECTURE.md)** - System architecture overview
- **[Developer Guide](./DEVELOPER_GUIDE.md)** - Contributing and development

## 🛠️ Management

Use the `synap-cli` tool to manage your instance:

```bash
cd /opt/synap  # or your installation directory

# Check system health
./synap-cli health

# View logs
./synap-cli logs

# Create backup
./synap-cli backup

# Update to latest version
./synap-cli update
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Synap Backend                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │   Backend    │  │ Intelligence │  │   Realtime   │ │
│  │   (tRPC)     │  │   Service    │  │     (SSE)    │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  PostgreSQL  │  │    Redis     │  │    MinIO     │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  Typesense   │  │ Ory Kratos   │  │  Ory Hydra   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│                                                         │
│  ┌─────────────────────────────────────────────────┐  │
│  │         Caddy (Reverse Proxy + SSL)             │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 🔐 Security

- **Automatic SSL**: Let's Encrypt certificates auto-provisioned and renewed
- **Secure Secrets**: All secrets auto-generated during installation
- **Isolated Network**: Services communicate via internal Docker network
- **Security Headers**: Enforced by Caddy reverse proxy
- **OAuth2 Ready**: Built-in OAuth2 provider via Ory Hydra

## 🆙 Updates

Update to the latest version with one command:

```bash
./synap-cli update
```

This automatically:

1. Creates a backup
2. Pulls latest Docker images
3. Restarts services
4. Runs database migrations

## 💾 Backups

```bash
# Create backup
./synap-cli backup

# Restore from backup
./synap-cli restore backups/backup-20260127.tar.gz

# Automated daily backups (add to crontab)
0 2 * * * cd /opt/synap && ./synap-cli backup
```

## 🌐 Connect Your Frontend

Point your Synap frontend to your self-hosted backend:

```env
# In your frontend .env
NEXT_PUBLIC_API_URL=https://your-domain.com/trpc
NEXT_PUBLIC_REALTIME_URL=https://your-domain.com/realtime
```

## 🧑‍💻 Development

### Local Development

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your configuration

# Start development services
docker compose -f docker-compose.yml up -d postgres redis minio typesense

# Run database migrations
cd packages/database
pnpm db:push

# Start backend
pnpm dev
```

### Project Structure

```
synap-backend/
├── apps/
│   ├── api/              # Main tRPC API server
│   └── admin-ui/         # Admin dashboard
├── packages/
│   ├── database/         # Drizzle ORM schema & migrations
│   ├── api/              # tRPC routers
│   ├── core/             # Core utilities
│   ├── jobs/             # Background jobs (Inngest)
│   ├── search/           # Typesense integration
│   └── realtime/         # SSE server
├── deploy/               # Self-hosting deployment files
│   ├── install.sh        # One-command installer
│   ├── synap-cli         # Management CLI
│   ├── docker-compose.yml
│   └── docs/             # Documentation
└── docs/                 # Development documentation
```

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

### Development Workflow

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📄 License

MIT License - see [LICENSE](./LICENSE) for details.

## 💬 Community & Support

- **Documentation**: [docs.synap.live](https://docs.synap.live)
- **Discord**: [discord.gg/synap](https://discord.gg/synap)
- **GitHub Issues**: [Report bugs](https://github.com/synap-labs/synap-backend/issues)
- **GitHub Discussions**: [Ask questions](https://github.com/synap-labs/synap-backend/discussions)

## 🙏 Acknowledgments

Built with:

- [tRPC](https://trpc.io/) - End-to-end typesafe APIs
- [Drizzle ORM](https://orm.drizzle.team/) - TypeScript ORM
- [Ory](https://www.ory.sh/) - Authentication & authorization (Kratos + Hydra)
- [Typesense](https://typesense.org/) - Fast search engine
- [Inngest](https://www.inngest.com/) - Background jobs
- [Caddy](https://caddyserver.com/) - Automatic HTTPS
- [Hono](https://hono.dev/) - Web framework
- [PostgreSQL](https://www.postgresql.org/) - Database (with TimescaleDB & pgvector)
- [MinIO](https://min.io/) - Object storage
- [Redis](https://redis.io/) - Caching & sessions

---

**Made with ❤️ by the Synap team**

[⭐ Star us on GitHub](https://github.com/synap-labs/synap-backend) | [🐦 Follow on Twitter](https://twitter.com/synap_live)
