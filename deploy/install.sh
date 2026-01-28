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
echo -e "${BLUE}📝 Deployment Configuration${NC}"
echo ""

# Deployment Type Choice
echo "Choose deployment type:"
echo "  [1] Custom domain (you manage DNS)"
echo "  [2] Synap subdomain (*.synap.live) ⭐ RECOMMENDED"
echo "  [3] Localhost only (no SSL, for testing)"
echo ""
read -p "Choice [1-3]: " DEPLOYMENT_TYPE

# Load existing config
DEFAULT_DOMAIN=""
DEFAULT_EMAIL=""

if [ -f .env ]; then
    DEFAULT_DOMAIN=$(grep "^DOMAIN=" .env | cut -d'=' -f2-)
    DEFAULT_EMAIL=$(grep "^LETSENCRYPT_EMAIL=" .env | cut -d'=' -f2-)
    echo -e "${YELLOW}👉 Found existing configuration. Defaults loaded.${NC}"
fi

DEPLOYMENT_TYPE=""
DOMAIN=""
EMAIL=""
USE_SSL="true"

case $DEPLOYMENT_TYPE in
    1)
        # Custom domain flow
        echo ""
        read -p "Enter your domain (e.g., synap.example.com) [${DEFAULT_DOMAIN}]: " DOMAIN
        DOMAIN=${DOMAIN:-$DEFAULT_DOMAIN}
        
        while [ -z "$DOMAIN" ]; do
            echo -e "${RED}Domain is required!${NC}"
            read -p "Enter your domain: " DOMAIN
        done
        
        read -p "Enter your email (for SSL certificates) [${DEFAULT_EMAIL}]: " EMAIL
        EMAIL=${EMAIL:-$DEFAULT_EMAIL}

        while [ -z "$EMAIL" ]; do
            echo -e "${RED}Email is required!${NC}"
            read -p "Enter your email: " EMAIL
        done
        ;;
    2)
        # Synap subdomain flow
        echo ""
        echo -e "${BLUE}🌐 Synap Subdomain Provisioning${NC}"
        echo ""
        echo "You'll get a free subdomain like: happy-cloud-123.synap.live"
        echo "Or upgrade for custom subdomain like: yourname.synap.live"
        echo ""
        echo "⚠️  This feature requires authentication at synap.live"
        echo ""
        read -p "Continue? (y/N): " CONTINUE_SYNAP
        
        if [[ ! "$CONTINUE_SYNAP" =~ ^[Yy]$ ]]; then
            echo -e "${YELLOW}Switching to localhost mode...${NC}"
            DEPLOYMENT_TYPE=3
        else
            echo ""
            echo "Visit: https://synap.live/self-hosting"
            echo "1. Log in or create account"
            echo "2. Click 'Get Subdomain'"
            echo "3. Copy your provisioning token"
            echo ""
            read -p "Paste your provisioning token: " PROVISION_TOKEN
            
            while [ -z "$PROVISION_TOKEN" ]; do
                echo -e "${RED}Provisioning token is required!${NC}"
                read -p "Paste your provisioning token: " PROVISION_TOKEN
            done
            
            # Get server public IP
            echo ""
            echo -e "${BLUE}🔍 Detecting server IP...${NC}"
            PUBLIC_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || curl -s ipecho.net/plain)
            
            if [ -z "$PUBLIC_IP" ]; then
                echo -e "${RED}❌ Could not detect public IP${NC}"
                read -p "Enter your server's public IP: " PUBLIC_IP
            else
                echo -e "${GREEN}✓ Detected IP: ${PUBLIC_IP}${NC}"
            fi
            
            # Call control plane API
            echo ""
            echo -e "${BLUE}🚀 Provisioning subdomain...${NC}"
            
            RESPONSE=$(curl -s -X POST https://api.synap.live/v1/self-hosting/provision \
              -H "Authorization: Bearer $PROVISION_TOKEN" \
              -H "Content-Type: application/json" \
              -d "{\"ip\": \"$PUBLIC_IP\"}")
            
            DOMAIN=$(echo $RESPONSE | grep -o '"domain":"[^"]*"' | cut -d'"' -f4)
            
            if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "null" ]; then
                echo -e "${RED}❌ Provisioning failed${NC}"
                ERROR_MSG=$(echo $RESPONSE | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
                echo "Error: $ERROR_MSG"
                echo ""
                echo "Falling back to localhost mode..."
                DEPLOYMENT_TYPE=3
            else
                echo -e "${GREEN}✅ Reserved: ${DOMAIN}${NC}"
                echo ""
                echo "⏳ Waiting for DNS propagation (60 seconds)..."
                sleep 60
                
                # Email for SSL
                read -p "Enter your email (for SSL certificates): " EMAIL
                while [ -z "$EMAIL" ]; do
                    echo -e "${RED}Email is required!${NC}"
                    read -p "Enter your email: " EMAIL
                done
            fi
        fi
        ;;
    3)
        # Localhost flow
        echo ""
        echo -e "${YELLOW}⚠️  Localhost mode: No SSL, HTTP only${NC}"
        DOMAIN="localhost"
        EMAIL="noreply@localhost"
        USE_SSL="false"
        ;;
    *)
        echo -e "${RED}Invalid choice. Defaulting to localhost.${NC}"
        DOMAIN="localhost"
        EMAIL="noreply@localhost"
        USE_SSL="false"
        ;;
