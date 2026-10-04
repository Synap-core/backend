#!/usr/bin/env bash
# Tripwire: the `synap` CLI must never GUESS the compose project.
#
# update-door plan P0 (2026-10-04): `_resolve_compose_project_name` silently
# picked one project when the team pod had two (`synap-backend` AND a stray
# `deploy`, each with a postgres). Running against the wrong one starts or
# migrates an empty database next to the real data. Now: a .env pin wins; one
# owner is used; TWO OR MORE owners for this deploy dir → refuse, touch nothing.
#
# Daemon-free: runs the REAL `synap` script (real router, real resolver) with a
# fake `docker` on PATH that answers `ps -a --filter label=…service=postgres`
# from a fixture and records every other call with the COMPOSE_PROJECT_NAME it saw.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

REPO="$TMP/repo"; DEPLOY="$REPO/deploy"
mkdir -p "$TMP/bin" "$DEPLOY"
cp "$HERE/synap" "$REPO/synap"
cp "$HERE/deploy/ensure-ory-databases.sh" "$HERE/deploy/pgdata-safety.sh" "$HERE/deploy/update-lock.sh" "$HERE/deploy/env-config.sh" "$HERE/deploy/env.schema" "$DEPLOY/"
printf 'services:\n  postgres:\n    image: x\n' > "$DEPLOY/docker-compose.yml"

cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
if [ "$1" = ps ] && [ "${2:-}" = -a ]; then cat "$FAKE_PG_OWNERS" 2>/dev/null; exit 0; fi
if [ "$1" = volume ] && [ "${2:-}" = ls ]; then cat "$FAKE_VOLUMES" 2>/dev/null; exit 0; fi
echo "project=${COMPOSE_PROJECT_NAME:-<unset>} argv=$*" >> "$FAKE_LOG"
exit 0
D
chmod +x "$TMP/bin/docker"
export FAKE_PG_OWNERS="$TMP/owners" FAKE_VOLUMES="$TMP/volumes" FAKE_LOG="$TMP/log"

# run <synap args...> — fresh log, deploy dir pinned via SYNAP_DEPLOY_DIR, no inherited project.
run() {
  : > "$FAKE_LOG"
  ( cd "$TMP"; unset COMPOSE_PROJECT_NAME
    PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" bash "$REPO/synap" "$@" ) >"$TMP/out" 2>"$TMP/err" </dev/null
}
owners() { printf '%s\n' "$@" > "$FAKE_PG_OWNERS"; }

# ── 1. two projects own a postgres for THIS deploy dir, no pin → refuse ──────
owners "synap-backend|$DEPLOY" "deploy|$DEPLOY"; : > "$FAKE_VOLUMES"; : > "$DEPLOY/.env"
run ps; rc=$?
[ "$rc" = 2 ] && ok "ambiguous project: exit 2" || bad "ambiguous project: expected exit 2, got $rc"
grep -q "Refusing to guess the compose project" "$TMP/err" && ok "ambiguous project: says why" || bad "ambiguous project: no refusal message ($(head -2 "$TMP/err"))"
grep -q "synap-backend" "$TMP/err" && grep -q "deploy" "$TMP/err" && ok "ambiguous project: names both" || bad "ambiguous project: does not name both projects"
[ ! -s "$FAKE_LOG" ] && ok "ambiguous project: docker compose never invoked" || bad "ambiguous project: docker invoked: $(cat "$FAKE_LOG")"

# mutating commands are refused BEFORE the lock or anything else
for cmd in update rebuild reset; do
  run "$cmd" backend; rc=$?
  [ "$rc" = 2 ] && [ ! -s "$FAKE_LOG" ] && ok "ambiguous project: '$cmd' refused untouched" || bad "ambiguous project: '$cmd' rc=$rc log=$(cat "$FAKE_LOG")"
done
[ ! -e "$DEPLOY/state/update.lock" ] && [ ! -e "$DEPLOY/state/update.lock.d" ] && ok "refusal happens before the update lock" || bad "lock taken despite refusal"

run help; [ $? = 0 ] && ok "help still works while ambiguous" || bad "help refused while ambiguous"

# ── 2. same conflict, but .env pins one → use the pin, warn ──────────────────
echo "COMPOSE_PROJECT_NAME=deploy" > "$DEPLOY/.env"
run ps; rc=$?
[ "$rc" = 0 ] && grep -q "^project=deploy argv=compose ps" "$FAKE_LOG" && ok "pinned: compose runs with the pinned project" || bad "pinned: rc=$rc log=$(cat "$FAKE_LOG")"
grep -q "compose projects own a postgres container" "$TMP/err" && ok "pinned: warns about the other project" || bad "pinned: no warning"

# ── 3. exactly one owner, unpinned → that one ────────────────────────────────
owners "deploy|$DEPLOY"; : > "$DEPLOY/.env"
run ps; grep -q "^project=deploy argv=compose ps" "$FAKE_LOG" && ok "single owner is used" || bad "single owner: $(cat "$FAKE_LOG")"

# ── 4. owners in ANOTHER deploy dir do not count ─────────────────────────────
owners "deploy|/elsewhere/deploy" "other|/srv/x"
run ps; grep -q "^project=synap-backend argv=compose ps" "$FAKE_LOG" && ok "other dirs' projects ignored → synap-backend" || bad "other dirs: $(cat "$FAKE_LOG")"

# ── 5. an operator env override always wins ─────────────────────────────────
owners "synap-backend|$DEPLOY" "deploy|$DEPLOY"
: > "$FAKE_LOG"
( cd "$TMP"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" COMPOSE_PROJECT_NAME=chosen bash "$REPO/synap" ps ) >/dev/null 2>&1 </dev/null
grep -q "^project=chosen argv=compose ps" "$FAKE_LOG" && ok "env override wins" || bad "env override: $(cat "$FAKE_LOG")"

# ── 6. the pin writer (extracted from the real CLI) ───────────────────────────
awk '/^_pin_compose_project_name\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$HERE/synap" > "$TMP/pin.sh"
grep -q '_pin_compose_project_name()' "$TMP/pin.sh" || bad "could not extract _pin_compose_project_name"
printf 'DOMAIN=pod.example\nPOSTGRES_PASSWORD=x' > "$TMP/env1"   # no trailing newline
( BLUE=; NC=; . "$HERE/deploy/env-config.sh"; . "$TMP/pin.sh"; COMPOSE_PROJECT_NAME=synap-backend _pin_compose_project_name "$TMP/env1"; COMPOSE_PROJECT_NAME=other _pin_compose_project_name "$TMP/env1" ) >/dev/null
[ "$(cat "$TMP/env1")" = "$(printf 'DOMAIN=pod.example\nPOSTGRES_PASSWORD=x\nCOMPOSE_PROJECT_NAME=synap-backend')" ] \
  && ok "pin appended on its own line, once, never overwritten" || bad "pin writer produced: $(cat -A "$TMP/env1" 2>/dev/null || cat "$TMP/env1")"
# both install and update call it (shape check: the call sits inside each body)
for fn in cmd_update cmd_install; do
  awk "/^${fn}\\(\\) \\{/{p=1} p&&/^}/{exit} p" "$HERE/synap" | grep -q '_pin_compose_project_name \.env' \
    && ok "$fn pins the project" || bad "$fn does not call _pin_compose_project_name"
done
grep -q '^COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-synap-backend}$' "$HERE/synap" \
  && ok "generated .env carries the RESOLVED project, not a hard-coded one" || bad "generate_and_create_env hard-codes the project"
exit $fail
