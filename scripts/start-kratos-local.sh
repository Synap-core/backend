#!/bin/bash
# Start local Kratos for debugging (keeps other services remote)

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo -e "${BLUE}🔐 Starting Local Kratos for Debugging${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check if docker-compose.local.yml exists
if [ ! -f "docker-compose.local.yml" ]; then
    echo -e "${RED}❌ Error: docker-compose.local.yml not found!${NC}"
    exit 1
fi

# Check if Docker is running
if ! docker ps &> /dev/null; then
    echo -e "${RED}❌ Error: Docker is not running!${NC}"
    echo ""
    echo -e "Please start Docker and try again."
    exit 1
fi

echo -e "${BLUE}📦 Starting Kratos and dependencies...${NC}"
echo ""

# Start Kratos + PostgreSQL (Kratos needs its own database)
docker compose -f docker-compose.local.yml up -d kratos-migrate postgres

echo ""
echo -e "${YELLOW}⏳ Waiting for PostgreSQL to be ready...${NC}"
sleep 5

# Wait for PostgreSQL to be healthy
for i in {1..30}; do
    if docker compose -f docker-compose.local.yml ps postgres | grep -q "healthy"; then
        echo -e "${GREEN}✅ PostgreSQL is ready${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}❌ PostgreSQL failed to start${NC}"
        exit 1
    fi
    sleep 1
done

# Start Kratos
echo ""
echo -e "${BLUE}🚀 Starting Kratos...${NC}"
docker compose -f docker-compose.local.yml up -d kratos

echo ""
echo -e "${YELLOW}⏳ Waiting for Kratos to be ready...${NC}"
sleep 5

# Wait for Kratos to be healthy
for i in {1..30}; do
    if curl -s http://localhost:4433/health/ready &> /dev/null; then
        echo -e "${GREEN}✅ Kratos is ready${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${YELLOW}⚠️  Kratos may still be starting...${NC}"
        echo -e "   Check logs: ${BLUE}docker logs synap-kratos-local${NC}"
        break
    fi
    sleep 1
done

echo ""
echo -e "${GREEN}✅ Local Kratos is running!${NC}"
echo ""
echo -e "${BLUE}📋 Service URLs:${NC}"
echo -e "  Kratos Public:  ${GREEN}http://localhost:4433${NC}"
echo -e "  Kratos Admin:   ${GREEN}http://localhost:4434${NC}"
echo ""
echo -e "${YELLOW}💡 Next Steps:${NC}"
echo -e "  1. Update .env.development.local:"
echo -e "     ${GREEN}KRATOS_PUBLIC_URL=http://localhost:4433${NC}"
echo -e "     ${GREEN}KRATOS_ADMIN_URL=http://localhost:4434${NC}"
echo ""
echo -e "  2. Start backend API:"
echo -e "     ${GREEN}pnpm dev:api${NC}"
echo ""
echo -e "  3. View Kratos logs:"
echo -e "     ${GREEN}docker logs synap-kratos-local -f${NC}"
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
