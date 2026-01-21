#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Banner
echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║        Synap Backend Production Setup Script              ║"
echo "║        Automated Configuration Generator                  ║"
echo "║                                                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running as root or with sudo
if [ "$EUID" -ne 0 ]; then 
    echo -e "${YELLOW}⚠️  This script should be run as root or with sudo${NC}"
    echo "Continue anyway? (y/n)"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Detect deployment directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEPLOYMENT_ROOT="/srv/synap"

echo -e "${GREEN}📁 Project root: ${PROJECT_ROOT}${NC}"
echo -e "${GREEN}📁 Deployment root: ${DEPLOYMENT_ROOT}${NC}"
echo ""

# Production mode (per-user backend)
DEPLOYMENT_MODE="production"
DEMO_MODE_ENABLED="false"
echo -e "${BLUE}🚀 Deployment Mode: Production${NC}"
echo "This backend will connect to a centralized Intelligence Service"
echo ""

# Domain configuration
echo -e "${BLUE}🌐 Domain Configuration${NC}"
read -p "Enter user subdomain (e.g., user1, acme-corp): " SUBDOMAIN
read -p "Enter base domain (default: synap.live): " DOMAIN
DOMAIN=${DOMAIN:-synap.live}
BACKEND_URL="${SUBDOMAIN}.${DOMAIN}"
APP_URL="app.${DOMAIN}"

echo -e "${GREEN}✓ Backend URL: https://${BACKEND_URL}${NC}"
echo ""

# Generate secure secrets
echo -e "${BLUE}🔐 Generating Secure Secrets...${NC}"

POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
KRATOS_COOKIE=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-32)
KRATOS_CIPHER=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-32)
KRATOS_WEBHOOK=$(openssl rand -base64 32)
MINIO_PASSWORD=$(openssl rand -base64 32)
INTELLIGENCE_KEY=$(openssl rand -base64 32)
TYPESENSE_KEY=$(openssl rand -base64 32)
TYPESENSE_ADMIN_KEY=$(openssl rand -base64 32)
INNGEST_EVENT=$(openssl rand -base64 32)
INNGEST_SIGNING=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 64)

echo -e "${GREEN}✓ All secrets generated${NC}"
echo ""