esac

# If we ended up in localhost mode from failed Synap provisioning
if [ "$DEPLOYMENT_TYPE" = "3" ]; then
    DOMAIN="localhost"
    EMAIL="noreply@localhost"
    USE_SSL="false"
fi

# Generate secrets
echo ""
echo -e "${BLUE}🔐 Generating secure secrets...${NC}"

# Helper to get secret or generate new
get_secret() {
    local var_name=$1
    local existing=""
    
    if [ -f .env ]; then
        existing=$(grep "^${var_name}=" .env | cut -d'=' -f2-)
    fi
    
    if [ -n "$existing" ]; then
        echo "$existing"
    else
        openssl rand -base64 32 | tr -d "=+/" | cut -c1-32
    fi
}

# Helper for 64 char secret
get_secret_64() {
    local var_name=$1
    local existing=""
    if [ -f .env ]; then existing=$(grep "^${var_name}=" .env | cut -d'=' -f2-); fi
    if [ -n "$existing" ]; then echo "$existing"; else openssl rand -base64 64 | tr -d "=+/" | cut -c1-64; fi
}

POSTGRES_PASSWORD=$(get_secret POSTGRES_PASSWORD)
JWT_SECRET=$(get_secret_64 JWT_SECRET)
KRATOS_COOKIE=$(get_secret KRATOS_SECRETS_COOKIE)
KRATOS_CIPHER=$(get_secret KRATOS_SECRETS_CIPHER)
KRATOS_WEBHOOK=$(get_secret KRATOS_WEBHOOK_SECRET)
MINIO_ACCESS_KEY="minioadmin"
MINIO_SECRET_KEY=$(get_secret MINIO_SECRET_KEY)
TYPESENSE_KEY=$(get_secret TYPESENSE_API_KEY)
TYPESENSE_ADMIN_KEY=$(get_secret TYPESENSE_ADMIN_API_KEY)
INNGEST_EVENT_KEY=$(get_secret INNGEST_EVENT_KEY)
INNGEST_SIGNING_KEY=$(get_secret INNGEST_SIGNING_KEY)
INTELLIGENCE_KEY=$(get_secret INTELLIGENCE_API_KEY)

echo -e "${GREEN}✓ Secrets loaded/generated${NC}"

# Create installation directory
# ADD THIS ENTIRE BLOCK OF CODE

# --- Path Selection ---
echo ""
echo -e "${BLUE}📁 Installation Path${NC}"
echo "The default installation path is /opt/synap."
echo "This requires sudo privileges to create."
echo ""
read -p "Do you want to use a custom installation path? (y/N): " USE_CUSTOM_PATH

INSTALL_DIR="/opt/synap" # Set default value

if [[ "$USE_CUSTOM_PATH" =~ ^[Yy]$ ]]; then
    # User wants a custom path
    echo ""
    echo "Please provide an absolute path for the installation."
    echo "e.g., /home/youruser/synap or ~/pkm_stacks/synap"
    # Use realpath to resolve ~ and other relative paths to an absolute path
    read -p "Enter custom installation path: " CUSTOM_PATH
    
    # Loop until a non-empty path is provided
    while [ -z "$CUSTOM_PATH" ]; do
        echo -e "${RED}Path cannot be empty!${NC}"
        read -p "Enter custom installation path: " CUSTOM_PATH
    done

    # Resolve potential ~ character to full home directory path
    # Using eval is generally risky, but here it's safe for a simple tilde expansion.
    # A safer method is used below if available.
    if command -v realpath &> /dev/null; then
        INSTALL_DIR=$(realpath -m "$CUSTOM_PATH")
    else
        # Fallback for systems without realpath, less robust
        INSTALL_DIR=$(eval echo "$CUSTOM_PATH")
    fi
    
    echo -e "${GREEN}✓ Using custom path: ${INSTALL_DIR}${NC}"
