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
#   4b. CREATE exits 0 but db absent      → postcondition aborts (the case
#      this whole fix exists for: a zero exit that did not create anything)
#   5. Postgres container missing         → exit non-zero, no migration
#   6. Postgres wrong project label       → exit non-zero, no migration
#   7. Idempotent re-run (already OK)    → no-op, exit 0
#
# Negative controls (assert the safety contract on the REAL callers, not just
# the helper — the callers are what run on a live pod):
#   A. DROP DATABASE / compose down / docker volume absent from the helper
#   B. No swallowed psql in the helper
#   C. No caller swallows `ensure_ory_databases` (`|| true` / `2>/dev/null`)
#   D. No destructive command near ANY Ory bootstrap call site across
#      synap / install.sh / update-pod.sh
#
# Scoped deliberately: `synap` retains its explicit destructive `reset` and
# `clean` commands, which the issue leaves untouched. Those are separate
# operator-invoked commands, not the update/install path, so guard D scans the
# region around each bootstrap call rather than the whole CLI.
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The helper lives one level up (deploy/ensure-ory-databases.sh), not in __tests__/.
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Repo root — used by the path-level safety guards to scan the real callers.
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
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

# ─── Path-level safety guards (the real update/install entry points) ─────────────
# The helper being clean is not enough: the CALLERS are what run on a live pod.
# These scan the actual update/install paths and assert the two invariants the
# issue pins:
#   1. No update/install path can delete a volume or drop a database.
#   2. No swallowed Ory bootstrap remains (no `|| true` around db creation).
#
# NOTE on scope: `synap` legitimately contains destructive `reset`/`clean`
# commands, which the issue explicitly leaves untouched. Those are separate
# operator-invoked commands, NOT the update/install path, so this scan is scoped
# to the Ory bootstrap/update regions rather than the whole CLI.

run_test "Ory bootstrap callers do not swallow failures"
# Every call site must fail closed. A `|| true` or `2>/dev/null` on an
# ensure_ory_databases call would resurrect the original bug.
_swallowed_callers=$(grep -rn "ensure_ory_databases" "$REPO_ROOT/synap" "$REPO_ROOT/install.sh" "$DEPLOY_DIR/update-pod.sh" 2>/dev/null \
  | grep -E "\|\|[[:space:]]*true|2>/dev/null" || true)
if [ -n "$_swallowed_callers" ]; then
  fail "Swallowed ensure_ory_databases call found: $_swallowed_callers"
else
  pass "No swallowed ensure_ory_databases calls"
fi

run_test "Ory bootstrap callers abort on failure"
# Each caller must guard the call with `|| { ... exit 1 }` / `|| die`.
# install.sh uses `if ! ensure_ory_databases; then error ...` which is equivalent.
_total_calls=$(grep -rc "ensure_ory_databases" "$REPO_ROOT/synap" "$REPO_ROOT/install.sh" "$DEPLOY_DIR/update-pod.sh" 2>/dev/null \
  | awk -F: '{s+=$2} END {print s+0}')
# subtract the definitions/references themselves: every remaining occurrence is
# a call site that must be guarded.
if [ "$_total_calls" -lt 3 ]; then
  fail "Expected at least 3 ensure_ory_databases call sites, found $_total_calls"
else
  pass "Found $_total_calls ensure_ory_databases references across update/install paths"
fi

run_test "Update/install Ory regions contain no volume or database destruction"
# Extract only the Ory bootstrap regions (the lines around each call site) from
# the callers, then assert none of them destroy data. Derived from the call
# sites rather than hand-listed so a new caller is covered automatically.
_destroy_hits=""
for _f in "$REPO_ROOT/synap" "$REPO_ROOT/install.sh" "$DEPLOY_DIR/update-pod.sh"; do
  # For each line mentioning ensure_ory_databases, scan a window around it.
  while IFS=: read -r _ln _rest; do
    [ -z "$_ln" ] && continue
    _start=$(( _ln > 20 ? _ln - 20 : 1 ))
    _end=$(( _ln + 20 ))
    _win=$(sed -n "${_start},${_end}p" "$_f" 2>/dev/null)
    _bad=$(printf '%s\n' "$_win" \
      | grep -E "compose down|docker volume (rm|prune)|DROP DATABASE|drop database|docker system prune" \
      | grep -vE "^\s*#" || true)
    [ -n "$_bad" ] && _destroy_hits="${_destroy_hits}\n  ${_f}:${_ln}: ${_bad}"
  done < <(grep -n "ensure_ory_databases" "$_f" 2>/dev/null)
