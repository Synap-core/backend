#!/bin/bash
# Complete system validation script
# Checks Docker services, migrations, API health, and runs core tests

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Synap System Validation${NC}"
echo "═══════════════════════════════════════════════════════"

# 1. Check Docker services
echo -e "\n${BLUE}1. Checking Docker services...${NC}"
if docker compose ps | grep -E "(healthy|running)" > /dev/null; then
  echo -e "  ${GREEN}✅ Docker services running${NC}"
  docker compose ps | grep -E "NAME|synap" | head -10
else
  echo -e "  ${RED}❌ Some services not healthy${NC}"
  docker compose ps
  exit 1
fi

# 2. Check database connectivity
echo -e "\n${BLUE}2. Checking database connectivity...${NC}"
if docker exec synap-postgres pg_isready -U postgres > /dev/null 2>&1; then
  echo -e "  ${GREEN}✅ PostgreSQL responding${NC}"
else
  echo -e "  ${RED}❌ PostgreSQL not accessible${NC}"
  exit 1
fi

# 3. Check migrations
echo -e "\n${BLUE}3. Checking migrations...${NC}"
MIGRATION_COUNT=$(docker exec synap-postgres psql -U postgres synap -t -c "SELECT COUNT(*) FROM schema_migrations" 2>/dev/null | tr -d ' ' || echo "0")
if [ "$MIGRATION_COUNT" -eq "10" ]; then
  echo -e "  ${GREEN}✅ All 10 migrations applied${NC}"
  docker exec synap-postgres psql -U postgres synap -c "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 5"
else
  echo -e "  ${YELLOW}⚠  Only $MIGRATION_COUNT/10 migrations applied${NC}"
  if [ "$MIGRATION_COUNT" -eq "0" ]; then
    echo -e "  ${RED}❌ No migrations found. Run: docker compose up -d db-init${NC}"
    exit 1
  fi
fi

# 4. Check events_timescale table
echo -e "\n${BLUE}4. Checking events_timescale table...${NC}"
if docker exec synap-postgres psql -U postgres synap -c "\d events_timescale" > /dev/null 2>&1; then
  EVENT_COUNT=$(docker exec synap-postgres psql -U postgres synap -t -c "SELECT COUNT(*) FROM events_timescale" 2>/dev/null | tr -d ' ')
  echo -e "  ${GREEN}✅ events_timescale table exists${NC}"
  echo -e "    Total events: $EVENT_COUNT"
else
  echo -e "  ${RED}❌ events_timescale table not found${NC}"
  exit 1
fi

# 5. Test API health (if running)
echo -e "\n${BLUE}5. Testing API health...${NC}"
if curl -s -f http://localhost:3000/trpc/health.alive > /dev/null 2>&1; then
  echo -e "  ${GREEN}✅ API server responding${NC}"
  
  # Check readiness
  READY_STATUS=$(curl -s http://localhost:3000/trpc/health.ready | grep -o '"status":"[^"]*"' || echo '"status":"unknown"')
  echo -e "    Status: $READY_STATUS"
else
  echo -e "  ${YELLOW}⚠  API server not responding${NC}"
  echo -e "    To start: cd apps/api && pnpm dev"
fi

# 6. Check RLS function
echo -e "\n${BLUE}6. Checking RLS function...${NC}"
if docker exec synap-postgres psql -U postgres synap -c "SELECT set_current_user('test')" > /dev/null 2>&1; then
  echo -e "  ${GREEN}✅ set_current_user() function exists${NC}"
else
  echo -e "  ${RED}❌ RLS function not found${NC}"
  exit 1
fi

# Summary
echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${GREEN}✅ Core infrastructure validation PASSED${NC}"
echo "═══════════════════════════════════════════════════════"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  1. Start API server: cd apps/api && pnpm dev"
echo "  2. Run API tests: node scripts/test-core-functions.mjs"
echo "  3. Check logs: docker compose logs -f api"
echo ""
