# Repository Cleanup Guide

## Files to Move/Remove

Based on the new `/deploy` structure, here are the old deployment files that should be cleaned up:

### Files to Remove (Duplicates)

These are now in `/deploy` and can be safely removed from root:

```bash
# Old deployment files (now in /deploy/)
rm docker-compose.yml              # Use deploy/docker-compose.yml instead
rm .env.example                    # Use deploy/.env.example instead
rm .env.typesense.example          # Typesense config now in deploy/
rm docker-compose.typesense.yml    # Integrated into main compose file
rm dev_deployment_guide.md         # Replaced by deploy/docs/
```

### Files to Keep in Root

These should stay in root:

```bash
# Keep these - they're for local development
.env                    # Local dev environment (gitignored)
.env.test               # Test environment
Dockerfile              # For building backend image
docker/                 # Development Docker configs
start.sh                # Local dev startup script
```

### Recommended Actions

```bash
cd /Users/antoine/Documents/Code/synap/synap-backend

# 1. Remove duplicate deployment files
rm docker-compose.yml
rm .env.example
rm .env.typesense.example
rm docker-compose.typesense.yml
rm dev_deployment_guide.md

# 2. Update .gitignore to exclude deploy/.env
echo "deploy/.env" >> .gitignore
echo "deploy/.secrets-backup.txt" >> .gitignore
echo "deploy/backups/" >> .gitignore

# 3. Create symlink for convenience (optional)
ln -s deploy/README.md SELF_HOSTING.md
```

## New Repository Structure

After cleanup:

```
synap-backend/
├── .env                        # Local dev only (gitignored)
├── .env.test                   # Test environment
├── Dockerfile                  # Backend image build
├── README.md                   # Main README (updated)
├── SELF_HOSTING.md            # Symlink to deploy/README.md
├── ARCHITECTURE.md
├── CONTRIBUTING.md
├── DEVELOPER_GUIDE.md
│
├── deploy/                     # 🆕 Self-hosting deployment
│   ├── README.md              # Self-hosting guide
│   ├── install.sh             # One-command installer
│   ├── synap-cli              # Management CLI
│   ├── docker-compose.yml     # Production compose
│   ├── Caddyfile              # Reverse proxy config
│   ├── .env.example           # Environment template
│   ├── components/
│   │   └── FirstRunOnboarding.tsx
│   └── docs/
│       ├── installation.md
│       ├── configuration.md
│       ├── backups.md
│       └── troubleshooting.md
│
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # 🆕 Auto-publish images
│
├── apps/                       # Application code
├── packages/                   # Shared packages
├── docs/                       # Development docs
├── docker/                     # Dev Docker configs
└── scripts/                    # Development scripts
```

## Migration Path

For existing deployments using old files:

1. **Backup current setup**:

   ```bash
   cp docker-compose.yml docker-compose.yml.backup
   cp .env .env.backup
   ```

2. **Migrate to new structure**:

   ```bash
   # Copy your .env to deploy/
   cp .env deploy/.env

   # Use new compose file
   cd deploy
   docker compose up -d
   ```

3. **Update documentation references**:
   - Update any internal docs pointing to old files
   - Update deployment scripts
   - Update CI/CD pipelines

## Benefits of New Structure

✅ **Clear separation**: Development vs. production deployment  
✅ **Self-contained**: All deployment files in one directory  
✅ **Portable**: Can copy `/deploy` to any server  
✅ **Documented**: Comprehensive guides in `/deploy/docs`  
✅ **Automated**: One-command installation  
✅ **Maintainable**: CLI for management

## Next Steps

1. Run cleanup commands above
2. Test deployment with new structure
3. Update any deployment documentation
4. Commit changes to git
