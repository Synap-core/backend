#!/usr/bin/env bash
# Tripwire: two pod-mutating operations can never run at once.
#
# update-door plan P0 (2026-10-04): eve, pod-agent (update-pod.sh) and an
# operator could run install/update/rebuild/reset/restore against one deploy
# dir concurrently. All of them now take <deploy>/state/update.lock
# (deploy/update-lock.sh); a second invocation fails FAST and touches nothing.
#
# Daemon-free: the REAL `synap` script and the REAL update-pod.sh, with a fake
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
cp "$HERE/deploy/ensure-ory-databases.sh" "$HERE/deploy/pgdata-safety.sh" "$HERE/deploy/update-lock.sh" "$HERE/deploy/update-pod.sh" "$DEPLOY/"
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

  # holder: `synap rebuild backend` blocks inside `docker compose build`
  FAKE_DOCKER_SLEEP=4 synap "$TMP/holder.log" rebuild backend >"$TMP/holder.out" 2>&1 &
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

  # update-pod.sh (pod-agent's door) honours the same lock, before touching .env
  : > "$TMP/pod.log"
  ( PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/pod.log" sh "$DEPLOY/update-pod.sh" main-abc1234 ) </dev/null >"$TMP/pod.out" 2>&1; rc=$?
  # (exit code alone is not proof: BSD sed fails later in update-pod.sh on macOS)
  [ "$rc" != 0 ] && grep -q "already running" "$TMP/pod.out" && grep -q "holds the update lock" "$TMP/pod.out" \
    && ok "[$impl] concurrent update-pod.sh refused by the lock" || bad "[$impl] update-pod.sh not refused by the lock (rc=$rc): $(tail -2 "$TMP/pod.out")"
  [ "$(cat "$DEPLOY/.env")" = "BACKEND_VERSION=before" ] && ok "[$impl] update-pod.sh left .env untouched" || bad "[$impl] .env changed: $(cat "$DEPLOY/.env")"
  [ ! -s "$TMP/pod.log" ] && ok "[$impl] refused update-pod.sh invoked no docker command" || bad "[$impl] docker invoked: $(cat "$TMP/pod.log")"

  wait "$HOLDER_PID"; hrc=$?; HOLDER_PID=""
  [ "$hrc" = 0 ] && ok "[$impl] holder completed" || bad "[$impl] holder failed ($hrc): $(tail -3 "$TMP/holder.out")"

  # released: the next operation acquires it
  synap "$TMP/third.log" rebuild backend >"$TMP/third.out" 2>&1 && ok "[$impl] lock released on exit — next run proceeds" \
    || bad "[$impl] lock not released: $(tail -3 "$TMP/third.out")"
  # read-only commands never take it
  synap /dev/null ps >/dev/null 2>&1; [ $? = 0 ] && ok "[$impl] read-only command unaffected" || bad "[$impl] ps failed"
done

# mkdir fallback: a lock left by a dead process is taken over, not a dead end
export SYNAP_LOCK_IMPL=mkdir
rm -rf "$DEPLOY/state"; mkdir -p "$DEPLOY/state/update.lock.d"
sh -c 'exit 0' & dead=$!; wait "$dead"
echo "synap update pid=$dead since=then" > "$DEPLOY/state/update.lock.d/owner"
synap "$TMP/stale.log" rebuild backend >"$TMP/stale.out" 2>&1 && grep -q "stale update lock" "$TMP/stale.out" \
  && ok "[mkdir] stale lock (dead pid) is reclaimed" || bad "[mkdir] stale lock: $(tail -3 "$TMP/stale.out")"
[ ! -e "$DEPLOY/state/update.lock.d" ] && ok "[mkdir] lock dir removed on exit" || bad "[mkdir] lock dir left behind"

# update-pod.sh runs under /bin/sh (busybox ash in the pod-agent image): every
# file it sources must parse as POSIX sh, or it dies before reaching the lock.
# The sourced set is derived from update-pod.sh itself.
# A real POSIX shell is REQUIRED: macOS `sh` is bash-in-posix-mode and accepts
# bashisms (`${c:0:12}`, `${BASH_SOURCE[0]}`) that dash/ash reject — a fallback to
# `sh` passed vacuously and shipped a broken update-pod.sh (2026-10-04). In CI
# (dash is on ubuntu) a missing dash is a FAILURE; locally it is a loud SKIP.
POSIX_SH="$(command -v dash || true)"
sourced=$(sed -n 's|^\. "\$CD/\([^"]*\)".*|\1|p' "$HERE/deploy/update-pod.sh")
[ "$(echo "$sourced" | grep -c .)" -ge 3 ] && ok "update-pod.sh sources $(echo $sourced)" || bad "could not derive update-pod.sh's sourced files: '$sourced'"
if [ -z "$POSIX_SH" ]; then
  if [ -n "${CI:-}" ]; then bad "dash not found in CI — POSIX check cannot run"; else echo "SKIP - POSIX checks: dash not installed (CI runs them)"; fi
else
  for f in update-pod.sh $sourced; do
    "$POSIX_SH" -n "$HERE/deploy/$f" 2>"$TMP/sh.err" && ok "$f parses under dash" || bad "$f is not POSIX sh: $(head -1 "$TMP/sh.err")"
  done
  # Parsing is not enough: dash reports "Bad substitution" only when it EXPANDS,
  # and a sourced file's top level runs at source time. Source each one for real.
  for f in $sourced; do
    ( cd "$HERE/deploy" && "$POSIX_SH" -c ". ./$f" ) 2>"$TMP/sh.err" && ok "$f sources under dash" || bad "$f fails when sourced by dash: $(head -1 "$TMP/sh.err")"
  done
fi

# every door the plan names takes the lock (derived from the router, not a list here)
for cmd in install update rebuild reset restore; do
  awk '/^# Pod-mutating commands serialise/{p=1} p&&/^esac/{exit} p' "$HERE/synap" | grep -qE "(^|[|[:space:]])${cmd}([|)])" \
    && ok "router locks '$cmd'" || bad "router does not lock '$cmd'"
done
exit $fail