else
    # User wants the default path
    echo -e "${GREEN}✓ Using default path: ${INSTALL_DIR}${NC}"
    # Check for sudo if using the default /opt path
    if [ ! -w "/opt" ] && [ "$EUID" -ne 0 ]; then
        echo ""
        echo -e "${YELLOW}⚠️  The default path /opt/synap requires root privileges to create.${NC}"
        echo "Please re-run the script with 'sudo' or choose a custom path in your home directory."
        exit 1
    fi
fi
# --- End of Path Selection ---

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

# Setup Source Code
echo ""
echo -e "${BLUE}📥 Setting up Synap source code...${NC}"

# Detect if running from local repo
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
IS_LOCAL_REPO=false
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
    if [ -f "$SCRIPT_DIR/../package.json" ]; then
         IS_LOCAL_REPO=true
         REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    fi
fi

if [ "$IS_LOCAL_REPO" = true ]; then
    echo -e "${GREEN}✓ Cloning from local repository: $REPO_ROOT${NC}"
    git clone "$REPO_ROOT" .
else 
    echo -e "${BLUE}⬇️ Cloning from GitHub...${NC}"
    git clone https://github.com/Synap-core/backend.git .
fi

# Enter deploy directory
if [ -d "deploy" ]; then
    cd deploy
    # Ensure CLI is executable
    if [ -f "synap-cli" ]; then
        chmod +x synap-cli
    fi
else
    echo -e "${RED}Error: 'deploy' directory missing in source!${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Source code ready${NC}"

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
AI_PROVIDER=${AI_PROVIDER}
EMBEDDING_PROVIDER=${EMBEDDING_PROVIDER}
INTELLIGENCE_API_KEY=${INTELLIGENCE_KEY}
OPENAI_API_KEY=${OPENAI_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
GOOGLE_AI_API_KEY=${GOOGLE_AI_KEY}
EOF

chmod 600 .env
echo -e "${GREEN}✓ Configuration created${NC}"

# Save secrets backup
cat > ../.secrets-backup.txt <<EOF
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

chmod 600 ../.secrets-backup.txt

# Start services
echo ""
echo -e "${BLUE}🚀 Starting Synap...${NC}"

# Build and start services
docker compose up -d --build

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

if [ "$USE_SSL" = "true" ]; then
    echo -e "${BLUE}🌐 Domain:${NC} https://${DOMAIN}"
else
    echo -e "${BLUE}🌐 Access:${NC} http://${DOMAIN}:4000"
fi

echo ""
echo -e "${YELLOW}⚠️  IMPORTANT NEXT STEPS:${NC}"
echo ""

if [ "$DEPLOYMENT_TYPE" = "1" ]; then
    # Custom domain
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
elif [ "$DEPLOYMENT_TYPE" = "2" ]; then
    # Synap subdomain
    echo "1. Backup your secrets:"
    echo "   scp ${INSTALL_DIR}/.secrets-backup.txt your-local-machine:~/"
    echo "   rm ${INSTALL_DIR}/.secrets-backup.txt"
    echo ""
    echo "2. Your Synap instance is ready!"
    echo "   https://${DOMAIN}"
    echo ""
    echo "3. Manage your instance:"
    echo "   https://synap.live/dashboard/instances"
    echo ""
    echo "✅ DNS is already configured!"
    echo "✅ SSL certificate will be auto-provisioned!"
else
    # Localhost
    echo "1. Backup your secrets:"
    echo "   cp ${INSTALL_DIR}/.secrets-backup.txt ~/synap-secrets.txt"
    echo "   rm ${INSTALL_DIR}/.secrets-backup.txt"
    echo ""
    echo "2. Access Synap (HTTP only, no SSL):"
    echo "   http://localhost:4000"
    echo ""
    echo "⚠️  Localhost mode is for testing only!"
    echo "   For production, use a custom domain or Synap subdomain."
fi

echo ""
echo -e "${BLUE}📚 Documentation:${NC} https://docs.synap.live"
echo -e "${BLUE}💬 Community:${NC} https://discord.gg/synap"
echo -e "${BLUE}🐛 Issues:${NC} https://github.com/synap-labs/synap-backend/issues"
echo ""
echo -e "${BLUE}🛠️  Management Commands:${NC}"
echo "  ${INSTALL_DIR}/deploy/synap-cli health    # Check system health"
echo "  ${INSTALL_DIR}/deploy/synap-cli logs      # View logs"
echo "  ${INSTALL_DIR}/deploy/synap-cli update    # Update Synap"
echo "  ${INSTALL_DIR}/deploy/synap-cli backup    # Backup data"
echo ""
