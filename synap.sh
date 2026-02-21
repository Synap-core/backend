#!/bin/bash
set -e

# =============================================================================
# synap.sh — Unified Synap Deployment CLI
#
# Usage:
#   ./synap.sh deploy              Deploy backend + intelligence service
#   ./synap.sh deploy --zeroclaw   Deploy with ZeroClaw bridge enabled
#   ./synap.sh deploy --channels   Deploy with Channel Gateway (Telegram/WhatsApp)
#   ./synap.sh deploy --all        Deploy everything (backend + zeroclaw + channels)
#   ./synap.sh status              Show status of all services
#   ./synap.sh logs [service]      View logs (all or specific service)
#   ./synap.sh stop                Stop all services
#   ./synap.sh register-zeroclaw   Register ZeroClaw as intelligence service
#   ./synap.sh test-zeroclaw       Test ZeroClaw bridge health + send test message
# =============================================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/synap-backend"
INTELLIGENCE_DIR="$SCRIPT_DIR/synap-intelligence-service"
ZEROCLAW_DIR="$SCRIPT_DIR/synap-zeroclaw-bridge"

# =============================================================================
# Banner
# =============================================================================
banner() {
    echo -e "${CYAN}"
    echo "  ╔═══════════════════════════════════════════╗"
    echo "  ║           ${BOLD}Synap Deployment CLI${NC}${CYAN}            ║"
    echo "  ╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
}

# =============================================================================
# Help
# =============================================================================
usage() {
    banner
    echo -e "${BOLD}Usage:${NC} ./synap.sh <command> [options]"
    echo ""
    echo -e "${BOLD}Commands:${NC}"
    echo -e "  ${GREEN}deploy${NC}                Deploy services"
    echo -e "  ${GREEN}status${NC}                Show status of all services"
    echo -e "  ${GREEN}logs${NC} [service]         View logs (all or specific service)"
    echo -e "  ${GREEN}stop${NC}                  Stop all services"
    echo -e "  ${GREEN}register-zeroclaw${NC}     Register ZeroClaw as intelligence service"
    echo -e "  ${GREEN}test-zeroclaw${NC}         Test ZeroClaw bridge connectivity"
    echo -e "  ${GREEN}help${NC}                  Show this help"
    echo ""
    echo -e "${BOLD}Deploy Options:${NC}"
    echo -e "  ${YELLOW}--zeroclaw${NC}            Enable ZeroClaw intelligence bridge"
    echo -e "  ${YELLOW}--channels${NC}            Enable Channel Gateway (Telegram/WhatsApp)"
    echo -e "  ${YELLOW}--all${NC}                 Enable all optional services"
    echo -e "  ${YELLOW}--build${NC}               Force rebuild images"
    echo -e "  ${YELLOW}--detach${NC}              Run in background (default)"
    echo -e "  ${YELLOW}--foreground${NC}          Run in foreground (attach to logs)"
    echo ""
    echo -e "${BOLD}Examples:${NC}"
    echo -e "  ${DIM}# Deploy backend + intelligence hub${NC}"
    echo "  ./synap.sh deploy"
    echo ""
    echo -e "  ${DIM}# Deploy with ZeroClaw as alternative AI brain${NC}"
    echo "  ./synap.sh deploy --zeroclaw"
    echo ""
    echo -e "  ${DIM}# Deploy everything including Telegram/WhatsApp channels${NC}"
    echo "  ./synap.sh deploy --all"
    echo ""
    echo -e "  ${DIM}# Test ZeroClaw bridge after deployment${NC}"
    echo "  ./synap.sh test-zeroclaw"
    echo ""
}

# =============================================================================
# Helpers
# =============================================================================
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo -e "${RED}Docker is not running. Start Docker first.${NC}"
        exit 1
    fi
}

check_env_file() {
    local dir="$1"
    local name="$2"
    if [ ! -f "$dir/deploy/.env" ]; then
        echo -e "${YELLOW}Warning: $name deploy/.env not found${NC}"
        echo -e "${DIM}  Copy deploy/.env.example to deploy/.env and configure it${NC}"
        return 1
    fi
    return 0
}

wait_for_health() {
    local name="$1"
    local url="$2"
    local max_attempts=${3:-30}
    local attempt=1

    printf "  Waiting for %-25s " "$name..."
    while [ $attempt -le $max_attempts ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}healthy${NC}"
            return 0
        fi
        sleep 2
        attempt=$((attempt + 1))
    done
    echo -e "${RED}timeout${NC}"
    return 1
}

