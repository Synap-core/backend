#!/bin/bash
set -e

echo "🚀 Starting Synap Backend..."
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
  echo -e "${RED}❌ Docker is not running. Please start Docker Desktop and try again.${NC}"
  exit 1
fi

echo -e "${BLUE}📦 Step 1: Starting Docker services...${NC}"
docker compose --profile auth up -d

echo ""
echo -e "${BLUE}⏳ Step 2: Waiting for services to be ready...${NC}"
sleep 5

# Wait for Postgres to be healthy
echo "   Waiting for PostgreSQL..."
until docker exec synap-postgres pg_isready -U postgres > /dev/null 2>&1; do
  echo "   Still waiting for PostgreSQL..."
  sleep 2
done
echo -e "${GREEN}   ✓ PostgreSQL ready${NC}"

# Wait for Kratos to be healthy
echo "   Waiting for Kratos..."
until curl -s http://localhost:4433/health/ready | grep -q "ok"; do
  echo "   Still waiting for Kratos..."
  sleep 2
done
echo -e "${GREEN}   ✓ Kratos ready${NC}"

echo ""
echo -e "${BLUE}🗄️  Step 3: Running database migrations...${NC}"
cd packages/database

# Check if tables already exist
if docker exec synap-postgres psql -U postgres -d synap -c "\dt" 2>/dev/null | grep -q "users"; then
  echo -e "${YELLOW}   Tables already exist. Skipping migrations.${NC}"
else
  echo "   Applying database schema..."
  # Use migrate script (non-interactive, production-grade)
  pnpm run db:migrate
  echo -e "${GREEN}   ✓ Migrations complete${NC}"
fi

cd ../..

echo ""
echo -e "${GREEN}✅ Backend is ready!${NC}"
echo ""
echo -e "${BLUE}📊 Service Status:${NC}"
echo "   • PostgreSQL:   http://localhost:5432"
echo "   • MinIO:        http://localhost:9001 (console)"
echo "   • Kratos API:   http://localhost:4433"
echo "   • Kratos Admin: http://localhost:4434"
echo ""
echo -e "${BLUE}🎯 Next Steps:${NC}"
echo "   1. Start the API server:"
echo "      ${YELLOW}pnpm exec turbo run dev --filter='@synap/realtime' --filter='api' --filter='@synap/jobs'${NC}"
echo ""
echo "   2. Start the frontend (in synap-app directory):"
echo "      ${YELLOW}pnpm exec turbo run dev --filter='web'${NC}"
echo ""
echo "   3. Open your browser:"
echo "      ${YELLOW}http://localhost:3000/setup${NC}"
echo ""
echo -e "${GREEN}Happy coding! 🎉${NC}"
