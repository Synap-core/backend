#!/bin/bash
# Synap Debugging Utility
# Quick commands for system inspection and troubleshooting

set -e

COMPOSE_FILE="docker-compose.yml"
DB_NAME="synap"
DB_USER="postgres"
DB_PASSWORD="${POSTGRES_PASSWORD:-synap_dev_password}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

print_usage() {
  echo "Usage: $0 {logs|db|redis|health|events|migrations|ps|restart|reset}"
  echo ""
  echo "Commands:"
  echo "  logs        - Tail all service logs with timestamps"
  echo "  db          - Connect to main PostgreSQL database"
  echo "  redis       - Connect to Redis CLI"
  echo "  health      - Check all service health status"
  echo "  events      - Show recent events from event store"
  echo "  migrations  - Show applied database migrations"
  echo "  ps          - Show running containers status"
  echo "  restart     - Restart all services"
  echo "  reset       - DANGER: Reset database (wipe all data)"
}

case "$1" in
  logs)
    echo -e "${GREEN}📜 Tailing service logs...${NC}"
    docker compose logs -f --tail=100 --timestamps
    ;;

  db)
    echo -e "${GREEN}🗄️  Connecting to PostgreSQL...${NC}"
    docker exec -it synap-postgres psql -U "$DB_USER" "$DB_NAME"
    ;;

  redis)
    echo -e "${GREEN}📮 Connecting to Redis CLI...${NC}"
    docker exec -it synap-redis redis-cli
    ;;

  health)
    echo -e "${GREEN}🏥 Checking system health...${NC}"
    echo ""
    
    # Check API health
    echo "📊 API Health:"
    curl -s http://localhost:3000/trpc/health.ready | json_pp || echo -e "${RED}API not responding${NC}"
    
    echo ""
    echo "📋 Container Status:"
    docker compose ps
    ;;

  events)
    echo -e "${GREEN}📅 Recent events (last 20):${NC}"
    docker exec synap-postgres psql -U "$DB_USER" "$DB_NAME" -c \
      "SELECT id, event_type, user_id, timestamp 
       FROM events_timescale 
       ORDER BY timestamp DESC 
       LIMIT 20"
    ;;

  migrations)
    echo -e "${GREEN}🔄 Applied database migrations:${NC}"
    docker exec synap-postgres psql -U "$DB_USER" "$DB_NAME" -c \
      "SELECT version, applied_at, description 
       FROM schema_migrations 
       ORDER BY applied_at DESC"
    ;;

  ps)
    echo -e "${GREEN}🐳 Docker containers:${NC}"
    docker compose ps
    ;;

  restart)
    echo -e "${YELLOW}♻️  Restarting all services...${NC}"
    docker compose restart
    echo -e "${GREEN}✅ Services restarted${NC}"
    ;;

  reset)
    echo -e "${RED}⚠️  WARNING: This will DELETE ALL DATA${NC}"
    read -p "Are you sure? (type 'yes' to confirm): " confirm
    if [ "$confirm" = "yes" ]; then
      echo -e "${YELLOW}Stopping services...${NC}"
      docker compose down -v
      echo -e "${YELLOW}Removing volumes...${NC}"
      docker volume prune -f
      echo -e "${GREEN}Starting fresh...${NC}"
      docker compose up -d
      echo -e "${GREEN}✅ Database reset complete${NC}"
    else
      echo "Reset cancelled"
    fi
    ;;

  *)
    print_usage
    exit 1
    ;;
esac