# =============================================================================
# Deploy
# =============================================================================
cmd_deploy() {
    banner
    check_docker

    local enable_zeroclaw=false
    local enable_channels=false
    local force_build=false
    local detach=true

    # Parse options
    while [[ $# -gt 0 ]]; do
        case $1 in
            --zeroclaw)     enable_zeroclaw=true; shift ;;
            --channels)     enable_channels=true; shift ;;
            --all)          enable_zeroclaw=true; enable_channels=true; shift ;;
            --build)        force_build=true; shift ;;
            --foreground)   detach=false; shift ;;
            --detach)       detach=true; shift ;;
            *)              echo -e "${RED}Unknown option: $1${NC}"; usage; exit 1 ;;
        esac
    done

    echo -e "${BLUE}Deployment Configuration:${NC}"
    echo -e "  Backend:              ${GREEN}enabled${NC}"
    echo -e "  Intelligence Hub:     ${GREEN}enabled${NC}"
    if $enable_zeroclaw; then
        echo -e "  ZeroClaw Bridge:      ${GREEN}enabled${NC}"
    else
        echo -e "  ZeroClaw Bridge:      ${DIM}disabled${NC} ${DIM}(use --zeroclaw to enable)${NC}"
    fi
    if $enable_channels; then
        echo -e "  Channel Gateway:      ${GREEN}enabled${NC}"
    else
        echo -e "  Channel Gateway:      ${DIM}disabled${NC} ${DIM}(use --channels to enable)${NC}"
    fi
    echo ""

    # -------------------------------------------------------------------
    # Step 1: Backend
    # -------------------------------------------------------------------
    echo -e "${BLUE}[1/3] Starting Backend...${NC}"
    local backend_compose_args="-f $BACKEND_DIR/deploy/docker-compose.yml"
    local backend_env=""
    if [ -f "$BACKEND_DIR/deploy/.env" ]; then
        backend_env="--env-file $BACKEND_DIR/deploy/.env"
    fi

    local build_flag=""
    if $force_build; then
        build_flag="--build"
    fi

    local detach_flag="-d"
    if ! $detach; then
        detach_flag=""
    fi

    (cd "$BACKEND_DIR/deploy" && docker compose $backend_env up $detach_flag $build_flag) &
    local backend_pid=$!

    # -------------------------------------------------------------------
    # Step 2: Intelligence Service
    # -------------------------------------------------------------------
    echo -e "${BLUE}[2/3] Starting Intelligence Service...${NC}"
    local intel_compose_args=""
    local intel_profiles=""

    if $enable_zeroclaw; then
        intel_profiles="$intel_profiles --profile zeroclaw"

        # Check ZeroClaw env requirements
        if [ -f "$INTELLIGENCE_DIR/deploy/.env" ]; then
            if ! grep -q "ZEROCLAW_API_KEY" "$INTELLIGENCE_DIR/deploy/.env" 2>/dev/null; then
                echo -e "${YELLOW}  Generating ZEROCLAW_API_KEY...${NC}"
                local zckey=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
                echo "" >> "$INTELLIGENCE_DIR/deploy/.env"
                echo "# ZeroClaw Bridge" >> "$INTELLIGENCE_DIR/deploy/.env"
                echo "ZEROCLAW_API_KEY=$zckey" >> "$INTELLIGENCE_DIR/deploy/.env"
                echo -e "${GREEN}  ZEROCLAW_API_KEY added to .env${NC}"
            fi
        fi
    fi

    if $enable_channels; then
        intel_profiles="$intel_profiles --profile channels"
    fi

    local intel_env=""
    if [ -f "$INTELLIGENCE_DIR/deploy/.env" ]; then
        intel_env="--env-file $INTELLIGENCE_DIR/deploy/.env"
    fi

    (cd "$INTELLIGENCE_DIR/deploy" && docker compose $intel_env $intel_profiles up $detach_flag $build_flag) &
    local intel_pid=$!

    # Wait for background processes
    wait $backend_pid 2>/dev/null || true
    wait $intel_pid 2>/dev/null || true

    if ! $detach; then
        return
    fi

    # -------------------------------------------------------------------
    # Step 3: Health Checks
    # -------------------------------------------------------------------
    echo ""
    echo -e "${BLUE}[3/3] Health Checks...${NC}"
    sleep 3

    wait_for_health "Backend API" "http://localhost:4000/health" || true
    wait_for_health "Intelligence Hub" "http://localhost:3001/health" 20 || true

    if $enable_zeroclaw; then
        wait_for_health "ZeroClaw Bridge" "http://localhost:8080/health" 15 || true
    fi

    if $enable_channels; then
        wait_for_health "Channel Gateway" "http://localhost:3003/health" 15 || true
    fi

    # -------------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------------
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Deployment Complete${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${BLUE}Services:${NC}"
    echo "  Backend API:        http://localhost:4000"
    echo "  Realtime:           http://localhost:4001"
    echo "  Intelligence Hub:   http://localhost:3001"
    if $enable_zeroclaw; then
        echo "  ZeroClaw Bridge:    http://localhost:8080"
    fi
    if $enable_channels; then
        echo "  Channel Gateway:    http://localhost:3003"
    fi
    echo ""

    if $enable_zeroclaw; then
        echo -e "${YELLOW}Next step: Register ZeroClaw as an intelligence service:${NC}"
        echo "  ./synap.sh register-zeroclaw"
        echo ""
    fi
}