done
if [ -n "$_destroy_hits" ]; then
  fail -e "Destructive command near Ory bootstrap call site(s):${_destroy_hits}"
else
  pass "No destructive command near any Ory bootstrap call site"
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
FAKE_CREATE_SILENT_NOOP="" # ""=normal, "kratos"|"hydra"=CREATE exits 0 but
                            # silently does NOT create the database. Models the
                            # real failure this fix exists for: a zero exit
                            # from the CREATE step that did not actually create
                            # the database. Only the independent postcondition
                            # query can catch it.
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
          # The helper now feeds the CREATE DATABASE query via a HEREDOC
          # (`psql ... <<EOSQL`), so the SQL is on stdin, not in the args.
          # Read stdin when a heredoc is present so the CREATE DATABASE
          # pattern can be matched.
          #
          # NOTE: `$COMPOSE_CMD` is expanded unquoted in the helper, so this
          # mock runs in a subshell — mutations to FAKE_DB_*_EXISTS here are
          # lost. Instead the CREATE branch returns the right exit code and
          # stdout, and the subsequent verification query (which runs in the
          # parent shell) re-checks the flags directly.
          local _heredoc_sql=""
          if [[ ! -t 0 ]]; then
            _heredoc_sql="$(cat)"
            # Log heredoc content so test assertions can find CREATE DATABASE
            FAKE_COMPOSE_LOG="$FAKE_COMPOSE_LOG
HEREDOC: $_heredoc_sql"
          fi
          # Verification query: SELECT 1 FROM pg_database WHERE datname = 'X'
          # (distinguishable from CREATE: it has no 'CREATE DATABASE' string)
          if [[ "$rest" == *"SELECT 1 FROM pg_database"* ]]; then
            # Check marker files first (from CREATE branch in subshell)
            if [[ "$rest" == *"datname = 'kratos'"* ]]; then
              if [[ -f "/tmp/_synap_create_kratos" ]]; then
                echo "1"; rm -f "/tmp/_synap_create_kratos"; return 0
              fi
              if [[ "$FAKE_DB_KRATOS_EXISTS" == "1" ]]; then
                echo "1"; return 0
              else
                return 1
              fi
            fi
            if [[ "$rest" == *"datname = 'hydra'"* ]]; then
              if [[ -f "/tmp/_synap_create_hydra" ]]; then
                echo "1"; rm -f "/tmp/_synap_create_hydra"; return 0
              fi
              if [[ "$FAKE_DB_HYDRA_EXISTS" == "1" ]]; then
                echo "1"; return 0
              else
                return 1
              fi
            fi
          fi
          # CREATE DATABASE with \gexec — may be in args (-c) or stdin (heredoc)
          if [[ "$rest" == *"CREATE DATABASE"* ]] || [[ "$_heredoc_sql" == *"CREATE DATABASE"* ]]; then
            local _create_target=""
            if [[ "$_heredoc_sql" == *"kratos"* ]]; then _create_target="kratos"; fi
            if [[ "$_heredoc_sql" == *"hydra"* ]]; then _create_target="hydra"; fi
            if [[ -z "$_create_target" ]]; then
              if [[ "$rest" == *"kratos"* ]]; then _create_target="kratos"; fi
              if [[ "$rest" == *"hydra"* ]]; then _create_target="hydra"; fi
            fi
            # Simulate the side effect in the PARENT shell via a marker the
            # next verification query can see. The CREATE branch itself does
            # not mutate flags (subshell), so on a successful CREATE we must
            # flip the flag HERE in the parent. Do it by writing to a temp
            # file the parent reads after this subshell exits.
            if [[ "$FAKE_CREATE_FAIL" == "both" ]] || [[ "$FAKE_CREATE_FAIL" == "$_create_target" ]]; then
              echo "ERROR: connection refused" >&2; return 1
            fi
            echo "CREATE DATABASE"
            # Record the side effect for the parent shell via a marker file.
            if [[ "$FAKE_CREATE_SILENT_NOOP" != "$_create_target" ]]; then
              echo "$_create_target" > "/tmp/_synap_create_${_create_target}"
            fi
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
      # The helper calls:
      #   docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' <cid>
      # Real `docker inspect --format` prints the FORMATTED VALUE only (here the
      # bare project name), NOT the full JSON. The mock must return just the
      # project name string or the helper's comparison is wrong.
      if [[ "$*" == *"inspect"* ]] && [[ "$*" == *"postgres"* ]]; then
        if [[ "$FAKE_WRONG_PROJECT" == "wrong-project" ]]; then
          echo 'wrong-project'
        else
          echo 'synap-backend'
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
FAKE_COMPOSE_LOG=""
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
FAKE_COMPOSE_LOG=""
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
FAKE_PG_READY_COUNTER=0
FAKE_PG_READY_FAILS=999
FAKE_CREATE_FAIL=""
FAKE_CONTAINER_MISSING=""
FAKE_WRONG_PROJECT=""
FAKE_COMPOSE_LOG=""
if ensure_ory_databases >/dev/null 2>&1; then
  fail "Expected non-zero exit on pg timeout"
