#!/bin/bash
# Synap Backend - Automated Installer (Non-Interactive)
# Usage: DOMAIN=example.com LETSENCRYPT_EMAIL=user@example.com ./install-automated.sh
# 
# This script is designed for automated provisioning by the control plane.
# It accepts all configuration via environment variables and generates secrets automatically.

set -e

# Ensure we're using bash
if [ -z "$BASH_VERSION" ]; then
    echo "ERROR|This script requires bash"
    exit 1
fi

# Colors for output (optional, for logs)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================================================
# Configuration from Environment Variables
# ============================================================================

# Required variables
DOMAIN=${DOMAIN:-}
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL:-}
INTELLIGENCE_HUB_URL=${INTELLIGENCE_HUB_URL:-https://intelligence.synap.live}
INTELLIGENCE_API_KEY=${INTELLIGENCE_API_KEY:-}

# Optional variables (with defaults)
GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-synap-core/backend}
BACKEND_VERSION=${BACKEND_VERSION:-latest}
INSTALL_DIR=${INSTALL_DIR:-/opt/synap-backend}
AI_PROVIDER=${AI_PROVIDER:-none}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
GOOGLE_AI_API_KEY=${GOOGLE_AI_API_KEY:-}

# Validate required variables
if [ -z "$DOMAIN" ]; then
    echo "ERROR|DOMAIN environment variable is required"
    exit 1
fi

if [ -z "$LETSENCRYPT_EMAIL" ]; then
    echo "ERROR|LETSENCRYPT_EMAIL environment variable is required"
    exit 1
fi

# ============================================================================
# Prerequisites Check
# ============================================================================

echo "INFO|Checking prerequisites..."

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "ERROR|Docker not found. Please install Docker first."
    exit 1
fi

# Check Docker Compose
if ! command -v docker compose &> /dev/null; then
    echo "ERROR|Docker Compose not found"
    exit 1
fi

# Check Docker daemon
if ! docker info &> /dev/null; then
    echo "ERROR|Docker daemon is not running"
    exit 1
fi

echo "INFO|Prerequisites met"

# ============================================================================
# Generate Secrets
# ============================================================================

echo "INFO|Generating secure secrets..."

# Helper functions
generate_secret() {
    openssl rand -base64 32 | tr -d "=+/" | cut -c1-32
}

generate_secret_64() {
    openssl rand -base64 64 | tr -d "=+/" | cut -c1-64
}

POSTGRES_PASSWORD=$(generate_secret)
JWT_SECRET=$(generate_secret_64)
KRATOS_COOKIE=$(generate_secret)
KRATOS_CIPHER=$(generate_secret)
KRATOS_WEBHOOK=$(generate_secret)
MINIO_ACCESS_KEY="minioadmin"
MINIO_SECRET_KEY=$(generate_secret)
TYPESENSE_KEY=$(generate_secret)
TYPESENSE_ADMIN_KEY=$(generate_secret)
INNGEST_EVENT_KEY=$(generate_secret)
INNGEST_SIGNING_KEY=$(generate_secret)
HYDRA_SECRETS_SYSTEM=$(generate_secret)

# Generate Intelligence API key if not provided
if [ -z "$INTELLIGENCE_API_KEY" ]; then
    INTELLIGENCE_API_KEY=$(generate_secret)
    echo "INFO|Generated Intelligence API key"
fi

echo "INFO|Secrets generated"

# ============================================================================
# Setup Installation Directory
# ============================================================================

echo "INFO|Setting up installation directory: ${INSTALL_DIR}"

# Create directory if it doesn't exist
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ============================================================================
# Clone Repository
# ============================================================================

echo "INFO|Cloning Synap Backend repository..."

# Check if already cloned
if [ -d ".git" ]; then
    echo "INFO|Repository already exists, pulling latest..."
    git pull origin main || true
else
    git clone https://github.com/${GITHUB_REPOSITORY}.git .
fi

# Enter deploy directory
if [ -d "deploy" ]; then
    cd deploy
    if [ -f "synap-cli" ]; then
        chmod +x synap-cli
    fi
else
    echo "ERROR|deploy directory not found"
    exit 1
fi

echo "INFO|Repository ready"

# ============================================================================
# Create .env File
# ============================================================================

echo "INFO|Creating configuration file..."

cat > .env <<EOF
# Synap Backend Configuration
# Generated: $(date)
# Automated installation via control plane

# GitHub Repository
GITHUB_REPOSITORY=${GITHUB_REPOSITORY}
BACKEND_VERSION=${BACKEND_VERSION}
COMPOSE_PROJECT_NAME=synap-backend

# Domain & SSL
DOMAIN=${DOMAIN}
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL}

# Database
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# Authentication
JWT_SECRET=${JWT_SECRET}
KRATOS_SECRETS_COOKIE=${KRATOS_COOKIE}
KRATOS_SECRETS_CIPHER=${KRATOS_CIPHER}
KRATOS_WEBHOOK_SECRET=${KRATOS_WEBHOOK}

# Storage
MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
MINIO_SECRET_KEY=${MINIO_SECRET_KEY}

# Search
TYPESENSE_API_KEY=${TYPESENSE_KEY}
TYPESENSE_ADMIN_API_KEY=${TYPESENSE_ADMIN_KEY}

# Jobs
INNGEST_EVENT_KEY=${INNGEST_EVENT_KEY}
INNGEST_SIGNING_KEY=${INNGEST_SIGNING_KEY}

# AI & Intelligence
AI_PROVIDER=${AI_PROVIDER}
INTELLIGENCE_HUB_URL=${INTELLIGENCE_HUB_URL}
INTELLIGENCE_API_KEY=${INTELLIGENCE_API_KEY}
OPENAI_API_KEY=${OPENAI_API_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
GOOGLE_AI_API_KEY=${GOOGLE_AI_API_KEY}
ORY_HYDRA_SECRETS_SYSTEM=${HYDRA_SECRETS_SYSTEM}
EOF

chmod 600 .env
echo "INFO|Configuration created"

# ============================================================================
# Start Services
# ============================================================================

echo "INFO|Starting Synap services..."

# Pull images first (faster if available)
docker compose pull --ignore-pull-failures || true

# Build if needed (fallback)
docker compose build --pull || true

# Start services
docker compose up -d

echo "INFO|Services started"

# ============================================================================
# Wait for Health Check
# ============================================================================

echo "INFO|Waiting for services to be healthy..."

# Wait up to 5 minutes for health check
MAX_WAIT=300
WAIT_INTERVAL=10
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
    if curl -f -s "http://localhost:4000/health" > /dev/null 2>&1; then
        echo "INFO|Backend is healthy"
        break
    fi
    
    sleep $WAIT_INTERVAL
    ELAPSED=$((ELAPSED + WAIT_INTERVAL))
    echo "INFO|Waiting for backend... (${ELAPSED}s/${MAX_WAIT}s)"
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
    echo "WARN|Backend health check timeout (services may still be starting)"
fi

# ============================================================================
# Success Output
# ============================================================================

BACKEND_URL="https://${DOMAIN}"

echo "SUCCESS|${DOMAIN}|${BACKEND_URL}"
echo "INFO|Installation complete"
echo "INFO|Backend URL: ${BACKEND_URL}"
echo "INFO|Installation directory: ${INSTALL_DIR}/deploy"

exit 0
