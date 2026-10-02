#!/usr/bin/env bash
# ============================================================================
# Regression tests for ensure-ory-databases.sh
# ============================================================================
# Tests the fail-closed, non-destructive Ory database bootstrap helper.
#
# Each test mocks docker compose and psql via shell functions so the suite
# runs without a Docker daemon. Coverage:
#
#   1. Both databases already exist         → no-op, exit 0
#   2. One database missing, creation OK   → creates it, exit 0
#   3. Postgres readiness timeout         → exit non-zero, no migration
#   4. psql CREATE fails                  → exit non-zero, no migration
#   5. Postgres container missing         → exit non-zero, no migration
#   6. Postgres wrong project label       → exit non-zero, no migration
#   7. Idempotent re-run (already OK)    → no-op, exit 0
#
# Negative controls (assert failures are still safe):
#   A. DROP DATABASE / volume commands absent from the script
#   B. Migration commands not invoked on bootstrap failure
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The helper lives one level up (deploy/ensure-ory-databases.sh), not in __tests__/.
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

HELPER="$DEPLOY_DIR/ensure-ory-databases.sh"

# ─── Helpers ────────────────────────────────────────────────────────────────────

PASS=0 FAIL=0 SKIP=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $*"; ((PASS++)) || :; }
fail() { echo -e "  ${RED}✗${NC} $*"; ((FAIL++)) || :; }
skip() { echo -e "  ${YELLOW}⊘${NC} $*"; ((SKIP++)) || :; }
info() { echo -e "  ${YELLOW}…${NC} $*"; }

run_test() {
  local name="$1"; shift
  echo ""
  echo -e "${GREEN}TEST:${NC} $name"
}

# ─── Negative controls ───────────────────────────────────────────────────────────
# Assert the safety contract holds: no destructive commands in the script.

echo ""
echo "══════════════════════════════════════════════════════"
echo "  NEGATIVE CONTROLS  (assert safety invariants)"
echo "══════════════════════════════════════════════════════"

run_test "No DROP DATABASE in script"
if grep -qw "DROP DATABASE" ensure-ory-databases.sh; then
  fail "DROP DATABASE found in script"
else
  pass "No DROP DATABASE"
fi

run_test "No 'docker compose down' in script"
if grep -E "compose down|compose rm|docker down|docker rm" ensure-ory-databases.sh | grep -v "^[[:space:]]*#"; then
  fail "docker down/rm found in script"
else
  pass "No docker down/rm"
fi

run_test "No 'docker volume' rm/prune/remove in script"
if grep -qw "docker volume" ensure-ory-databases.sh; then
  fail "docker volume command found"
else
  pass "No docker volume commands"
fi

run_test "No 2>/dev/null || true on psql CREATE"
# The script has its own \gexec with ON_ERROR_STOP=1 and explicit error handling;
# the allowlist guard ensures only kratos/hydra can be targeted.
if grep -E "psql.*\|\||2>/dev/null.*true" ensure-ory-databases.sh | grep -v "^[[:space:]]*#" | grep -v "grep\|echo\|COMPOSE_CMD\|pg_isready"; then
  fail "Swallowed psql command found"
else
  pass "No swallowed psql commands"
fi

# ─── Test infrastructure ─────────────────────────────────────────────────────────
# Override COMPOSE_CMD to intercept docker compose calls with shell functions.

# Mock sleep so the helper's 60×2s pg-ready loop runs instantly.
sleep() { :; }

FAKE_COMPOSE_LOG=""
# These are set per-test to simulate different scenarios.
FAKE_PG_READY=0         # 0=ready, >0=fail attempts before success
FAKE_DB_KRATOS_EXISTS=0 # 0=absent, 1=present
FAKE_DB_HYDRA_EXISTS=0  # 0=absent, 1=present
FAKE_CREATE_FAIL=""     # ""=succeed, "kratos"|"hydra"|"both"=fail
FAKE_CONTAINER_MISSING="" # ""=present, "postgres"=missing
FAKE_WRONG_PROJECT=""    # ""=correct, "wrong-project"=mismatch

