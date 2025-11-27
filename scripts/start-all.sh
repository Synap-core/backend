#!/bin/bash

# Start Synap Data Pod
# This script starts the Data Pod and required Docker services

set -e

echo "🚀 Starting Synap Data Pod..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Start Docker services
echo -e "${BLUE}📦 Starting Docker services...${NC}"
docker compose up -d

# Wait for services to be ready
echo -e "${BLUE}⏳ Waiting for services to be ready...${NC}"
sleep 5

# Check if migrations are needed
echo -e "${BLUE}📊 Checking migrations...${NC}"
if [ -f ".env" ]; then
    pnpm db:migrate || echo "⚠️  Migration failed, but continuing..."
else
    echo "⚠️  .env file not found. Please create it from .env.example"
fi

# Start Data Pod
echo -e "${GREEN}🌐 Starting Data Pod (port 3000)...${NC}"
pnpm --filter api dev &
DATA_POD_PID=$!

echo ""
echo -e "${GREEN}✅ Data Pod started!${NC}"
echo ""
echo "📊 Services:"
echo "  - Data Pod:      http://localhost:3000"
echo "  - Ory Kratos:    http://localhost:4433"
echo "  - Ory Hydra:     http://localhost:4444"
echo ""
echo "Press Ctrl+C to stop the service"

# Wait for user interrupt
trap "echo ''; echo '🛑 Stopping service...'; kill $DATA_POD_PID 2>/dev/null; exit" INT TERM

wait