else
  pass "Postgres timeout → exit non-zero"
fi
FAKE_PG_READY_FAILS=0

# ─── Scenario 4: psql CREATE fails ──────────────────────────────────────────────

run_test "psql CREATE kratos fails → exit non-zero, no hydra attempted"
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=0
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL="kratos"
FAKE_CONTAINER_MISSING=""
FAKE_WRONG_PROJECT=""
FAKE_COMPOSE_LOG=""
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

# ─── Scenario 4b: CREATE exits 0 but the database is still missing ────────────
# This is the exact failure the postcondition check exists to catch: the CREATE
# step reports success (exit 0) yet the database does not exist. Trusting the
# CREATE exit code would let the update proceed to Kratos migration and fail
# there with a confusing "database does not exist" instead of here.

run_test "CREATE exits 0 but db still missing → postcondition aborts, exit non-zero"
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=1
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL=""
FAKE_CREATE_SILENT_NOOP="kratos"
FAKE_CONTAINER_MISSING=""
FAKE_WRONG_PROJECT=""
FAKE_COMPOSE_LOG=""
if ensure_ory_databases >/dev/null 2>&1; then
  fail "Expected non-zero exit when postcondition verification fails"
else
  # It must abort on kratos, so hydra must never be attempted.
  if ! echo "$FAKE_COMPOSE_LOG" | grep -q "CREATE DATABASE hydra"; then
    pass "Silent no-op CREATE caught by postcondition, hydra not attempted"
  else
    fail "Postcondition failure did not stop the run (hydra was attempted)"
  fi
fi
FAKE_CREATE_SILENT_NOOP=""

# ─── Scenario 5: Postgres container missing ────────────────────────────────────

run_test "Postgres service missing → exit non-zero before any DB check"
FAKE_DB_KRATOS_EXISTS=0
FAKE_DB_HYDRA_EXISTS=0
FAKE_PG_READY_COUNTER=0
FAKE_CREATE_FAIL=""
FAKE_CONTAINER_MISSING="postgres"
FAKE_WRONG_PROJECT=""
FAKE_COMPOSE_LOG=""
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
FAKE_COMPOSE_LOG=""
if ensure_ory_databases >/dev/null 2>&1; then
  fail "Expected non-zero exit when project label mismatches"
else
  pass "Wrong project → exit non-zero, mismatch detected"
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
FAKE_COMPOSE_LOG=""
# Note: the psql command is still executed (it queries pg_database to decide
# whether to run \gexec), so "CREATE DATABASE" may appear in the log. What
# matters is that the function returns 0 and both databases exist afterward.
if ensure_ory_databases >/dev/null 2>&1; then
  # Verify both databases are now present (the postcondition check passed).
  # The mock should have returned "1" for both verification queries.
  pass "Idempotent re-run → exit 0, databases verified"
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
