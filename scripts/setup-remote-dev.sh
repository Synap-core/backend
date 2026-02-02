#!/bin/bash

# Setup script for hybrid development (local API, remote services)
# This script helps configure .env.development.remote

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.development.remote"
EXAMPLE_FILE="$ROOT_DIR/.env.development.remote.example"

echo "🔧 Setting up hybrid development environment..."
echo ""

# Check if .env.development.remote already exists
if [ -f "$ENV_FILE" ]; then
  echo "⚠️  .env.development.remote already exists!"
  read -p "Overwrite? (y/N): " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Aborted"
    exit 1
  fi
fi

# Copy example file
if [ ! -f "$EXAMPLE_FILE" ]; then
  echo "❌ Error: .env.development.remote.example not found!"
  exit 1
fi

cp "$EXAMPLE_FILE" "$ENV_FILE"
echo "✅ Created .env.development.remote from example"

# Prompt for server host
echo ""
read -p "Enter your server IP or domain: " SERVER_HOST
if [ -z "$SERVER_HOST" ]; then
  echo "❌ Server host is required!"
  exit 1
fi

# Update SERVER_HOST in the file
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  sed -i '' "s|SERVER_HOST=.*|SERVER_HOST=$SERVER_HOST|" "$ENV_FILE"
else
  # Linux
  sed -i "s|SERVER_HOST=.*|SERVER_HOST=$SERVER_HOST|" "$ENV_FILE"
fi

echo "✅ Updated SERVER_HOST to: $SERVER_HOST"
echo ""
echo "📝 Next steps:"
echo "1. SSH into your server: ssh user@$SERVER_HOST"
echo "2. Get secrets from: /opt/synap-backend/deploy/.env"
echo "3. Update .env.development.remote with:"
echo "   - POSTGRES_PASSWORD"
echo "   - KRATOS_SECRETS_COOKIE"
echo "   - KRATOS_SECRETS_CIPHER"
echo "   - KRATOS_WEBHOOK_SECRET"
echo "   - MINIO_ACCESS_KEY"
echo "   - MINIO_SECRET_KEY"
echo "   - TYPESENSE_API_KEY"
echo "   - JWT_SECRET"
echo ""
echo "4. Ensure ports are accessible (check firewall)"
echo "5. Run: pnpm dev:remote"
echo ""
echo "📚 See docs/development/HYBRID_DEVELOPMENT.md for details"
