#!/bin/bash
# ============================================================================
# Shared Ory database bootstrap (fail-closed, non-destructive)
# ============================================================================
# Sourced by both the canonical `synap` CLI and `deploy/update-pod.sh`. Ensures
# the `kratos` and `hydra` databases exist on the deployment's own PostgreSQL
# volume before any Ory migration runs.
#
# This is the ONLY path that repairs a missing database on an existing volume.
# PostgreSQL's init-databases.sh only fires when PostgreSQL initializes a
# brand-new data directory, so an existing volume that predates the Ory
# databases (or any volume drift) needs this explicit, verified step.
#
# SAFETY CONTRACT (non-negotiable):
#   • NEVER drops a database, deletes a volume, recreates a volume, or runs
#     `docker compose down --volumes`. Existing data is untouched.
#   • Only starts `postgres` (start-only: `up -d`, never `down`/recreate).
#   • Creates a database ONLY when it is absent.
#   • Verifies each target exists afterward and aborts on ANY failure.
#   • A zero exit from the CREATE step does NOT count as success — the
#     postcondition is queried independently.
#   • Never switches the Compose project/volume: the project name is already
#     resolved by `_resolve_compose_project_name` and pinned in `.env`.
#
# Callers must set:
#   • COMPOSE_CMD — the docker compose invocation to use
#     (canonical CLI: `docker compose`; update-pod.sh: its `$COMPOSE`).
#   • COMPOSE_PROJECT_NAME — for the read-only project-label sanity check.
# ============================================================================
: "${COMPOSE_CMD:=docker compose}"
: "${RED:='\033[0;31m'}"
: "${GREEN:='\033[0;32m'}"
: "${BLUE:='\033[0;34m'}"
: "${YELLOW:='\033[1;33m'}"
: "${NC:='\033[0m'}"

# Ensure one known Ory database exists. The identifier is allowlisted, so
# identifier injection is impossible from any caller.
_ensure_ory_database() {
    local database="$1"

    case "$database" in
        kratos|hydra) ;;
        *)
            echo -e "${RED}❌ Refusing to ensure unknown database '${database}'${NC}"
            return 1
            ;;
    esac

    echo -e "${BLUE}📝 Ensuring database '${database}' exists...${NC}"

    # Create only when absent. Identical to init-databases.sh's \gexec pattern,
    # but executed against the running service on the existing volume.
    if ! $COMPOSE_CMD exec -T postgres \
        psql -v ON_ERROR_STOP=1 -U synap -d postgres \
        -c "SELECT 'CREATE DATABASE ${database}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${database}')\gexec"; then
        echo -e "${RED}❌ Failed to create database '${database}' (see psql output above)${NC}"
        return 1
    fi

    # Postcondition: the database must actually exist. A zero exit from the
    # CREATE above does not prove the database was created.
    if ! $COMPOSE_CMD exec -T postgres \
        psql -v ON_ERROR_STOP=1 -U synap -d postgres \
        -Atc "SELECT 1 FROM pg_database WHERE datname = '${database}'" \
        | grep -qx '1'; then
        echo -e "${RED}❌ Database '${database}' still missing after creation attempt${NC}"
        return 1
    fi

    echo -e "${GREEN}  ✓ Database '${database}' is available${NC}"
    return 0
}

# Ensure both Ory databases exist, failing closed on every prerequisite.
# Returns non-zero if Postgres is not startable, not ready, belongs to the
# wrong Compose project, or either database is missing after the attempt.
ensure_ory_databases() {
    local postgres_service="postgres"

    # Start the deployment's own PostgreSQL service. Start-only: never down,
    # never recreate, never touch volumes.
    echo -e "${BLUE}📝 Starting PostgreSQL service '${postgres_service}'...${NC}"
    if ! $COMPOSE_CMD up -d "$postgres_service"; then
        echo -e "${RED}❌ Could not start PostgreSQL service '${postgres_service}'${NC}"
        return 1
    fi

    # Wait for the service to accept connections. Bounded so a stuck update
    # fails loudly instead of hanging.
    echo -e "${BLUE}⏳ Waiting for PostgreSQL to accept connections...${NC}"
    local ready=false
    local i
    for i in $(seq 1 60); do
        if $COMPOSE_CMD exec -T "$postgres_service" \
            pg_isready -U synap -d postgres >/dev/null 2>&1; then
            ready=true
            break
        fi
        sleep 2
    done

    if [ "$ready" != true ]; then
        echo -e "${RED}❌ PostgreSQL did not become ready within 120 seconds${NC}"
        return 1
    fi

    # Read-only sanity check: the running container must belong to the expected
    # Compose project. Never switches stacks; only diagnoses a mismatch so the
    # operator can see why the wrong volume was selected.
    local expected_project="${COMPOSE_PROJECT_NAME:-}"
    local actual_project
    actual_project="$(
        $COMPOSE_CMD ps -q "$postgres_service" 2>/dev/null \
            | docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null \
            | head -1
    )"
    if [ -n "$expected_project" ] && [ -n "$actual_project" ] && [ "$actual_project" != "$expected_project" ]; then
        echo -e "${RED}❌ PostgreSQL belongs to Compose project '${actual_project}', expected '${expected_project}'${NC}"
        return 1
    fi

    _ensure_ory_database kratos || return 1
    _ensure_ory_database hydra || return 1

    echo -e "${GREEN}✅ Ory databases (kratos, hydra) are available${NC}"
    return 0
}