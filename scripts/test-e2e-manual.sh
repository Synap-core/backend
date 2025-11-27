#!/bin/bash
#
# Manual E2E Test Script for Intelligence Hub
#
# This script helps test the Intelligence Hub manually by:
# 1. Checking all services are running
# 2. Testing health endpoints
# 3. Providing example curl commands
#

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "🧪 Manual E2E Test for Intelligence Hub"
echo ""

# Check services
echo -e "${YELLOW}📋 Checking services...${NC}"

# Check Data Pod
if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Data Pod is running (http://localhost:3000)${NC}"
else
    echo -e "${RED}❌ Data Pod is not running${NC}"
    echo "   Start it with: pnpm --filter api dev"
fi

# Check Intelligence Hub
if curl -s http://localhost:3001/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Intelligence Hub is running (http://localhost:3001)${NC}"
else
    echo -e "${RED}❌ Intelligence Hub is not running${NC}"
    echo "   Start it with: pnpm --filter intelligence-hub dev"
fi

# Check Ory Hydra
if curl -s http://localhost:4445/health/ready > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Ory Hydra is running (http://localhost:4445)${NC}"
else
    echo -e "${RED}❌ Ory Hydra is not running${NC}"
    echo "   Start it with: docker compose up -d hydra"
fi

# Check Ory Kratos
if curl -s http://localhost:4433/health/ready > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Ory Kratos is running (http://localhost:4433)${NC}"
else
    echo -e "${RED}❌ Ory Kratos is not running${NC}"
    echo "   Start it with: docker compose up -d kratos"
fi

# Check Mem0
if curl -s http://localhost:8765/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Mem0 is running (http://localhost:8765)${NC}"
else
    echo -e "${RED}❌ Mem0 is not running${NC}"
    echo "   Start it with: docker compose up -d mem0"
fi

echo ""

# Get OAuth2 token (if HUB_CLIENT_ID and HUB_CLIENT_SECRET are set)
if [ -n "$HUB_CLIENT_ID" ] && [ -n "$HUB_CLIENT_SECRET" ]; then
    echo -e "${YELLOW}🔑 Getting OAuth2 token...${NC}"
    
    TOKEN_RESPONSE=$(curl -s -X POST http://localhost:4444/oauth2/token \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "grant_type=client_credentials" \
        -d "client_id=$HUB_CLIENT_ID" \
        -d "client_secret=$HUB_CLIENT_SECRET" \
        -d "scope=hub:read hub:write")
    
    TOKEN=$(echo $TOKEN_RESPONSE | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)
    
    if [ -n "$TOKEN" ]; then
        echo -e "${GREEN}✅ OAuth2 token obtained${NC}"
        echo ""
        echo -e "${BLUE}📝 Example curl command:${NC}"
        echo ""
        echo "curl -X POST http://localhost:3001/api/expertise/request \\"
        echo "  -H \"Authorization: Bearer $TOKEN\" \\"
        echo "  -H \"Content-Type: application/json\" \\"
        echo "  -H \"x-datapod-url: http://localhost:3000\" \\"
        echo "  -d '{"
        echo "    \"query\": \"Rappelle-moi d'\''appeler Paul demain à 14h\","
        echo "    \"context\": {"
        echo "      \"preferences\": {"
        echo "        \"timezone\": \"Europe/Paris\""
        echo "      }"
        echo "    }"
        echo "  }'"
        echo ""
    else
        echo -e "${RED}❌ Failed to get OAuth2 token${NC}"
        echo "   Check HUB_CLIENT_ID and HUB_CLIENT_SECRET in .env"
    fi
else
    echo -e "${YELLOW}⚠️  HUB_CLIENT_ID and HUB_CLIENT_SECRET not set${NC}"
    echo "   Set them in .env to get OAuth2 token automatically"
    echo ""
    echo -e "${BLUE}📝 Manual OAuth2 token request:${NC}"
    echo ""
    echo "curl -X POST http://localhost:4444/oauth2/token \\"
    echo "  -H \"Content-Type: application/x-www-form-urlencoded\" \\"
    echo "  -d \"grant_type=client_credentials\" \\"
    echo "  -d \"client_id=YOUR_CLIENT_ID\" \\"
    echo "  -d \"client_secret=YOUR_CLIENT_SECRET\" \\"
    echo "  -d \"scope=hub:read hub:write\""
    echo ""
fi

echo -e "${GREEN}✅ Manual test setup complete!${NC}"