# =============================================================================
# Status
# =============================================================================
cmd_status() {
    banner
    check_docker

    echo -e "${BLUE}Backend Services:${NC}"
    (cd "$BACKEND_DIR/deploy" && docker compose ps 2>/dev/null) || echo -e "${DIM}  Not running${NC}"
    echo ""

    echo -e "${BLUE}Intelligence Services:${NC}"
    (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile zeroclaw --profile channels ps 2>/dev/null) || echo -e "${DIM}  Not running${NC}"
    echo ""

    echo -e "${BLUE}Health Checks:${NC}"
    for svc in "Backend:http://localhost:4000/health" \
               "Intelligence Hub:http://localhost:3001/health" \
               "ZeroClaw Bridge:http://localhost:8080/health" \
               "Channel Gateway:http://localhost:3003/health"; do
        local name="${svc%%:*}"
        local url="${svc#*:}"
        printf "  %-25s " "$name"
        if curl -sf "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}healthy${NC}"
        else
            echo -e "${DIM}not running${NC}"
        fi
    done
    echo ""
}

# =============================================================================
# Logs
# =============================================================================
cmd_logs() {
    check_docker
    local service="${1:-}"

    if [ -n "$service" ]; then
        case "$service" in
            backend|realtime|postgres|redis|minio|typesense|kratos|hydra|caddy)
                (cd "$BACKEND_DIR/deploy" && docker compose logs -f "$service")
                ;;
            intelligence-service|intelligence-db|intelligence-migrate)
                (cd "$INTELLIGENCE_DIR/deploy" && docker compose logs -f "$service")
                ;;
            zeroclaw-bridge|zeroclaw)
                (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile zeroclaw logs -f zeroclaw-bridge)
                ;;
            channel-gateway|channels)
                (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile channels logs -f channel-gateway)
                ;;
            *)
                echo -e "${RED}Unknown service: $service${NC}"
                echo "Available: backend, realtime, intelligence-service, zeroclaw-bridge, channel-gateway"
                exit 1
                ;;
        esac
    else
        echo -e "${BLUE}Streaming all logs (Ctrl+C to stop)...${NC}"
        echo ""
        # Stream both in parallel
        (cd "$BACKEND_DIR/deploy" && docker compose logs -f --tail=50) &
        (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile zeroclaw --profile channels logs -f --tail=50) &
        wait
    fi
}

# =============================================================================
# Stop
# =============================================================================
cmd_stop() {
    banner
    check_docker

    echo -e "${BLUE}Stopping all services...${NC}"
    echo ""

    echo "  Stopping Intelligence Services..."
    (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile zeroclaw --profile channels down 2>/dev/null) || true

    echo "  Stopping Backend..."
    (cd "$BACKEND_DIR/deploy" && docker compose down 2>/dev/null) || true

    echo ""
    echo -e "${GREEN}All services stopped.${NC}"
}

