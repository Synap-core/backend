#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Banner
echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║           Synap Backend - Start Services                  ║"
echo "║                                                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running from correct directory
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}❌ Error: docker-compose.yml not found${NC}"
    echo "Please run this script from /srv/synap directory"
    exit 1
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ Error: .env file not found${NC}"
    echo "Run setup-production.sh first to generate configuration"
    exit 1
fi

# Load environment
source .env

echo -e "${BLUE}🔍 Verifying Configuration...${NC}"
echo ""

# Check required env vars
REQUIRED_VARS=(
    "POSTGRES_PASSWORD"
    "INTELLIGENCE_API_KEY"
    "TYPESENSE_API_KEY"
)

MISSING_VARS=()
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo -e "${RED}❌ Missing required environment variables:${NC}"
    for var in "${MISSING_VARS[@]}"; do
        echo "  - $var"
    done
    exit 1
fi

echo -e "${GREEN}✓ All required variables present${NC}"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running${NC}"
    echo "Start Docker first: systemctl start docker"
    exit 1
fi

echo -e "${GREEN}✓ Docker is running${NC}"
echo ""

# Ask for confirmation
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Configuration:${NC}"
echo "  Mode: ${DEPLOYMENT_MODE}"
echo "  Database: PostgreSQL (persistent volume)"
echo "  Search: Typesense"
echo "  Storage: MinIO"
echo "  Jobs: Inngest"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
read -p "Start all services? (y/n): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Cancelled${NC}"
    exit 0
fi

echo ""
echo -e "${BLUE}🚀 Starting Services...${NC}"
echo ""

# Pull latest images
echo -e "${BLUE}📦 Pulling Docker images...${NC}"
docker compose pull

# Build backend and intelligence service
echo -e "${BLUE}🔨 Building services...${NC}"
docker compose build

# Start services
echo -e "${BLUE}▶️  Starting containers...${NC}"
docker compose up -d

echo ""
echo -e "${GREEN}✓ Services started${NC}"
echo ""

# Wait for services to be healthy
echo -e "${BLUE}⏳ Waiting for services to be healthy...${NC}"
echo ""

# Function to check service health
check_health() {
    local service=$1
    local url=$2
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ $service is healthy${NC}"
            return 0
        fi
        echo -n "."
        sleep 2
        attempt=$((attempt + 1))
    done
    
    echo -e "${RED}✗ $service health check failed${NC}"
    return 1
}

# Check PostgreSQL
echo -n "Checking PostgreSQL... "
if docker compose exec -T postgres pg_isready -U synap > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${YELLOW}Starting...${NC}"
    sleep 5
fi

# Check Typesense
echo -n "Checking Typesense... "
check_health "Typesense" "http://localhost:8108/health" || true

# Check MinIO
echo -n "Checking MinIO... "
check_health "MinIO" "http://localhost:9000/minio/health/live" || true

# Check Backend
echo -n "Checking Backend... "
check_health "Backend" "http://localhost:4000/health" || true

# Check Intelligence Service
echo -n "Checking Intelligence Service... "
check_health "Intelligence Service" "http://localhost:3001/health" || true

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Deployment Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📊 Service Status:${NC}"
docker compose ps
echo ""
echo -e "${BLUE}📝 Useful Commands:${NC}"
echo "  View logs:        docker compose logs -f"
echo "  View specific:    docker compose logs -f backend"
echo "  Stop services:    docker compose down"
echo "  Restart:          docker compose restart"
echo "  Shell (backend):  docker compose exec backend sh"
echo ""
echo -e "${BLUE}🌐 Access Points:${NC}"
if [ "$DEPLOYMENT_MODE" == "demo" ]; then
    echo "  Backend API:      https://backend.demo.synap.live"
    echo "  Health Check:     https://backend.demo.synap.live/health"
else
    echo "  Backend API:      https://backend.synap.live"
    echo "  Health Check:     https://backend.synap.live/health"
fi
echo ""
echo -e "${YELLOW}📋 Next Steps:${NC}"
echo "  1. Run database migrations:"
echo "     docker compose exec backend sh -c 'cd packages/database && pnpm db:migrate'"
echo ""
echo "  2. Seed demo workspace (if demo mode):"
echo "     docker compose exec backend sh -c 'cd packages/database && pnpm db:seed'"
echo ""
echo "  3. Check logs for errors:"
echo "     docker compose logs -f backend"
echo ""