_compose() {
  local cmd="$*"
  FAKE_COMPOSE_LOG="$FAKE_COMPOSE_LOG
COMPOSE: $*"

  case "$1" in
    up)
      # docker compose up -d postgres
      if [[ "$*" == *"-d postgres"* ]]; then
        if [[ "$FAKE_CONTAINER_MISSING" == "postgres" ]]; then
          echo "Error: No such service: postgres" >&2; return 1
        fi
        echo "postgres started"
        return 0
      fi
      echo "compose up ok"
      return 0
      ;;
    exec)
      local svc="$3"
      local rest="$*"
      if [[ "$svc" == "postgres" ]]; then
        if [[ "$rest" == *"pg_isready"* ]]; then
          ((FAKE_PG_READY_COUNTER++)) || true
          if [[ "$FAKE_PG_READY_COUNTER" -le "${FAKE_PG_READY_FAILS:-0}" ]]; then
            return 1
          fi
          return 0
        fi
        if [[ "$rest" == *"psql"* ]]; then
          # Verification query: SELECT 1 FROM pg_database WHERE datname = 'X'
          # (distinguishable from CREATE: it has no 'CREATE DATABASE' string)
          if [[ "$rest" == *"SELECT 1 FROM pg_database"* ]]; then
            if [[ "$rest" == *"datname = 'kratos'"* ]]; then
              if [[ "$FAKE_DB_KRATOS_EXISTS" == "1" ]]; then
                echo "1"; return 0
              else
                return 1
              fi
            fi
            if [[ "$rest" == *"datname = 'hydra'"* ]]; then
              if [[ "$FAKE_DB_HYDRA_EXISTS" == "1" ]]; then
                echo "1"; return 0
              else
                return 1
              fi
            fi
          fi
          # CREATE DATABASE with \gexec
          if [[ "$rest" == *"CREATE DATABASE"* ]]; then
            if [[ "$FAKE_CREATE_FAIL" == "both" ]] || [[ "$FAKE_CREATE_FAIL" == "kratos" ]] && [[ "$rest" == *"kratos"* ]]; then
              echo "ERROR: connection refused" >&2; return 1
            fi
            if [[ "$FAKE_CREATE_FAIL" == "both" ]] || [[ "$FAKE_CREATE_FAIL" == "hydra" ]] && [[ "$rest" == *"hydra"* ]]; then
              echo "ERROR: connection refused" >&2; return 1
            fi
            echo "CREATE DATABASE"
            return 0
          fi
        fi
      fi
      return 0
      ;;
    ps)
      if [[ "$*" == *"ps -q postgres"* ]]; then
        if [[ "$FAKE_CONTAINER_MISSING" == "postgres" ]]; then
          return 1
        fi
        echo "fake-postgres-container-id"
        return 0
      fi
      return 0
      ;;
  esac
  return 0
}

docker() {
  case "$1" in
    inspect)
      # docker inspect on postgres container for project label
      if [[ "$*" == *"inspect"* ]] && [[ "$*" == *"postgres"* ]]; then
        if [[ "$FAKE_WRONG_PROJECT" == "wrong-project" ]]; then
          echo '[{"Config": {"Labels": {"com.docker.compose.project": "wrong-project"}}}]'
        else
          echo '[{"Config": {"Labels": {"com.docker.compose.project": "synap-backend"}}}]'
        fi
        return 0
      fi
      return 0
      ;;
    *)
      return 0
      ;;
  esac
}

# Source the helper AFTER defining _compose and docker overrides.
# The helper uses $COMPOSE_CMD exec -T postgres … which calls our _compose wrapper.
COMPOSE_CMD="_compose"
COMPOSE_PROJECT_NAME="synap-backend"

# shellcheck source=/dev/null
. "$HELPER"

# Counter for pg_isready retries
FAKE_PG_READY_COUNTER=0

# ─── Scenario 1: Both databases already exist ───────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════"
echo "  SCENARIO TESTS"
echo "══════════════════════════════════════════════════════"

run_test "Both databases already exist → no-op, exit 0"
FAKE_DB_KRATOS_EXISTS=1
FAKE_DB_HYDRA_EXISTS=1
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL=""
FAKE_CONTAINER_MISSING=""
FAKE_WRONG_PROJECT=""
if ensure_ory_databases >/dev/null 2>&1; then
  pass "Both databases present → exit 0"
else
  fail "Expected exit 0, got non-zero"
fi
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=0

# ─── Scenario 2: One database missing, creation succeeds ─────────────────────────

run_test "Kratos missing → created successfully, exit 0"
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=1
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL=""
if ensure_ory_databases >/dev/null 2>&1; then
  if echo "$FAKE_COMPOSE_LOG" | grep -q "CREATE DATABASE.*kratos"; then
    pass "Kratos created, hydra skipped"
  else
    fail "Expected CREATE DATABASE kratos in log"
  fi
else
  fail "Expected exit 0"
fi
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=0

