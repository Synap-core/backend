#!/bin/bash
set -e

# =============================================================================
# synap.sh — Unified Synap Deployment CLI
#
# Usage:
#   ./synap.sh deploy              Deploy backend + intelligence service
#   ./synap.sh deploy --channels   Deploy with Channel Gateway (Telegram/WhatsApp)
#   ./synap.sh deploy --all        Deploy everything (backend + channels)
#   ./synap.sh status              Show status of all services
#   ./synap.sh logs [service]      View logs (all or specific service)
#   ./synap.sh stop                Stop all services
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
AGENT_BRIDGE_DIR="$SCRIPT_DIR/synap-agent-bridge"

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
    echo -e "  ${GREEN}help${NC}                  Show this help"
    echo ""
    echo -e "${BOLD}Deploy Options:${NC}"
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
    echo -e "  ${DIM}# Deploy everything including Telegram/WhatsApp channels${NC}"
    echo "  ./synap.sh deploy --all"
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

    local enable_channels=false
    local force_build=false
    local detach=true

    # Parse options
    while [[ $# -gt 0 ]]; do
        case $1 in
            --channels)     enable_channels=true; shift ;;
            --all)          enable_channels=true; shift ;;
            --build)        force_build=true; shift ;;
            --foreground)   detach=false; shift ;;
            --detach)       detach=true; shift ;;
            *)              echo -e "${RED}Unknown option: $1${NC}"; usage; exit 1 ;;
        esac
    done

    echo -e "${BLUE}Deployment Configuration:${NC}"
    echo -e "  Backend:              ${GREEN}enabled${NC}"
    echo -e "  Intelligence Hub:     ${GREEN}enabled${NC}"
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

    # Ensure Postgres is up first (so we can create missing databases)
    echo -e "  Starting Postgres..."
    (cd "$BACKEND_DIR/deploy" && docker compose $backend_env up $detach_flag postgres)

    # ─── Shared fail-closed Ory database bootstrap ─────────────────────────────────
    # Source the canonical helper (deploy/ensure-ory-databases.sh). It starts only
    # postgres, waits for readiness, creates only missing kratos/hydra databases,
    # verifies each one, and aborts on any failure. Never drops a database or a
    # volume. Replaces the swallowed psql blocks that silently hid failures.
    COMPOSE_PROJECT_NAME="synap-backend"
    # The helper expects COMPOSE_CMD to be a plain "docker compose …" command.
    # We wrap it so docker compose runs from the deploy directory with the env file.
    COMPOSE_CMD="cd '$BACKEND_DIR/deploy' && docker compose $backend_env"
    # shellcheck source=/dev/null
    . "$BACKEND_DIR/deploy/ensure-ory-databases.sh" || { echo -e "${RED}❌ Ory bootstrap helper missing — cannot proceed${NC}"; exit 1; }

    if ! ensure_ory_databases; then
        echo -e "${RED}❌ Ory database bootstrap failed — cannot proceed${NC}"
        exit 1
    fi

    # Now start all backend services
    (cd "$BACKEND_DIR/deploy" && docker compose $backend_env up $detach_flag $build_flag) &
    local backend_pid=$!

    # -------------------------------------------------------------------
    # Step 2: Intelligence Service
    # -------------------------------------------------------------------
    echo -e "${BLUE}[2/3] Starting Intelligence Service...${NC}"
    local intel_compose_args=""
    local intel_profiles=""

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
    if $enable_channels; then
        echo "  Channel Gateway:    http://localhost:3003"
    fi
    echo ""
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
    (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile channels ps 2>/dev/null) || echo -e "${DIM}  Not running${NC}"
    echo ""

    echo -e "${BLUE}Health Checks:${NC}"
    for svc in "Backend:http://localhost:4000/health" \
               "Intelligence Hub:http://localhost:3001/health" \
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
            channel-gateway|channels)
                (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile channels logs -f channel-gateway)
                ;;
            *)
                echo -e "${RED}Unknown service: $service${NC}"
                echo "Available: backend, realtime, intelligence-service, channel-gateway"
                exit 1
                ;;
        esac
    else
        echo -e "${BLUE}Streaming all logs (Ctrl+C to stop)...${NC}"
        echo ""
        # Stream both in parallel
        (cd "$BACKEND_DIR/deploy" && docker compose logs -f --tail=50) &
        (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile channels logs -f --tail=50) &
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
    (cd "$INTELLIGENCE_DIR/deploy" && docker compose --profile channels down 2>/dev/null) || true

    echo "  Stopping Backend..."
    (cd "$BACKEND_DIR/deploy" && docker compose down 2>/dev/null) || true

    echo ""
    echo -e "${GREEN}All services stopped.${NC}"
}

# =============================================================================
# Main
# =============================================================================
case "${1:-help}" in
    deploy)         shift; cmd_deploy "$@" ;;
    status)         cmd_status ;;
    logs)           shift; cmd_logs "$@" ;;
    stop)           cmd_stop ;;
    help|--help|-h) usage ;;
    *)              echo -e "${RED}Unknown command: $1${NC}"; usage; exit 1 ;;
esac
