# Synap Backend

Self-hosted intelligence infrastructure for sovereign data pods.

## Quick Start (30 seconds)

```bash
# 1. Start infrastructure
./start.sh

# 2. Start API server
pnpm exec turbo run dev --filter='@synap/realtime' --filter='api' --filter='@synap/jobs'

# 3. Start frontend (in synap-app directory)
cd ../synap-app
pnpm exec turbo run dev --filter='web'

# 4. Open browser
open http://localhost:3000/setup
```

That's it! The setup wizard will guide you through creating your admin account.

---

## What Just Happened?

The `start.sh` script:
- ✅ Starts Docker services (Postgres, MinIO, Kratos)
- ✅ Waits for all services to be healthy
- ✅ Runs database migrations automatically
- ✅ Verifies everything is ready

---

## Services

| Service | Port | Purpose |
|---------|------|---------|
| **PostgreSQL** | 5432 | Main database (TimescaleDB + pgvector) |
| **MinIO** | 9000/9001 | S3-compatible object storage |
| **Kratos** | 4433/4434 | Authentication & identity management |
| **Inngest** | 8288 | Background job processing (optional) |
| **n8n** | 5678 | Workflow automation (optional) |

---

## Architecture

```
synap-backend/
├── packages/
│   ├── api/           # tRPC API server
│   ├── database/      # Drizzle ORM schema & migrations
│   ├── realtime/      # WebSocket server
│   ├── jobs/          # Inngest background jobs
│   └── storage/       # MinIO client
├── docker/
│   ├── postgres/      # Database init scripts
│   └── kratos/        # Kratos migration script
├── kratos/            # Kratos configuration
└── start.sh           # Automated startup script
```

---

## Manual Setup (If You Need Control)

### 1. Environment Variables

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Customize if needed (defaults work for local development).

### 2. Start Docker Services

```bash
docker compose --profile auth up -d
```

**Profiles**:
- `auth` - Adds Kratos for authentication
- `jobs` - Adds Inngest for background jobs
- `workflows` - Adds n8n for automation

### 3. Run Migrations

```bash
cd packages/database
pnpm run db:push
```

This creates all tables in your database.

### 4. Start Development Servers

```bash
# Backend APIs
pnpm exec turbo run dev --filter='@synap/realtime' --filter='api' --filter='@synap/jobs'

# Frontend (in synap-app directory)
cd ../synap-app
pnpm exec turbo run dev --filter='web'
```

---

## First-Time Setup

1. **Access Setup Wizard**: http://localhost:3000/setup
2. **Create Admin Account**: Email, name, and password
3. **Automatic Workspace**: System creates your first workspace
4. **You're Live**: Start using Synap!

---

## Troubleshooting

### Docker Services Won't Start

```bash
# Check Docker is running
docker info

# View logs
docker logs synap-postgres
docker logs synap-kratos

# Hard reset (WARNING: Deletes all data)
docker compose --profile auth down -v
./start.sh
```

### Kratos Not Responding

```bash
# Check health
curl http://localhost:4433/health/ready

# Should return: {"status":"ok"}

# If not, check logs
docker logs synap-kratos --tail 50
```

### Database Connection Errors

```bash
# Verify databases exist
docker exec synap-postgres psql -U postgres -c "\l"

# Should show: synap, kratos_db

# Test connection
docker exec synap-postgres psql -U postgres -d synap -c "SELECT 1;"
```

### Migration Errors

```bash
# Reset and re-run
cd packages/database
pnpm run db:drop    # Drops all tables
pnpm run db:push    # Recreates schema
```

---

## Development

### Running Tests

```bash
# All tests
pnpm test

# Specific package
pnpm --filter @synap/database test

# With coverage
pnpm --filter @synap/database test:coverage
```

### Database Tools

```bash
cd packages/database

# Generate migration files (when schema changes)
pnpm run db:generate

# Push schema directly to database (dev only)
pnpm run db:push

# Launch Drizzle Studio (database UI)
pnpm run db:studio
```

### API Development

```bash
# Watch mode with auto-reload
pnpm --filter api dev

# Run specific service
pnpm --filter @synap/realtime dev
```

---

## Production Deployment

> **Note**: Production deployment guide coming soon. Current setup optimized for local development.

Key differences for production:
- Disable Kratos `--dev` mode
- Use proper secrets (not defaults)
- Enable TLS for Kratos
- Set up email delivery (replace mailslurper)
- Configure backups for PostgreSQL
- Use managed services (RDS, S3) or hardened self-hosted

---

## Tech Stack

- **Database**: PostgreSQL 16 + TimescaleDB + pgvector
- **ORM**: Drizzle ORM
- **API**: tRPC + Fastify
- **Auth**: Ory Kratos
- **Storage**: MinIO (S3-compatible)
- **Jobs**: Inngest
- **Real-time**: Socket.IO
- **Monorepo**: Turborepo + pnpm workspaces

---

## License

See [LICENSE](../LICENSE)

---

## Support

- Documentation: https://docs.synap.sh (coming soon)
- Issues: https://github.com/yourusername/synap/issues
- Discord: https://discord.gg/synap (coming soon)

---

**Built with ❤️ for sovereign data ownership**