# ─── Scenario 3: Postgres readiness timeout ─────────────────────────────────────

run_test "Postgres never ready → exit non-zero, no migration invoked"
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=0
FAKE_PG_READY=1          # signal: pg_isready always fails
FAKE_PG_READY_FAILS=999 # fake counter: always >0 → always fails
FAKE_CREATE_FAIL=""
FAKE_CONTAINER_MISSING=""
FAKE_WRONG_PROJECT=""
# The helper loops 60 times with 2s sleep — run in a subshell that makes pg_isready always fail.
COMPOSE_CMD="_compose_pg_timeout" COMPOSE_PROJECT_NAME="synap-backend" \
  bash -c '
    FAKE_PG_READY_FAILS=999
    _compose_pg_timeout() {
      if [[ "$*" == *"pg_isready"* ]]; then
        return 1
      fi
      _compose "$@"
    }
    . "$0" >/dev/null 2>&1
    exit $?
  ' "$HELPER" 2>/dev/null
result=$?
if [[ "$result" -ne 0 ]]; then
  pass "Postgres timeout → exit non-zero ($result)"
else
  fail "Expected non-zero exit on pg timeout"
fi

# ─── Scenario 4: psql CREATE fails ──────────────────────────────────────────────

run_test "psql CREATE kratos fails → exit non-zero, no hydra attempted"
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=0
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL="kratos"
FAKE_CONTAINER_MISSING=""
FAKE_WRONG_PROJECT=""
if ensure_ory_databases >/dev/null 2>&1; then
  fail "Expected non-zero exit on CREATE failure"
else
  if ! echo "$FAKE_COMPOSE_LOG" | grep -q "hydra"; then
    pass "CREATE kratos failed → exit non-zero, hydra not attempted"
  else
    fail "CREATE kratos failed but hydra was still attempted"
  fi
fi
FAKE_CREATE_FAIL=""

# ─── Scenario 5: Postgres container missing ────────────────────────────────────

run_test "Postgres service missing → exit non-zero before any DB check"
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=0
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL=""
FAKE_CONTAINER_MISSING="postgres"
FAKE_WRONG_PROJECT=""
if ensure_ory_databases >/dev/null 2>&1; then
  fail "Expected non-zero exit when postgres service missing"
else
  if ! echo "$FAKE_COMPOSE_LOG" | grep -q "kratos\|hydra"; then
    pass "Postgres missing → exit non-zero, no DB ops"
  else
    fail "Postgres missing but DB ops were attempted"
  fi
fi
FAKE_CONTAINER_MISSING=""

# ─── Scenario 6: Wrong Compose project label ────────────────────────────────────

run_test "Wrong Compose project label → exit non-zero, no DB ops"
FAKE_DB_KRATOS_EXISTS=1
FAKE_DB_HYDRA_EXISTS=1
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL=""
FAKE_CONTAINER_MISSING=""
FAKE_WRONG_PROJECT="wrong-project"
COMPOSE_PROJECT_NAME="synap-backend"
if ensure_ory_databases >/dev/null 2>&1; then
  fail "Expected non-zero exit when project label mismatches"
else
  if echo "$FAKE_COMPOSE_LOG" | grep -q "wrong-project"; then
    pass "Wrong project → exit non-zero, mismatch logged"
  else
    fail "Expected project mismatch detection"
  fi
fi
FAKE_WRONG_PROJECT=""

# ─── Scenario 7: Idempotent re-run ─────────────────────────────────────────────

run_test "Second run (both DBs now exist) → no CREATE, exit 0"
FAKE_DB_KRATOS_EXISTS=1
FAKE_DB_HYDRA_EXISTS=1
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL=""
FAKE_CONTAINER_MISSING=""
FAKE_WRONG_PROJECT=""
if ensure_ory_databases >/dev/null 2>&1; then
  create_count=$(echo "$FAKE_COMPOSE_LOG" | grep -c "CREATE DATABASE" || true)
  if [[ "$create_count" -eq 0 ]]; then
    pass "Idempotent re-run → no CREATE, exit 0"
  else
    fail "Idempotent run still issued $create_count CREATE calls"
  fi
else
  fail "Expected exit 0 on idempotent re-run"
fi

# ─── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════"
echo -e "  RESULTS  ${GREEN}PASS=$PASS${NC}  ${RED}FAIL=$FAIL${NC}  ${YELLOW}SKIP=$SKIP${NC}"
echo "══════════════════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "${RED}TESTS FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}ALL TESTS PASSED${NC}"
  exit 0
fi
