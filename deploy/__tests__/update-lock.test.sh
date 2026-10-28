#!/usr/bin/env bash
# Tripwire: two pod-mutating operations can never run at once.
#
# update-door plan P0 (2026-10-04): eve, the update unit and an operator
# could run install/update/rebuild/reset/restore against one deploy dir
# concurrently. (pod-agent runs none of them: it writes a request that
# synap-update.service takes under this same lock — prune-heal.test.sh.) All of them now take <deploy>/state/update.lock
# (deploy/update-lock.sh); a second invocation fails FAST and touches nothing.
#
# Daemon-free: the REAL `synap` script, with a fake
# `docker` on PATH that can be made to block (FAKE_DOCKER_SLEEP) so one
# operation holds the lock while another tries. Runs once per lock
# implementation: flock (when installed — every Linux CI runner / pod host) and
# the portable mkdir fallback (forced with SYNAP_LOCK_IMPL=mkdir).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
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
echo "$*" >> "${FAKE_LOG:-/dev/null}"
[ -n "${FAKE_DOCKER_SLEEP:-}" ] && [ "$1" = compose ] && [ "${2:-}" = build ] && sleep "$FAKE_DOCKER_SLEEP"
exit 0
D
chmod +x "$TMP/bin/docker"
HOLDER_PID=""
cleanup() { [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

synap() { # <log> <synap args...>
  local log="$1"; shift
  ( cd "$TMP"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" COMPOSE_PROJECT_NAME=synap-backend FAKE_LOG="$log" bash "$REPO/synap" "$@" ) </dev/null
}
locked() { [ -s "$DEPLOY/state/update.lock" ] || [ -s "$DEPLOY/state/update.lock.d/owner" ]; }

impls="mkdir"
command -v flock >/dev/null 2>&1 && impls="flock mkdir" || echo "skip - flock not installed here; testing the mkdir fallback only (CI runs both)"

for impl in $impls; do
  export SYNAP_LOCK_IMPL="$impl"
  [ "$impl" = flock ] && unset SYNAP_LOCK_IMPL
  rm -rf "$DEPLOY/state"; echo "BACKEND_VERSION=before" > "$DEPLOY/.env"

  # holder: `synap rebuild pod-agent` blocks inside `docker compose build`
  # (first-party rebuilds go through the update engine since P2; pod-agent is
  # still a plain compose build, which is all the holder needs).
  FAKE_DOCKER_SLEEP=4 synap "$TMP/holder.log" rebuild pod-agent >"$TMP/holder.out" 2>&1 &
  HOLDER_PID=$!
  for _ in $(seq 1 50); do locked && break; sleep 0.1; done
  locked && ok "[$impl] holder took the lock" || bad "[$impl] holder never took the lock"

  # a concurrent `synap update` fails fast and runs no docker command
  : > "$TMP/second.log"; start=$(date +%s)
  synap "$TMP/second.log" update >"$TMP/second.out" 2>&1; rc=$?
  took=$(( $(date +%s) - start ))
  [ "$rc" != 0 ] && ok "[$impl] concurrent synap update refused (exit $rc)" || bad "[$impl] concurrent synap update ran (exit 0)"
  [ "$took" -le 2 ] && ok "[$impl] refused fast (${took}s)" || bad "[$impl] took ${took}s — it waited instead of failing fast"
  grep -q "already running" "$TMP/second.out" && grep -q "synap rebuild" "$TMP/second.out" \
    && ok "[$impl] refusal names the holder" || bad "[$impl] refusal message: $(head -3 "$TMP/second.out")"
  [ ! -s "$TMP/second.log" ] && ok "[$impl] refused update invoked no docker command" || bad "[$impl] docker invoked: $(cat "$TMP/second.log")"

  wait "$HOLDER_PID"; hrc=$?; HOLDER_PID=""
  [ "$hrc" = 0 ] && ok "[$impl] holder completed" || bad "[$impl] holder failed ($hrc): $(tail -3 "$TMP/holder.out")"

  # released: the next operation acquires it
  synap "$TMP/third.log" rebuild pod-agent >"$TMP/third.out" 2>&1 && ok "[$impl] lock released on exit — next run proceeds" \
    || bad "[$impl] lock not released: $(tail -3 "$TMP/third.out")"
  # read-only commands never take it
  synap /dev/null ps >/dev/null 2>&1; [ $? = 0 ] && ok "[$impl] read-only command unaffected" || bad "[$impl] ps failed"
done

# flock: an operation stopped mid-way leaves the processes it started holding
# the lock (they inherited fd 9). The refusal names them and the command that
# stops them, not only the gone pid in the owner text (27 Oct: a killed
# `synap update` left its `docker build` holding the lock for good).
if command -v flock >/dev/null 2>&1 && [ -d /proc/self/fd ]; then
  unset SYNAP_LOCK_IMPL
  rm -rf "$DEPLOY/state"; : > "$TMP/orphan.log"
  FAKE_DOCKER_SLEEP=8 synap "$TMP/orphan.log" rebuild pod-agent >"$TMP/orphan-holder.out" 2>&1 &
  HOLDER_PID=$!
  for _ in $(seq 1 80); do grep -q "compose build" "$TMP/orphan.log" && break; sleep 0.1; done
  owner="$(sed -n 's/.* pid=\([0-9][0-9]*\).*/\1/p' "$DEPLOY/state/update.lock")"
  kill -9 "$owner" 2>/dev/null; sleep 0.3
  synap /dev/null update >"$TMP/orphan.out" 2>&1; rc=$?
  left="$(sed -n 's/.*kill \([0-9 ]*\)$/\1/p' "$TMP/orphan.out")"
  [ "$rc" != 0 ] && grep -q "left over from a stopped operation" "$TMP/orphan.out" \
    && ok "[flock] refusal says the lock is held by what a stopped operation left" \
    || bad "[flock] stopped-holder refusal: $(head -6 "$TMP/orphan.out")"
  live=1; [ -n "${left// /}" ] || live=0
  for p in $left; do [ "$p" != "$owner" ] && kill -0 "$p" 2>/dev/null || live=0; done
  [ "$live" = 1 ] && grep -q "docker" "$TMP/orphan.out" \
    && ok "[flock] it names the live leftover processes (the fake docker) in its kill command" \
    || bad "[flock] kill command names: '${left}' — $(cat "$TMP/orphan.out")"
  for p in $left; do kill "$p" 2>/dev/null; done
  wait "$HOLDER_PID" 2>/dev/null; HOLDER_PID=""
  for _ in $(seq 1 30); do synap /dev/null rebuild pod-agent >"$TMP/after.out" 2>&1 && break; sleep 0.2; done
  grep -q "already running\|left over" "$TMP/after.out" \
    && bad "[flock] lock still held after the named kill: $(head -3 "$TMP/after.out")" \
    || ok "[flock] after the named kill the next operation runs"
else
  echo "skip - flock or /proc missing; the stopped-holder case runs on Linux CI"
fi

# mkdir fallback: a lock left by a dead process is taken over, not a dead end
export SYNAP_LOCK_IMPL=mkdir
rm -rf "$DEPLOY/state"; mkdir -p "$DEPLOY/state/update.lock.d"
sh -c 'exit 0' & dead=$!; wait "$dead"
echo "synap update pid=$dead since=then" > "$DEPLOY/state/update.lock.d/owner"
synap "$TMP/stale.log" rebuild pod-agent >"$TMP/stale.out" 2>&1 && grep -q "stale update lock" "$TMP/stale.out" \
  && ok "[mkdir] stale lock (dead pid) is reclaimed" || bad "[mkdir] stale lock: $(tail -3 "$TMP/stale.out")"
[ ! -e "$DEPLOY/state/update.lock.d" ] && ok "[mkdir] lock dir removed on exit" || bad "[mkdir] lock dir left behind"

# every door the plan names takes the lock (derived from the router, not a list here)
for cmd in install update rebuild reset restore; do
  awk '/^# Pod-mutating commands serialise/{p=1} p&&/^esac/{exit} p' "$HERE/synap" | grep -qE "(^|[|[:space:]])${cmd}([|)])" \
    && ok "router locks '$cmd'" || bad "router does not lock '$cmd'"
done
exit $fail
