# Synap Backend

**Open-Source AI-Powered Personal Data Pod**

> Event-sourced backend with semantic search, knowledge graphs, and intelligent assistance

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E=22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

---

## 🎯 Quick Start

```bash
# Install dependencies
pnpm install

# Start PostgreSQL + MinIO
docker compose up -d

# Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL, OPENAI_API_KEY, etc.

# Run migrations
pnpm db:migrate

# Start development
pnpm dev
```

**Verify**: Visit http://localhost:3000/health

---

## 📚 Documentation

**Complete documentation**: https://docs.synap.sh

- [Getting Started](https://docs.synap.sh/getting-started) - Installation & setup
- [Architecture](https://docs.synap.sh/architecture) - System design & patterns
- [Development](https://docs.synap.sh/development) - SDK & contribution guide
- [API Reference](https://docs.synap.sh/reference) - Complete API docs
- [Deployment](https://docs.synap.sh/deployment) - Production setup

---

## 🔧 Development Commands

```bash
# Development
pnpm dev                    # Start all services
pnpm build                  # Build all packages
pnpm test                   # Run tests

# Database
pnpm db:migrate             # Apply migrations
pnpm db:studio              # Open Drizzle Studio

# Docker
docker compose up -d        # Start PostgreSQL + MinIO
docker compose logs -f      # View logs
```

---

## 📦 Package Structure

```
packages/
├── api/            # Fastify HTTP API + tRPC
├── core/           # Shared utilities & config
├── database/       # Drizzle ORM & migrations
├── domain/         # Business logic services
├── jobs/           # Background jobs (Inngest)
├── storage/        # File storage (MinIO/R2)
├── ai/             # AI agent & LangGraph
└── client/         # TypeScript SDK
```

---

## 🛠️ Technical Implementation Guides

For implementation-specific details not covered in the main docs:

- **[API Keys Implementation](./docs/api/API_KEYS.md)** - Technical API key setup
- **[Docker Setup](./docs/architecture/DOCKER.md)** - Docker Compose configuration
- **[Deployment Guides](./docs/deployment/)** - Self-hosting & production
- **[Development Guides](./docs/development/)** - Contributing & extensibility
- **[Integrations](./docs/integrations/)** - N8N, webhooks, etc.

---

## 🤝 Contributing

See [Contributing Guide](https://docs.synap.sh/development/contributing) on the documentation site.

**Quick tips**:
- Use TypeScript strict mode
- Write tests for new features
- Follow the existing code style
- Update docs for API changes

---

## 📄 License

MIT License - See [LICENSE](./LICENSE)

---

## 🔗 Links

- **Documentation**: https://docs.synap.sh
- **GitHub**: https://github.com/Synap-core/backend
- **Issues**: https://github.com/Synap-core/backend/issues

---

**Status**: Production Ready ✅  
**Version**: 0.5.0  
**Last Updated**: December 2025