# =============================================================================
# Register ZeroClaw
# =============================================================================
cmd_register_zeroclaw() {
    banner

    echo -e "${BLUE}Registering ZeroClaw as an intelligence service...${NC}"
    echo ""

    # Check if ZeroClaw bridge is running
    if ! curl -sf "http://localhost:8080/health" > /dev/null 2>&1; then
        echo -e "${RED}ZeroClaw bridge is not running!${NC}"
        echo "Deploy it first: ./synap.sh deploy --zeroclaw"
        exit 1
    fi
    echo -e "${GREEN}  ZeroClaw bridge is healthy${NC}"

    # Check if backend is running
    if ! curl -sf "http://localhost:4000/health" > /dev/null 2>&1; then
        echo -e "${RED}Backend is not running!${NC}"
        exit 1
    fi
    echo -e "${GREEN}  Backend is healthy${NC}"
    echo ""

    # Get the ZeroClaw API key from .env
    local zeroclaw_api_key=""
    if [ -f "$INTELLIGENCE_DIR/deploy/.env" ]; then
        zeroclaw_api_key=$(grep "^ZEROCLAW_API_KEY=" "$INTELLIGENCE_DIR/deploy/.env" 2>/dev/null | cut -d= -f2-)
    fi

    if [ -z "$zeroclaw_api_key" ]; then
        echo -e "${YELLOW}ZEROCLAW_API_KEY not found in .env${NC}"
        read -p "Enter ZeroClaw API key: " zeroclaw_api_key
    fi

    # Determine the webhook URL (Docker internal or localhost)
    local webhook_url="http://zeroclaw-bridge:8080"
    echo -e "${DIM}  Using webhook URL: $webhook_url${NC}"
    echo -e "${DIM}  (Change to public URL if running on separate hosts)${NC}"
    echo ""

    # Get an auth token or API key for the backend
    local hub_api_key=""
    if [ -f "$BACKEND_DIR/deploy/.env" ]; then
        hub_api_key=$(grep "^HUB_PROTOCOL_API_KEY=" "$BACKEND_DIR/deploy/.env" 2>/dev/null | cut -d= -f2-)
    fi

    if [ -z "$hub_api_key" ]; then
        echo -e "${YELLOW}HUB_PROTOCOL_API_KEY not found${NC}"
        read -p "Enter Hub Protocol API key (for backend auth): " hub_api_key
    fi

    # Register via the Hub Protocol REST API
    echo -e "${BLUE}Registering service...${NC}"
    local response
    response=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:4000/api/hub/intelligence-services" \
        -H "Authorization: Bearer $hub_api_key" \
        -H "Content-Type: application/json" \
        -d "{
            \"serviceId\": \"zeroclaw\",
            \"name\": \"ZeroClaw Agent\",
            \"description\": \"ZeroClaw-powered intelligence service with shell, browser, and file capabilities\",
            \"webhookUrl\": \"$webhook_url\",
            \"apiKey\": \"$zeroclaw_api_key\",
            \"capabilities\": [\"chat\"],
            \"metadata\": {
                \"authType\": \"api-key\",
                \"provider\": \"zeroclaw\"
            }
        }")

    local http_code=$(echo "$response" | tail -1)
    local body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        echo ""
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${GREEN}  ZeroClaw registered successfully!${NC}"
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "${BLUE}To use ZeroClaw:${NC}"
        echo "  1. Go to Synap web app Settings > Intelligence"
        echo "  2. Select 'ZeroClaw Agent' as your intelligence service"
        echo "  3. Start chatting — messages will be routed through ZeroClaw"
        echo ""
        echo -e "${DIM}Or set it as workspace default via tRPC:${NC}"
        echo -e "${DIM}  workspaces.update({ settings: { intelligenceServiceId: 'zeroclaw' } })${NC}"
    else
        echo ""
        echo -e "${YELLOW}Registration returned HTTP $http_code${NC}"
        echo "$body" | head -5
        echo ""
        echo -e "${DIM}If the service already exists, this is expected.${NC}"
        echo -e "${DIM}You can update it via the admin UI or tRPC.${NC}"
    fi
}

