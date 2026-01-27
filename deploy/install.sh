#!/bin/bash
set -e

# Synap Backend - One-Command Installer
# Usage: curl -fsSL https://get.synap.live/install.sh | bash

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Banner
echo -e "${BLUE}"
cat << "EOF"
   _____                        
  / ____|                       
 | (___  _   _ _ __   __ _ _ __ 
  \___ \| | | | '_ \ / _` | '_ \
  ____) | |_| | | | | (_| | |_) |
 |_____/ \__, |_| |_|\__,_| .__/ 
          __/ |           | |    
         |___/            |_|    

EOF
echo -e "${NC}"
echo -e "${BLUE}Synap Backend - One-Command Installer${NC}"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo -e "${YELLOW}⚠️  Running as root. Consider using a non-root user with sudo.${NC}"
fi

# Check prerequisites
echo -e "${BLUE}🔍 Checking prerequisites...${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found${NC}"
    echo ""
    echo "Please install Docker first:"
    echo "  Ubuntu/Debian: curl -fsSL https://get.docker.com | sh"
    echo "  Or visit: https://docs.docker.com/engine/install/"
    exit 1
fi
echo -e "${GREEN}✓ Docker found ($(docker --version | cut -d' ' -f3 | tr -d ','))${NC}"

# Check Docker Compose
if ! command -v docker compose &> /dev/null; then
    echo -e "${RED}❌ Docker Compose not found${NC}"
    echo ""
    echo "Docker Compose is required. It usually comes with Docker."
    echo "Visit: https://docs.docker.com/compose/install/"
    exit 1
fi
echo -e "${GREEN}✓ Docker Compose found${NC}"

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker daemon is not running${NC}"
    echo ""
    echo "Please start Docker:"
    echo "  sudo systemctl start docker"
    exit 1
fi
echo -e "${GREEN}✓ Docker daemon running${NC}"

# Check disk space (need at least 10GB)
AVAILABLE_SPACE=$(df -BG . | tail -1 | awk '{print $4}' | tr -d 'G')
if [ "$AVAILABLE_SPACE" -lt 10 ]; then
    echo -e "${YELLOW}⚠️  Low disk space: ${AVAILABLE_SPACE}GB available (10GB+ recommended)${NC}"
    read -p "Continue anyway? (y/N): " CONTINUE
    if [[ ! "$CONTINUE" =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}✅ All prerequisites met!${NC}"
echo ""

# Prompt for configuration
echo -e "${BLUE}📝 Configuration${NC}"
echo ""

# Domain
read -p "Enter your domain (e.g., synap.example.com): " DOMAIN
while [ -z "$DOMAIN" ]; do
    echo -e "${RED}Domain is required!${NC}"
    read -p "Enter your domain: " DOMAIN
done

# Email for SSL
read -p "Enter your email (for SSL certificates): " EMAIL
while [ -z "$EMAIL" ]; do
    echo -e "${RED}Email is required!${NC}"
    read -p "Enter your email: " EMAIL
done

# OpenAI API Key
echo ""
echo -e "${BLUE}🤖 AI Configuration${NC}"
echo "Get your OpenAI API key from: https://platform.openai.com/api-keys"
read -p "OpenAI API Key: " OPENAI_KEY
while [ -z "$OPENAI_KEY" ]; do
    echo -e "${RED}OpenAI API key is required!${NC}"
    read -p "OpenAI API Key: " OPENAI_KEY
done

# Optional: Anthropic
read -p "Anthropic API Key (optional, press Enter to skip): " ANTHROPIC_KEY

# Optional: Google AI
read -p "Google AI API Key (optional, press Enter to skip): " GOOGLE_AI_KEY

# Generate secrets
echo ""
echo -e "${BLUE}🔐 Generating secure secrets...${NC}"

POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
JWT_SECRET=$(openssl rand -base64 64 | tr -d "=+/" | cut -c1-64)
KRATOS_COOKIE=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
KRATOS_CIPHER=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
KRATOS_WEBHOOK=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
MINIO_ACCESS_KEY="minioadmin"
MINIO_SECRET_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
TYPESENSE_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
TYPESENSE_ADMIN_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
INNGEST_EVENT_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
INNGEST_SIGNING_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
INTELLIGENCE_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)

echo -e "${GREEN}✓ Secrets generated${NC}"

# Create installation directory
INSTALL_DIR="/opt/synap"
echo ""
echo -e "${BLUE}📁 Creating installation directory: ${INSTALL_DIR}${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠️  Directory already exists${NC}"
    read -p "Overwrite? This will delete existing data! (y/N): " OVERWRITE
    if [[ "$OVERWRITE" =~ ^[Yy]$ ]]; then
        rm -rf "$INSTALL_DIR"
    else
        echo -e "${RED}Installation cancelled${NC}"
        exit 1
    fi
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Download deployment files
echo ""
echo -e "${BLUE}📥 Downloading Synap files...${NC}"

REPO_URL="https://raw.githubusercontent.com/synap-labs/synap-backend/main/deploy"