# Intelligence Service configuration
echo -e "${BLUE}🤖 Intelligence Service Configuration${NC}"
read -p "Intelligence Service URL (default: https://intelligence.synap.live): " INTELLIGENCE_URL
INTELLIGENCE_URL=${INTELLIGENCE_URL:-https://intelligence.synap.live}

read -p "Intelligence API Key (from Intelligence Service setup): " INTELLIGENCE_API_KEY
while [ -z "$INTELLIGENCE_API_KEY" ]; do
    echo -e "${RED}Intelligence API key is required!${NC}"
    read -p "Intelligence API Key: " INTELLIGENCE_API_KEY
done

echo -e "${GREEN}✓ Intelligence Service configured${NC}"
echo ""

# Ask for API keys
echo -e "${BLUE}🔑 API Keys Configuration (Optional Fallback)${NC}"
echo "OpenAI key is optional - Intelligence Service handles AI calls"
echo ""

# OpenAI (optional fallback)
read -p "OpenAI API Key (optional fallback): " OPENAI_KEY
OPENAI_KEY=${OPENAI_KEY:-}

# Anthropic (optional)
read -p "Anthropic API Key (optional): " ANTHROPIC_KEY
ANTHROPIC_KEY=${ANTHROPIC_KEY:-}

# Google AI (optional)
read -p "Google AI API Key (optional): " GOOGLE_AI_KEY
GOOGLE_AI_KEY=${GOOGLE_AI_KEY:-}

echo ""

echo -e "${GREEN}✓ Configuration collected${NC}"
echo ""

# Summary
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📋 Configuration Summary${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "Mode: Production (Per-User Backend)"
echo "Subdomain: ${SUBDOMAIN}"
echo "Backend URL: https://${BACKEND_URL}"
echo "Intelligence: ${INTELLIGENCE_URL}"
echo "API Key: ${INTELLIGENCE_API_KEY:0:10}..."
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
read -p "Continue with this configuration? (y/n): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${RED}Setup cancelled${NC}"
    exit 1
fi

# Create directory structure
echo ""
echo -e "${BLUE}📁 Creating directory structure...${NC}"
mkdir -p "${DEPLOYMENT_ROOT}"
mkdir -p "${DEPLOYMENT_ROOT}/synap-backend"
mkdir -p "${DEPLOYMENT_ROOT}/data/postgres"
mkdir -p "${DEPLOYMENT_ROOT}/data/typesense"
mkdir -p "${DEPLOYMENT_ROOT}/data/minio"
echo -e "${GREEN}✓ Directories created${NC}"

# Create root .env file (for docker-compose)
echo ""
echo -e "${BLUE}📝 Creating root .env file...${NC}"
cat > "${DEPLOYMENT_ROOT}/.env" <<EOF
# Generated by setup-production.sh on $(date)
# DO NOT COMMIT THIS FILE

# Deployment
DEPLOYMENT_MODE=${DEPLOYMENT_MODE}

# Shared Secrets
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
KRATOS_SECRETS_COOKIE=${KRATOS_COOKIE}
KRATOS_SECRETS_CIPHER=${KRATOS_CIPHER}
KRATOS_WEBHOOK_SECRET=${KRATOS_WEBHOOK}
MINIO_SECRET_KEY=${MINIO_PASSWORD}
TYPESENSE_API_KEY=${TYPESENSE_KEY}
TYPESENSE_ADMIN_API_KEY=${TYPESENSE_ADMIN_KEY}
INNGEST_EVENT_KEY=${INNGEST_EVENT}
INNGEST_SIGNING_KEY=${INNGEST_SIGNING}
INTELLIGENCE_API_KEY=${INTELLIGENCE_KEY}
EOF
chmod 600 "${DEPLOYMENT_ROOT}/.env"
echo -e "${GREEN}✓ Root .env created${NC}"

# Create backend .env.production
echo ""
echo -e "${BLUE}📝 Creating backend .env.production...${NC}"
cat > "${DEPLOYMENT_ROOT}/synap-backend/.env.production" <<EOF
# Generated by setup-production.sh on $(date)
# DO NOT COMMIT THIS FILE

# ============================================================================
# DEPLOYMENT MODE
# ============================================================================
DEPLOYMENT_MODE=${DEPLOYMENT_MODE}
NODE_ENV=production

# ============================================================================
# SERVER CONFIGURATION
# ============================================================================
PORT=4000
REALTIME_PORT=4001
LOG_LEVEL=info

# ============================================================================
# DATABASE
# ============================================================================
DATABASE_URL=postgresql://synap:${POSTGRES_PASSWORD}@postgres:5432/synap

# ============================================================================
# AUTHENTICATION (Ory Kratos + Hydra)
# ============================================================================
KRATOS_PUBLIC_URL=http://kratos:4433
KRATOS_ADMIN_URL=http://kratos:4434
KRATOS_SECRETS_COOKIE=${KRATOS_COOKIE}
KRATOS_SECRETS_CIPHER=${KRATOS_CIPHER}
KRATOS_WEBHOOK_SECRET=${KRATOS_WEBHOOK}

HYDRA_PUBLIC_URL=http://hydra:4444
HYDRA_ADMIN_URL=http://hydra:4445

# ============================================================================
# JWT
# ============================================================================
JWT_SECRET=${JWT_SECRET}

# ============================================================================
# STORAGE (MinIO)
# ============================================================================
STORAGE_PROVIDER=minio
MINIO_ENDPOINT=http://minio:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=${MINIO_PASSWORD}
MINIO_BUCKET=synap-storage
MINIO_USE_SSL=false

# ============================================================================
# AI CONFIGURATION (Intelligence Service)
# ============================================================================
INTELLIGENCE_HUB_URL=${INTELLIGENCE_URL}
INTELLIGENCE_API_KEY=${INTELLIGENCE_API_KEY}
OPENAI_API_KEY=${OPENAI_KEY:-}

# ============================================================================
# SEARCH (Typesense)
# ============================================================================
TYPESENSE_HOST=typesense
TYPESENSE_PORT=8108
TYPESENSE_PROTOCOL=http
TYPESENSE_API_KEY=${TYPESENSE_KEY}
TYPESENSE_ADMIN_API_KEY=${TYPESENSE_ADMIN_KEY}

# ============================================================================
# BACKGROUND JOBS (Inngest)
# ============================================================================
INNGEST_EVENT_KEY=${INNGEST_EVENT}
INNGEST_SIGNING_KEY=${INNGEST_SIGNING}

# ============================================================================
# FRONTEND (CORS)
# ============================================================================
FRONTEND_URL=https://${APP_URL}
ALLOWED_ORIGINS=https://${APP_URL},https://${DOMAIN}

# ============================================================================
# DEMO MODE CONFIG
# ============================================================================
DEMO_MODE_ENABLED=${DEMO_MODE_ENABLED}
DEMO_WORKSPACE_ID=demo-workspace
EOF
chmod 600 "${DEPLOYMENT_ROOT}/synap-backend/.env.production"
echo -e "${GREEN}✓ Backend .env.production created${NC}"



# Save secrets to a secure file (for backup)
echo ""
echo -e "${BLUE}💾 Creating secrets backup...${NC}"
cat > "${DEPLOYMENT_ROOT}/.secrets-backup.txt" <<EOF
# IMPORTANT: Store this file securely and DELETE from server after backup!
# Generated: $(date)

POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
KRATOS_COOKIE=${KRATOS_COOKIE}
KRATOS_CIPHER=${KRATOS_CIPHER}
MINIO_PASSWORD=${MINIO_PASSWORD}
INTELLIGENCE_KEY=${INTELLIGENCE_KEY}
TYPESENSE_KEY=${TYPESENSE_KEY}
TYPESENSE_ADMIN_KEY=${TYPESENSE_ADMIN_KEY}
INNGEST_EVENT=${INNGEST_EVENT}
INNGEST_SIGNING=${INNGEST_SIGNING}
JWT_SECRET=${JWT_SECRET}

OPENAI_KEY=${OPENAI_KEY}
STRIPE_SECRET=${STRIPE_SECRET}
STRIPE_WEBHOOK=${STRIPE_WEBHOOK}
EOF
chmod 600 "${DEPLOYMENT_ROOT}/.secrets-backup.txt"
echo -e "${GREEN}✓ Secrets backup created at ${DEPLOYMENT_ROOT}/.secrets-backup.txt${NC}"
echo -e "${YELLOW}⚠️  IMPORTANT: Save this file securely and DELETE from server!${NC}"

# Success summary
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📁 Files Created:${NC}"
echo "  ✓ ${DEPLOYMENT_ROOT}/.env"
echo "  ✓ ${DEPLOYMENT_ROOT}/synap-backend/.env.production"
echo "  ✓ ${DEPLOYMENT_ROOT}/.secrets-backup.txt"
echo ""
echo -e "${YELLOW}📋 Next Steps:${NC}"
echo "  1. Review generated .env files"
echo "  2. Copy .secrets-backup.txt to secure location"
echo "  3. Delete .secrets-backup.txt from server"
echo "  4. Ensure Intelligence Service is running at ${INTELLIGENCE_URL}"
echo "  5. Run: cd ${DEPLOYMENT_ROOT} && ./start.sh"
echo ""
echo -e "${BLUE}🔗 Intelligence Service:${NC}"
echo "  This backend connects to: ${INTELLIGENCE_URL}"
echo "  Make sure Intelligence Service is deployed and accessible"
echo ""
echo -e "${BLUE}🚀 To start the backend:${NC}"
echo "  cd ${DEPLOYMENT_ROOT}"
echo "  ./start.sh"
echo ""