# =============================================================================
# Test ZeroClaw
# =============================================================================
cmd_test_zeroclaw() {
    banner

    echo -e "${BLUE}Testing ZeroClaw Bridge...${NC}"
    echo ""

    # 1. Health check
    echo -e "${BOLD}1. Health Check${NC}"
    local health_response
    health_response=$(curl -s "http://localhost:8080/health" 2>/dev/null)
    if [ $? -eq 0 ] && echo "$health_response" | grep -q "ok"; then
        echo -e "   ${GREEN}PASS${NC} — $health_response"
    else
        echo -e "   ${RED}FAIL${NC} — Bridge not reachable at http://localhost:8080"
        echo "   Deploy it first: ./synap.sh deploy --zeroclaw"
        exit 1
    fi
    echo ""

    # 2. Get ZeroClaw API key
    local zeroclaw_api_key=""
    if [ -f "$INTELLIGENCE_DIR/deploy/.env" ]; then
        zeroclaw_api_key=$(grep "^ZEROCLAW_API_KEY=" "$INTELLIGENCE_DIR/deploy/.env" 2>/dev/null | cut -d= -f2-)
    fi

    if [ -z "$zeroclaw_api_key" ]; then
        read -p "Enter ZEROCLAW_API_KEY: " zeroclaw_api_key
    fi

    # 3. Test authenticated endpoint (non-streaming)
    echo -e "${BOLD}2. Authenticated Request (POST /api/expertise/request)${NC}"

    local hub_api_key=""
    if [ -f "$BACKEND_DIR/deploy/.env" ]; then
        hub_api_key=$(grep "^HUB_PROTOCOL_API_KEY=" "$BACKEND_DIR/deploy/.env" 2>/dev/null | cut -d= -f2-)
    fi
    hub_api_key=${hub_api_key:-"test-key"}

    local test_response
    test_response=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8080/api/expertise/request" \
        -H "X-API-Key: $zeroclaw_api_key" \
        -H "Content-Type: application/json" \
        -d "{
            \"query\": \"Hello, this is a test message from synap.sh\",
            \"threadId\": \"test-thread-$(date +%s)\",
            \"userId\": \"test-user\",
            \"dataPodUrl\": \"http://localhost:4000\",
            \"dataPodApiKey\": \"$hub_api_key\"
        }")

    local test_http_code=$(echo "$test_response" | tail -1)
    local test_body=$(echo "$test_response" | sed '$d')

    if [ "$test_http_code" = "200" ]; then
        echo -e "   ${GREEN}PASS${NC} — HTTP 200"
        echo -e "   ${DIM}Response: $(echo "$test_body" | head -c 200)...${NC}"
    else
        echo -e "   ${YELLOW}HTTP $test_http_code${NC}"
        echo -e "   ${DIM}$test_body${NC}"
        echo ""
        echo -e "   ${DIM}Note: If backend is not running, Hub Protocol calls will fail.${NC}"
        echo -e "   ${DIM}This is expected — the bridge still processed the request.${NC}"
    fi
    echo ""

    # 4. Test SSE streaming
    echo -e "${BOLD}3. SSE Streaming (POST /api/chat/stream)${NC}"
    local stream_output
    stream_output=$(timeout 10 curl -s -N -X POST "http://localhost:8080/api/chat/stream" \
        -H "X-API-Key: $zeroclaw_api_key" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d "{
            \"query\": \"Test streaming\",
            \"threadId\": \"test-stream-$(date +%s)\",
            \"userId\": \"test-user\",
            \"stream\": true,
            \"dataPodUrl\": \"http://localhost:4000\",
            \"dataPodApiKey\": \"$hub_api_key\"
        }" 2>/dev/null | head -20)

    if echo "$stream_output" | grep -q "data:"; then
        local event_count=$(echo "$stream_output" | grep -c "data:" || true)
        echo -e "   ${GREEN}PASS${NC} — Received $event_count SSE events"

        # Check for expected event types
        for etype in "step" "content" "complete"; do
            if echo "$stream_output" | grep -q "\"type\":\"$etype\""; then
                echo -e "   ${GREEN}  ✓${NC} $etype event"
            fi
        done
    else
        echo -e "   ${YELLOW}No SSE events received${NC}"
        echo -e "   ${DIM}This may be expected if backend is not running.${NC}"
    fi

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Test Complete${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# =============================================================================
# Main
# =============================================================================
case "${1:-help}" in
    deploy)         shift; cmd_deploy "$@" ;;
    status)         cmd_status ;;
    logs)           shift; cmd_logs "$@" ;;
    stop)           cmd_stop ;;
    register-zeroclaw|register)  cmd_register_zeroclaw ;;
    test-zeroclaw|test)          cmd_test_zeroclaw ;;
    help|--help|-h) usage ;;
    *)              echo -e "${RED}Unknown command: $1${NC}"; usage; exit 1 ;;
esac