curl -fsSL "${REPO_URL}/docker-compose.yml" -o docker-compose.yml
curl -fsSL "${REPO_URL}/Caddyfile" -o Caddyfile
curl -fsSL "${REPO_URL}/synap-cli" -o synap-cli
chmod +x synap-cli

echo -e "${GREEN}✓ Files downloaded${NC}"

# Create .env file
echo ""
echo -e "${BLUE}📝 Creating configuration...${NC}"

cat > .env <<EOF
# Synap Backend Configuration
# Generated: $(date)

# ============================================================================
# DOMAIN & SSL
# ============================================================================
DOMAIN=${DOMAIN}
LETSENCRYPT_EMAIL=${EMAIL}

# ============================================================================
# DATABASE
# ============================================================================
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# ============================================================================
# AUTHENTICATION
# ============================================================================
JWT_SECRET=${JWT_SECRET}
KRATOS_SECRETS_COOKIE=${KRATOS_COOKIE}
KRATOS_SECRETS_CIPHER=${KRATOS_CIPHER}
KRATOS_WEBHOOK_SECRET=${KRATOS_WEBHOOK}

# ============================================================================
# STORAGE
# ============================================================================
MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
MINIO_SECRET_KEY=${MINIO_SECRET_KEY}

# ============================================================================
# SEARCH
# ============================================================================
TYPESENSE_API_KEY=${TYPESENSE_KEY}
TYPESENSE_ADMIN_API_KEY=${TYPESENSE_ADMIN_KEY}

# ============================================================================
# JOBS
# ============================================================================
INNGEST_EVENT_KEY=${INNGEST_EVENT_KEY}
INNGEST_SIGNING_KEY=${INNGEST_SIGNING_KEY}

# ============================================================================
# AI
# ============================================================================
INTELLIGENCE_API_KEY=${INTELLIGENCE_KEY}
OPENAI_API_KEY=${OPENAI_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
GOOGLE_AI_API_KEY=${GOOGLE_AI_KEY}
EOF

chmod 600 .env
echo -e "${GREEN}✓ Configuration created${NC}"

# Save secrets backup
cat > .secrets-backup.txt <<EOF
# CRITICAL: Save this file securely and delete from server!
# Synap Secrets Backup
# Generated: $(date)

POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
KRATOS_COOKIE=${KRATOS_COOKIE}
KRATOS_CIPHER=${KRATOS_CIPHER}
KRATOS_WEBHOOK=${KRATOS_WEBHOOK}
MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
TYPESENSE_KEY=${TYPESENSE_KEY}
TYPESENSE_ADMIN_KEY=${TYPESENSE_ADMIN_KEY}
INNGEST_EVENT_KEY=${INNGEST_EVENT_KEY}
INNGEST_SIGNING_KEY=${INNGEST_SIGNING_KEY}
INTELLIGENCE_KEY=${INTELLIGENCE_KEY}
OPENAI_KEY=${OPENAI_KEY}
ANTHROPIC_KEY=${ANTHROPIC_KEY}
GOOGLE_AI_KEY=${GOOGLE_AI_KEY}
EOF

chmod 600 .secrets-backup.txt

# Start services
echo ""
echo -e "${BLUE}🚀 Starting Synap...${NC}"

docker compose pull
docker compose up -d

# Wait for services to be healthy
echo ""
echo -e "${BLUE}⏳ Waiting for services to start (this may take 1-2 minutes)...${NC}"
sleep 30

# Run database migrations
echo ""
echo -e "${BLUE}🔄 Running database migrations...${NC}"
docker compose exec -T backend sh -c 'cd packages/database && pnpm db:push' || true

# Success message
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Synap is installed!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📍 Installation Directory:${NC} ${INSTALL_DIR}"
echo -e "${BLUE}🌐 Domain:${NC} https://${DOMAIN}"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT NEXT STEPS:${NC}"
echo ""
echo "1. Configure DNS:"
echo "   Add an A record pointing ${DOMAIN} to this server's IP"
echo ""
echo "2. Backup your secrets:"
echo "   scp ${INSTALL_DIR}/.secrets-backup.txt your-local-machine:~/"
echo "   rm ${INSTALL_DIR}/.secrets-backup.txt"
echo ""
echo "3. Wait for SSL certificate (1-2 minutes after DNS propagates)"
echo ""
echo "4. Access Synap:"
echo "   https://${DOMAIN}"
echo ""
echo -e "${BLUE}📚 Documentation:${NC} https://docs.synap.live"
echo -e "${BLUE}💬 Community:${NC} https://discord.gg/synap"
echo -e "${BLUE}🐛 Issues:${NC} https://github.com/synap-labs/synap-backend/issues"
echo ""
echo -e "${BLUE}🛠️  Management Commands:${NC}"
echo "  ${INSTALL_DIR}/synap-cli health    # Check system health"
echo "  ${INSTALL_DIR}/synap-cli logs      # View logs"
echo "  ${INSTALL_DIR}/synap-cli update    # Update Synap"
echo "  ${INSTALL_DIR}/synap-cli backup    # Backup data"
echo ""
