#!/bin/bash
# Exit on error, but allow certain commands to fail
set -e
# Ensure we're using bash, not sh
if [ -z "$BASH_VERSION" ]; then
    echo "This script requires bash. Please run with: bash install.sh"
    exit 1
fi

# Synap Backend - One-Command Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/deploy/install.sh | bash
# Or: git clone https://github.com/Synap-core/backend.git && cd backend/deploy && ./install.sh

# ============================================================================
# INSTALLER DIRECTORY DETECTION
# ============================================================================
# Detect the directory where this installer script is located
# This allows us to save/load .env file in the same directory as the installer
INSTALLER_DIR=""
if [ -n "${BASH_SOURCE[0]}" ]; then
    # Script is being executed directly
    INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
elif [ -n "$0" ] && [ "$0" != "bash" ]; then
    # Fallback for piped execution
    INSTALLER_DIR="$(pwd)"
else
    # Last resort: use current directory
    INSTALLER_DIR="$(pwd)"
fi
INSTALLER_ENV_FILE="${INSTALLER_DIR}/.env"

# ============================================================================
# HELPER FUNCTIONS FOR .ENV FILE MANAGEMENT
# ============================================================================

# Safely load a variable from .env file (prevents code execution)
load_env_var() {
    local var_name=$1
    local default_value=$2
    
    if [ -f "$INSTALLER_ENV_FILE" ]; then
        # Use grep to find the line, then extract value safely
        # This prevents execution of any code in the .env file
        local value=$(grep "^${var_name}=" "$INSTALLER_ENV_FILE" 2>/dev/null | cut -d'=' -f2- | sed 's/^"//;s/"$//' | sed "s/^'//;s/'$//")
        if [ -n "$value" ]; then
            echo "$value"
            return
        fi
    fi
    
    echo "$default_value"
}

# Save a variable to .env file
save_env_var() {
    local var_name=$1
    local var_value=$2
    
    # Create .env file if it doesn't exist
    if [ ! -f "$INSTALLER_ENV_FILE" ]; then
        echo "# Synap Backend Installer Configuration" > "$INSTALLER_ENV_FILE"
        echo "# This file stores your installation preferences" >> "$INSTALLER_ENV_FILE"
        echo "# Generated: $(date)" >> "$INSTALLER_ENV_FILE"
        echo "" >> "$INSTALLER_ENV_FILE"
    fi
    
    # Remove existing entry if it exists
    if grep -q "^${var_name}=" "$INSTALLER_ENV_FILE" 2>/dev/null; then
        # Use sed to update in-place (works on macOS and Linux)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "/^${var_name}=/d" "$INSTALLER_ENV_FILE"
        else
            sed -i "/^${var_name}=/d" "$INSTALLER_ENV_FILE"
        fi
    fi
    
    # Append new entry (escape special characters in value)
    local escaped_value=$(echo "$var_value" | sed 's/[\/&]/\\&/g')
    echo "${var_name}=${escaped_value}" >> "$INSTALLER_ENV_FILE"
}

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

# ============================================================================
# LOAD EXISTING CONFIGURATION FROM INSTALLER .ENV FILE
# ============================================================================
if [ -f "$INSTALLER_ENV_FILE" ]; then
    echo -e "${YELLOW}👉 Found existing configuration in ${INSTALLER_ENV_FILE}${NC}"
    echo -e "${YELLOW}   Defaults will be loaded from this file.${NC}"
    echo ""
fi

# Load all defaults from installer .env file
DEFAULT_DEPLOYMENT_TYPE=$(load_env_var "DEPLOYMENT_TYPE" "")
DEFAULT_DOMAIN=$(load_env_var "DOMAIN" "")
DEFAULT_EMAIL=$(load_env_var "LETSENCRYPT_EMAIL" "")
DEFAULT_ADMIN_EMAIL=$(load_env_var "ADMIN_EMAIL" "")
DEFAULT_ADMIN_NAME=$(load_env_var "ADMIN_NAME" "")
DEFAULT_INTELLIGENCE_URL=$(load_env_var "INTELLIGENCE_HUB_URL" "http://localhost:3001")
DEFAULT_INTELLIGENCE_KEY=$(load_env_var "INTELLIGENCE_API_KEY" "")
DEFAULT_AI_PROVIDER=$(load_env_var "AI_PROVIDER" "none")
DEFAULT_OPENAI_KEY=$(load_env_var "OPENAI_API_KEY" "")
DEFAULT_ANTHROPIC_KEY=$(load_env_var "ANTHROPIC_API_KEY" "")
DEFAULT_GOOGLE_AI_KEY=$(load_env_var "GOOGLE_AI_API_KEY" "")
DEFAULT_INSTALL_DIR=$(load_env_var "INSTALL_DIR" "/opt/synap-backend")

