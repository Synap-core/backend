#!/bin/bash
# Start local backend API with remote services
# Uses .env.development.local automatically

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

echo -e "${BLUE}🚀 Starting Local Backend with Remote Services${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check if .env.development.local exists
if [ ! -f ".env.development.local" ]; then
    echo -e "${RED}❌ Error: .env.development.local not found!${NC}"
    echo ""
    echo -e "${YELLOW}Please create .env.development.local with remote server configuration.${NC}"
    echo ""
    echo -e "You can:"
    echo -e "  1. Copy from example: ${GREEN}cp .env.development.local.example .env.development.local${NC}"
    echo -e "  2. Or run setup script: ${GREEN}./scripts/setup-remote-dev.sh${NC}"
    echo ""
    exit 1
fi

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}❌ Error: pnpm not found!${NC}"
    echo ""
    echo -e "Install pnpm: ${GREEN}npm install -g pnpm${NC}"
    exit 1
fi

# Verify remote services are accessible (optional check)
echo -e "${BLUE}📋 Configuration Check${NC}"
echo ""

# Extract server host from DATABASE_URL if present
if grep -q "DATABASE_URL=" .env.development.local; then
    DB_URL=$(grep "^DATABASE_URL=" .env.development.local | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    if [[ $DB_URL == *"@"* ]]; then
        SERVER_HOST=$(echo "$DB_URL" | sed -E 's/.*@([^:]+):.*/\1/')
        echo -e "  Server: ${GREEN}${SERVER_HOST}${NC}"
    fi
fi

# Check if API port is set
if grep -q "^PORT=" .env.development.local; then
    PORT=$(grep "^PORT=" .env.development.local | cut -d'=' -f2 | tr -d '"' | tr -d "'")
    echo -e "  API Port: ${GREEN}${PORT:-4000}${NC}"
else
    echo -e "  API Port: ${GREEN}4000${NC} (default)"
fi

echo ""
echo -e "${BLUE}🔧 Starting Backend API...${NC}"
echo -e "${YELLOW}  (Uses .env.development.local automatically)${NC}"
echo ""
echo -e "${YELLOW}💡 Tip:${NC} Frontend should connect to: ${GREEN}http://localhost:${PORT:-4000}${NC}"
echo ""

# Start the API
pnpm --filter api dev