# Prompt for configuration
echo -e "${BLUE}📝 Deployment Configuration${NC}"
echo ""

# Deployment Type Choice
echo "Choose deployment type:"
echo "  [1] Custom domain (you manage DNS)"
echo "  [2] Synap subdomain (*.synap.live) ⭐ RECOMMENDED"
echo "  [3] Localhost only (no SSL, for testing)"
if [ -n "$DEFAULT_DEPLOYMENT_TYPE" ]; then
    echo ""
    read -p "Choice [1-3] [${DEFAULT_DEPLOYMENT_TYPE}]: " DEPLOYMENT_TYPE
    DEPLOYMENT_TYPE=${DEPLOYMENT_TYPE:-$DEFAULT_DEPLOYMENT_TYPE}
else
echo ""
read -p "Choice [1-3]: " DEPLOYMENT_TYPE
fi

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
        
        # Save to installer .env
        save_env_var "DEPLOYMENT_TYPE" "$DEPLOYMENT_TYPE"
        save_env_var "DOMAIN" "$DOMAIN"
        save_env_var "LETSENCRYPT_EMAIL" "$EMAIL"
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
                read -p "Enter your email (for SSL certificates) [${DEFAULT_EMAIL}]: " EMAIL
                EMAIL=${EMAIL:-$DEFAULT_EMAIL}
                while [ -z "$EMAIL" ]; do
                    echo -e "${RED}Email is required!${NC}"
                    read -p "Enter your email: " EMAIL
                done
                
                # Save to installer .env
                save_env_var "DEPLOYMENT_TYPE" "$DEPLOYMENT_TYPE"
                save_env_var "DOMAIN" "$DOMAIN"
                save_env_var "LETSENCRYPT_EMAIL" "$EMAIL"
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
        save_env_var "DEPLOYMENT_TYPE" "$DEPLOYMENT_TYPE"
        save_env_var "DOMAIN" "$DOMAIN"
        save_env_var "LETSENCRYPT_EMAIL" "$EMAIL"
        ;;
    *)
        echo -e "${RED}Invalid choice. Defaulting to localhost.${NC}"
        DOMAIN="localhost"
        EMAIL="noreply@localhost"
        USE_SSL="false"
        DEPLOYMENT_TYPE="3"
        save_env_var "DEPLOYMENT_TYPE" "$DEPLOYMENT_TYPE"
        save_env_var "DOMAIN" "$DOMAIN"
        save_env_var "LETSENCRYPT_EMAIL" "$EMAIL"
        ;;
esac

# If we ended up in localhost mode from failed Synap provisioning
if [ "$DEPLOYMENT_TYPE" = "3" ]; then
    DOMAIN="localhost"
    EMAIL="noreply@localhost"
    USE_SSL="false"
fi

# ============================================================================
# ADMIN ACCOUNT CONFIGURATION (Self-Hosted)
# ============================================================================
echo ""
echo -e "${BLUE}👤 Admin Account Setup${NC}"
echo "For self-hosted installations, you need to create an admin account."
echo "This account will have full access to your Synap backend."
echo ""

read -p "Admin email [${DEFAULT_ADMIN_EMAIL}]: " ADMIN_EMAIL
ADMIN_EMAIL=${ADMIN_EMAIL:-$DEFAULT_ADMIN_EMAIL}
if [ -z "$ADMIN_EMAIL" ]; then
    echo -e "${RED}❌ Admin email is required${NC}"
    exit 1
fi
save_env_var "ADMIN_EMAIL" "$ADMIN_EMAIL"

# Basic email validation
if [[ ! "$ADMIN_EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
    echo -e "${YELLOW}⚠️  Email format looks invalid. Continuing anyway...${NC}"
fi

read -sp "Admin password: " ADMIN_PASSWORD
echo ""
read -sp "Confirm admin password: " ADMIN_PASSWORD_CONFIRM
echo ""

if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
    echo -e "${RED}❌ Passwords do not match${NC}"
    exit 1
fi

if [ ${#ADMIN_PASSWORD} -lt 8 ]; then
    echo -e "${YELLOW}⚠️  Password should be at least 8 characters${NC}"
    read -p "Continue anyway? (y/N): " CONTINUE
    if [[ ! "$CONTINUE" =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

read -p "Admin name (optional) [${DEFAULT_ADMIN_NAME}]: " ADMIN_NAME
ADMIN_NAME=${ADMIN_NAME:-$DEFAULT_ADMIN_NAME}
if [ -n "$ADMIN_NAME" ]; then
    save_env_var "ADMIN_NAME" "$ADMIN_NAME"
fi

# ============================================================================
# INTELLIGENCE SERVICE CONFIGURATION (Server 2)
# ============================================================================
echo ""
echo -e "${BLUE}🧠 Synap Intelligence Service${NC}"
echo "Enter the details from your Intelligence Service installation (Server 2)."
echo "If you haven't installed it yet, you can configure this later."
echo ""

# Initialize intelligence variables
INTELLIGENCE_URL=""
INTELLIGENCE_KEY=""

read -p "Intelligence Hub URL [${DEFAULT_INTELLIGENCE_URL}]: " INTELLIGENCE_URL
INTELLIGENCE_URL=${INTELLIGENCE_URL:-$DEFAULT_INTELLIGENCE_URL}
save_env_var "INTELLIGENCE_HUB_URL" "$INTELLIGENCE_URL"

read -p "Intelligence API Key [${DEFAULT_INTELLIGENCE_KEY:0:10}...]: " INTELLIGENCE_KEY || true
if [ -z "$INTELLIGENCE_KEY" ]; then
    INTELLIGENCE_KEY=${DEFAULT_INTELLIGENCE_KEY:-""}
    if [ -z "$INTELLIGENCE_KEY" ]; then
        echo -e "${YELLOW}⚠️  No API Key provided. Use 'synap-cli secrets update' later to set it.${NC}"
    else
        echo -e "${GREEN}✓ Using saved API Key${NC}"
    fi
else
    echo -e "${GREEN}✓ Key recorded${NC}"
    save_env_var "INTELLIGENCE_API_KEY" "$INTELLIGENCE_KEY"
fi

# ============================================================================
# AI CONFIGURATION (Optional)
# ============================================================================
echo ""
echo -e "${BLUE}🤖 AI Service Configuration (Optional)${NC}"
echo "These can be configured later in the setup wizard."
echo ""

read -p "Default AI Provider (openai/anthropic/none) [${DEFAULT_AI_PROVIDER}]: " AI_PROVIDER
AI_PROVIDER=${AI_PROVIDER:-$DEFAULT_AI_PROVIDER}
save_env_var "AI_PROVIDER" "$AI_PROVIDER"

# Initialize AI keys from defaults
OPENAI_KEY="$DEFAULT_OPENAI_KEY"
ANTHROPIC_KEY="$DEFAULT_ANTHROPIC_KEY"
GOOGLE_AI_API_KEY="$DEFAULT_GOOGLE_AI_KEY"
EMBEDDING_PROVIDER=""

if [ "$AI_PROVIDER" = "openai" ]; then
    read -p "OpenAI API Key [${DEFAULT_OPENAI_KEY:0:10}...]: " OPENAI_KEY
    OPENAI_KEY=${OPENAI_KEY:-$DEFAULT_OPENAI_KEY}
    if [ -n "$OPENAI_KEY" ]; then
        save_env_var "OPENAI_API_KEY" "$OPENAI_KEY"
    fi
elif [ "$AI_PROVIDER" = "anthropic" ]; then
    read -p "Anthropic API Key [${DEFAULT_ANTHROPIC_KEY:0:10}...]: " ANTHROPIC_KEY
    ANTHROPIC_KEY=${ANTHROPIC_KEY:-$DEFAULT_ANTHROPIC_KEY}
    if [ -n "$ANTHROPIC_KEY" ]; then
        save_env_var "ANTHROPIC_API_KEY" "$ANTHROPIC_KEY"
    fi
fi

# ============================================================================
# Generate secrets
# ============================================================================
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
HYDRA_SECRETS_SYSTEM=$(get_secret ORY_HYDRA_SECRETS_SYSTEM)

echo -e "${GREEN}✓ Secrets loaded/generated${NC}"

# --- Path Selection ---
echo ""
echo -e "${BLUE}📁 Installation Path${NC}"
echo "The default installation path is /opt/synap-backend."
echo "This requires sudo privileges to create."
echo ""

# Check if we have a saved install directory
if [ -n "$DEFAULT_INSTALL_DIR" ] && [ "$DEFAULT_INSTALL_DIR" != "/opt/synap-backend" ]; then
    echo -e "${YELLOW}👉 Found saved installation path: ${DEFAULT_INSTALL_DIR}${NC}"
    read -p "Use saved path? (Y/n): " USE_SAVED_PATH
    if [[ ! "$USE_SAVED_PATH" =~ ^[Nn]$ ]]; then
        INSTALL_DIR="$DEFAULT_INSTALL_DIR"
        echo -e "${GREEN}✓ Using saved path: ${INSTALL_DIR}${NC}"
    else
        read -p "Do you want to use a custom installation path? (y/N): " USE_CUSTOM_PATH
        INSTALL_DIR="/opt/synap-backend"
        if [[ "$USE_CUSTOM_PATH" =~ ^[Yy]$ ]]; then
            echo ""
            echo "Please provide an absolute path for the installation."
            echo "e.g., /home/youruser/synap or ~/pkm_stacks/synap"
            read -p "Enter custom installation path: " CUSTOM_PATH
            while [ -z "$CUSTOM_PATH" ]; do
                echo -e "${RED}Path cannot be empty!${NC}"
                read -p "Enter custom installation path: " CUSTOM_PATH
            done
            if command -v realpath &> /dev/null; then
                INSTALL_DIR=$(realpath -m "$CUSTOM_PATH")
            else
                INSTALL_DIR=$(eval echo "$CUSTOM_PATH")
            fi
            echo -e "${GREEN}✓ Using custom path: ${INSTALL_DIR}${NC}"
        else
            echo -e "${GREEN}✓ Using default path: ${INSTALL_DIR}${NC}"
        fi
    fi
else
    read -p "Do you want to use a custom installation path? (y/N): " USE_CUSTOM_PATH
    INSTALL_DIR="/opt/synap-backend"
    if [[ "$USE_CUSTOM_PATH" =~ ^[Yy]$ ]]; then
        echo ""
        echo "Please provide an absolute path for the installation."
        echo "e.g., /home/youruser/synap or ~/pkm_stacks/synap"
        read -p "Enter custom installation path: " CUSTOM_PATH
        while [ -z "$CUSTOM_PATH" ]; do
            echo -e "${RED}Path cannot be empty!${NC}"
            read -p "Enter custom installation path: " CUSTOM_PATH
        done
        if command -v realpath &> /dev/null; then
            INSTALL_DIR=$(realpath -m "$CUSTOM_PATH")
        else
            INSTALL_DIR=$(eval echo "$CUSTOM_PATH")
        fi
        echo -e "${GREEN}✓ Using custom path: ${INSTALL_DIR}${NC}"
    else
        echo -e "${GREEN}✓ Using default path: ${INSTALL_DIR}${NC}"
    fi
fi

# Check for sudo if using the default /opt path
if [ "$INSTALL_DIR" = "/opt/synap-backend" ] && [ ! -w "/opt" ] && [ "$EUID" -ne 0 ]; then
    echo ""
    echo -e "${YELLOW}⚠️  The default path /opt/synap-backend requires root privileges to create.${NC}"
    echo "Please re-run the script with 'sudo' or choose a custom path in your home directory."
    exit 1
fi

# Save installation path
save_env_var "INSTALL_DIR" "$INSTALL_DIR"
# --- End of Path Selection ---

echo -e "${BLUE}📁 Creating installation directory: ${INSTALL_DIR}${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠️  Directory already exists${NC}"
    read -p "Overwrite? This will delete existing data! (y/N): " OVERWRITE
    if [[ "$OVERWRITE" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}🧹 Wiping existing Docker volumes...${NC}"
        if [ -f "$INSTALL_DIR/deploy/docker-compose.yml" ]; then
            (cd "$INSTALL_DIR/deploy" && docker compose down -v 2>/dev/null || true)
        elif [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
             (cd "$INSTALL_DIR" && docker compose down -v 2>/dev/null || true)
        fi
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
# 
# GitHub Repository (for Docker images)
# Change this if using a fork or private registry
GITHUB_REPOSITORY=synap-core/backend

# Backend Version (pin to specific version or use 'latest')
# Examples: latest, v1.2.3, main
BACKEND_VERSION=latest

# Docker Compose Project Name (prevents conflicts)
COMPOSE_PROJECT_NAME=synap-backend

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
# AI & INTELLIGENCE
# ============================================================================
AI_PROVIDER=${AI_PROVIDER}
EMBEDDING_PROVIDER=${EMBEDDING_PROVIDER}
INTELLIGENCE_HUB_URL=${INTELLIGENCE_URL}
INTELLIGENCE_API_KEY=${INTELLIGENCE_KEY}
OPENAI_API_KEY=${OPENAI_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
GOOGLE_AI_API_KEY=${GOOGLE_AI_KEY}
ORY_HYDRA_SECRETS_SYSTEM=${HYDRA_SECRETS_SYSTEM}

# ============================================================================
# ADMIN (Self-Hosted)
# ============================================================================
ADMIN_EMAIL=${ADMIN_EMAIL}
EOF

chmod 600 .env
echo -e "${GREEN}✓ Configuration created${NC}"

# Save secrets backup
cat > ../synap-backend-secrets.txt <<EOF
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
HYDRA_SECRETS_SYSTEM=${HYDRA_SECRETS_SYSTEM}
EOF

chmod 600 ../synap-backend-secrets.txt

# Start services
echo ""
echo -e "${BLUE}🚀 Starting Synap...${NC}"

# Try to pull images first (fast, if available)
# If pull fails, docker-compose will build from source automatically
echo -e "${BLUE}📥 Pulling Docker images (if available)...${NC}"
docker compose pull --ignore-pull-failures || true

# Build any images that couldn't be pulled (fallback)
echo -e "${BLUE}🔨 Building images (if needed)...${NC}"
docker compose build --pull || true

# Start all services
echo -e "${BLUE}▶️  Starting services...${NC}"
docker compose up -d

# Wait for services to be healthy
echo ""
echo -e "${BLUE}⏳ Waiting for services to start (this may take 1-2 minutes)...${NC}"
sleep 30

# Wait for backend to be healthy
echo -e "${BLUE}⏳ Waiting for backend to be ready...${NC}"
MAX_WAIT=120
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
  if docker compose exec -T backend curl -f http://localhost:4000/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Backend is ready${NC}"
    break
  fi
  echo -n "."
  sleep 2
  WAIT_COUNT=$((WAIT_COUNT + 2))
done

if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
  echo -e "${YELLOW}⚠️  Backend health check timeout. Continuing anyway...${NC}"
fi

# Database migrations are handled automatically by the backend-migrate service
# configured in docker-compose.yml. The backend service waits for it to complete.

# Create admin user if credentials provided
if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  echo ""
  echo -e "${BLUE}👤 Creating admin user...${NC}"
  docker compose exec -T backend \
    ADMIN_EMAIL="$ADMIN_EMAIL" \
    ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    ADMIN_NAME="$ADMIN_NAME" \
    node scripts/create-admin-cli.js
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Admin user created successfully${NC}"
    echo -e "${GREEN}   You can now login with: ${ADMIN_EMAIL}${NC}"
  else
    echo -e "${YELLOW}⚠️  Failed to create admin user. You can create it manually later via registration.${NC}"
  fi
fi

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
    echo "   scp ${INSTALL_DIR}/synap-backend-secrets.txt your-local-machine:~/"
    echo "   rm ${INSTALL_DIR}/synap-backend-secrets.txt"
    echo ""
    echo "3. Wait for SSL certificate (1-2 minutes after DNS propagates)"
    echo ""
    echo "4. Access Synap:"
    echo "   https://${DOMAIN}"
elif [ "$DEPLOYMENT_TYPE" = "2" ]; then
    # Synap subdomain
    echo "1. Backup your secrets:"
    echo "   scp ${INSTALL_DIR}/synap-backend-secrets.txt your-local-machine:~/"
    echo "   rm ${INSTALL_DIR}/synap-backend-secrets.txt"
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
    # Get local network IP for better display
    # Try hostname -I (linux), then ip route, then ifconfig
    LOCAL_IP=""
    if command -v hostname &> /dev/null; then
        LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    
    if [ -z "$LOCAL_IP" ] && command -v ip &> /dev/null; then
        LOCAL_IP=$(ip route get 1 2>/dev/null | awk '{print $7}')
    fi
    
    # Fallback to localhost if detection fails
    DISPLAY_HOST=${LOCAL_IP:-localhost}

    echo "1. Backup your secrets:"
    echo "   cp ${INSTALL_DIR}/synap-backend-secrets.txt ~/synap-secrets.txt"
    echo "   rm ${INSTALL_DIR}/synap-backend-secrets.txt"
    echo ""
    echo "2. Connect your Frontend App:"
    echo "   Use this URL in the Synap Setup page:"
    echo -e "   ${GREEN}http://${DISPLAY_HOST}:4000${NC}"
    echo ""
    echo "   (Or locally: http://localhost:4000)"
    echo ""
    echo "3. Verify Installation:"
    echo "   Health Check: http://${DISPLAY_HOST}:4000/health"
    echo ""
    echo "⚠️  This is the Backend API only. You need 'synap-app' (Frontend) to use the UI."
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
if [ -f "$INSTALLER_ENV_FILE" ]; then
    echo -e "${GREEN}💾 Configuration saved to:${NC} ${INSTALLER_ENV_FILE}"
    echo -e "${YELLOW}   Next time you run the installer, it will use these values as defaults.${NC}"
    echo ""
fi