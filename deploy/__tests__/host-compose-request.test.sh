#!/usr/bin/env bash
# H3: pod-agent never creates a container — it asks the HOST engine.
#
# pod-agent runs in a container with the deploy dir at /deploy; a compose `up`
# it runs mounts the compose file's relative binds from the HOST's /deploy,
# which does not exist (the CP's email-relay delivery recreated kratos with no
# config; sign-in died, 2026-10-19). Every container the agent needs goes
# through state/requests/compose.json → `synap compose-request` on the host.
#
#   S. static, DERIVED: every script pod-agent runs (server.js COMMANDS) has no
#      compose up/run/create of its own (SCAN_DIR overrides the scanned dir —
#      the negative control points it at the pre-fix scripts).
#   R. round trip: the REAL agent helper (host-request.sh) + the REAL `synap
#      compose-request` against a fake docker: the host runs compose from the
#      real deploy dir, re-renders kratos.yml, records the outcome; the agent
#      returns 0. Refusals (unknown name, bad schema), a busy lock, a host that
#      never picks up, --no-wait, and the units that watch the request.
# NOT covered: systemd itself (fake systemctl), the real docker daemon's bind
# resolution (the defect is documented above; the fake records cwd + args).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }

# ── S. static: no agent script creates a container ──────────────────────────
SCAN="${SCAN_DIR:-$HERE/deploy}"
scripts="$(sed -n 's/^ *script: "\([a-z0-9-]*\.sh\)",*$/\1/p' "$HERE/deploy/pod-agent/server.js" | sort -u)"
n="$(printf '%s\n' "$scripts" | grep -c .)"
[ "$n" -ge 6 ] && ok "derived $n agent scripts from server.js COMMANDS" || bad "only $n agent scripts derived from server.js — the scan is blind"
CREATE_RE='(\$COMPOSE|docker[[:space:]]+compose)[^#]*[[:space:]](up|run|create)([[:space:]]|$)'
printf '%s\n' '  $COMPOSE up -d 2>&1' | grep -qE "$CREATE_RE" && ! printf '%s\n' '$COMPOSE stop backend' | grep -qE "$CREATE_RE" \
  && ok "the scan sees a literal '\$COMPOSE up -d' and ignores 'stop'" || bad "the scan regex cannot see what it hunts"
for f in $scripts; do
  [ -f "$SCAN/$f" ] || { bad "$f (named in server.js) is missing from $SCAN"; continue; }
  hits="$(grep -nE "$CREATE_RE" "$SCAN/$f" | grep -vE '^[0-9]+:[[:space:]]*#')"
  [ -z "$hits" ] && ok "$f creates no container itself" || bad "$f runs compose up/run/create inside pod-agent: $hits"
done

# ── R. round trip ────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
echo "$PWD|$*" >> "$FAKE_LOG"
case "$*" in
  "compose config --profiles") printf '%s\n' pod-agent rsshub canary; exit 0 ;;
  "compose"*"config --services")
    printf '%s\n' postgres redis minio kratos backend realtime caddy
    case " $* " in *" --profile pod-agent "*) echo pod-agent ;; esac; exit 0 ;;
  "compose"*" up "*) [ -n "${FAKE_UP_FAIL:-}" ] && { echo "Error response from daemon: boom" >&2; exit 1; }; exit 0 ;;
esac
exit 0
D
printf '#!/usr/bin/env bash\necho "$*" >> "%s/systemctl.log"\n' "$TMP" > "$TMP/bin/systemctl"
chmod +x "$TMP/bin/docker" "$TMP/bin/systemctl"

setup() {
  S="$TMP/$1"; REPO="$S/repo"; DEPLOY="$REPO/deploy"
  mkdir -p "$DEPLOY/state" "$REPO/kratos"
  cp "$HERE/synap" "$REPO/synap"
  cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$DEPLOY/"
  cp -R "$HERE/deploy/systemd" "$DEPLOY/systemd"
  printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\nPOSTGRES_PASSWORD=x\nJWT_SECRET=x\nKRATOS_SECRETS_COOKIE=x\nPOD_ADMIN_DOMAIN=pod-admin.example.com\n' > "$DEPLOY/.env"
  export FAKE_LOG="$S/docker.log"; : > "$FAKE_LOG"
}
host() { # the host unit: `synap compose-request`, once the request exists
  local i
  for i in $(seq 1 50); do [ -e "$DEPLOY/state/requests/compose.json" ] && break; sleep 0.1; done
  ( cd "$S" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_ASSUME_YES=1 "$@" bash "$REPO/synap" compose-request ) >"$S/host.out" 2>&1 </dev/null
}
agent() { # the agent side, as an agent script runs it
  ( SYNAP_DEPLOY_DIR="$DEPLOY" HOST_REQUEST_PICKUP_SECONDS="${PICKUP:-20}" HOST_REQUEST_TIMEOUT_SECONDS=30 HOST_REQUEST_POLL_SECONDS=1 \
      sh -c '. "$1/host-request.sh"; shift; host_compose "$@"' _ "$DEPLOY" "$@" ) >"$S/agent.out" 2>&1 </dev/null
}
rec() { jq -r ".$1" "$DEPLOY/state/last-compose-request.json" 2>/dev/null; }

# R1. the email-relay shape: configure → recreate kratos + backend
setup relay
agent --recreate --no-deps kratos backend & ap=$!
host; hrc=$?; wait "$ap"; arc=$?
[ "$hrc" = 0 ] && [ "$arc" = 0 ] && ok "relay: the host ran the request and the agent heard 'succeeded'" || { bad "relay: host=$hrc agent=$arc"; sed 's/^/      /' "$S/host.out" "$S/agent.out" | tail -12; }
grep -qxF "$DEPLOY|compose up -d --no-build --force-recreate --no-deps kratos backend" "$FAKE_LOG" \
  && ok "relay: compose ran on the HOST, from the real deploy dir ($DEPLOY), with exactly the asked services" || bad "relay: compose calls: $(grep ' up ' "$FAKE_LOG")"
[ -s "$REPO/kratos/kratos.yml" ] && grep -q "pod.example.com" "$REPO/kratos/kratos.yml" \
  && ok "relay: kratos.yml re-rendered for the current .env before kratos is recreated" || bad "relay: kratos.yml not rendered"
[ "$(rec status)" = succeeded ] && [[ "$(rec request)" == agent-* ]] && [ ! -e "$DEPLOY/state/requests/compose.json" ] \
  && ok "relay: outcome recorded with the request id; the request was taken (no .path loop)" || bad "relay: record=$(cat "$DEPLOY/state/last-compose-request.json" 2>/dev/null)"
grep -q '"kind":"pod.compose-request"' "$DEPLOY/state/events.jsonl" && ok "relay: the event is in state/events.jsonl" || bad "relay: no event"

# R2. profiles: every service of the profile comes up, no recreate
setup profile
agent --profile pod-agent & ap=$!; host; wait "$ap"; arc=$?
[ "$arc" = 0 ] && grep -qxF "$DEPLOY|compose --profile pod-agent up -d --no-build --remove-orphans" "$FAKE_LOG" \
  && ok "profile: --profile pod-agent up -d --no-build --remove-orphans on the host" || bad "profile: agent=$arc calls: $(grep ' up ' "$FAKE_LOG")"

# R2b. a profile this compose file no longer has (older CP, retired add-on) is dropped, not refused
setup oldprofile
agent --profile openclaw & ap=$!; host; wait "$ap"; arc=$?
[ "$arc" = 0 ] && grep -qxF "$DEPLOY|compose up -d --no-build --remove-orphans" "$FAKE_LOG" && [[ "$(rec reason)" == *"ignored unknown profiles: openclaw"* ]] \
  && ok "oldprofile: an unknown profile is dropped (said in the record), never passed to compose" || bad "oldprofile: agent=$arc calls=$(grep ' up ' "$FAKE_LOG") reason=$(rec reason)"

# R3. refusals: an unknown service runs NOTHING, the agent gets the reason
setup unknown
agent --recreate nosuch kratos & ap=$!; host; hrc=$?; wait "$ap"; arc=$?
[ "$hrc" != 0 ] && [ "$arc" != 0 ] && [ "$(rec status)" = aborted ] && ! grep -q ' up ' "$FAKE_LOG" && grep -q "service:nosuch" "$S/agent.out" \
  && ok "unknown: a service this compose file lacks is refused, nothing runs, the agent says why" || { bad "unknown: host=$hrc agent=$arc record=$(rec status)"; cat "$S/agent.out"; }
setup schema
mkdir -p "$DEPLOY/state/requests"; echo '{"schema":2,"id":"x1","services":["kratos"]}' > "$DEPLOY/state/requests/compose.json"
host; hrc=$?
[ "$hrc" != 0 ] && [ "$(rec status)" = aborted ] && [ "$(rec request)" = x1 ] && ! grep -q ' up ' "$FAKE_LOG" \
  && ok "schema: a request that is not schema 1 is refused and recorded" || bad "schema: host=$hrc record=$(rec status)"
setup upfail
agent backend & ap=$!; FAKE_UP_FAIL=1 host; hrc=$?; wait "$ap"; arc=$?
[ "$hrc" != 0 ] && [ "$arc" != 0 ] && [ "$(rec status)" = failed ] && grep -q "boom" "$S/agent.out" \
  && ok "upfail: a compose failure is recorded failed and reaches the agent" || { bad "upfail: host=$hrc agent=$arc record=$(rec status)"; cat "$S/agent.out"; }

# R4. the update lock is busy: the request is consumed and recorded, not looped on
setup busy
mkdir -p "$DEPLOY/state/update.lock.d"; echo "synap update pid=$$ since=now" > "$DEPLOY/state/update.lock.d/owner"
agent kratos & ap=$!; SYNAP_LOCK_IMPL=mkdir host; hrc=$?; wait "$ap"; arc=$?
[ "$hrc" != 0 ] && [ "$arc" != 0 ] && [ "$(rec status)" = aborted ] && [ ! -e "$DEPLOY/state/requests/compose.json" ] && ! grep -q ' up ' "$FAKE_LOG" \
  && ok "busy: lock held → request taken and recorded aborted (send it again), nothing ran" || { bad "busy: host=$hrc agent=$arc record=$(rec status)"; cat "$S/host.out"; }

# R5. no host unit: the agent takes its request back and fails, honestly
setup nopickup
PICKUP=2 agent kratos; arc=$?
[ "$arc" != 0 ] && [ -e "$DEPLOY/state/requests/compose.unclaimed.json" ] && [ ! -e "$DEPLOY/state/requests/compose.json" ] && grep -q "synap units install" "$S/agent.out" \
  && ok "nopickup: nobody took it → taken back (a late unit cannot run it), the fix is named" || { bad "nopickup: agent=$arc"; cat "$S/agent.out"; }

# R6. --no-wait (pod-agent recreating itself) returns once the host took it
setup nowait
agent --no-wait --recreate --no-deps --profile pod-agent pod-agent & ap=$!; host; wait "$ap"; arc=$?
[ "$arc" = 0 ] && grep -qxF "$DEPLOY|compose --profile pod-agent up -d --no-build --force-recreate --no-deps pod-agent" "$FAKE_LOG" && grep -q "the host took request" "$S/agent.out" \
  && ok "nowait: pod-agent's own recreate is handed to the host and the agent returns once it is taken" || { bad "nowait: agent=$arc"; cat "$S/agent.out"; }

# R7. the units that watch the request
setup units
mkdir -p "$S/run" "$S/units"
( cd "$S" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_SYSTEMD_RUN_DIR="$S/run" SYNAP_SYSTEMD_DIR="$S/units" bash "$REPO/synap" units install ) >"$S/units.out" 2>&1 </dev/null
real="$(cd "$DEPLOY" && pwd -P)"
grep -qx "PathExists=$real/state/requests/compose.json" "$S/units/synap-compose.path" 2>/dev/null \
  && grep -qE "^ExecStart=/.*/repo/synap compose-request$" "$S/units/synap-compose.service" \
  && grep -q "enable --now .*synap-compose.path" "$TMP/systemctl.log" \
  && ok "units: synap-compose.path watches state/requests/compose.json, enabled; the service runs synap compose-request" || { bad "units: $(ls "$S/units") $(cat "$S/units.out" | tail -3)"; }

# R8. the upgrade path (H1 bootstrap): an engine without _ue_units_refresh
# (≤ v1.1.4) installs the new `synap` and unit templates but never the units.
# synap-heal.timer runs the INSTALLED `synap`, so the next heal tick converges
# them. Modelled: units installed from the PRE-H3 template set (no
# synap-compose.*), then the new release's files land, then `synap heal`.
heal() { ( cd "$S" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_SYSTEMD_RUN_DIR="$S/run" SYNAP_SYSTEMD_DIR="$S/units" "$@" bash "$REPO/synap" heal ) >"$S/heal.out" 2>&1 </dev/null; }
reloads() { grep -c '^daemon-reload' "$TMP/systemctl.log" 2>/dev/null; true; }   # grep -c prints 0 itself
setup upgrade
mkdir -p "$S/run" "$S/units" "$S/old"
cp -R "$DEPLOY/systemd" "$S/old/systemd"; rm -f "$S/old/systemd/synap-compose."*
cp -R "$DEPLOY/systemd" "$S/new-systemd"; rm -rf "$DEPLOY/systemd"; cp -R "$S/old/systemd" "$DEPLOY/systemd"
( cd "$S" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_SYSTEMD_RUN_DIR="$S/run" SYNAP_SYSTEMD_DIR="$S/units" bash "$REPO/synap" units install ) >"$S/units.out" 2>&1 </dev/null
rm -rf "$DEPLOY/systemd"; cp -R "$S/new-systemd" "$DEPLOY/systemd"    # the old engine installed the release's files
[ -f "$S/units/synap-heal.timer" ] && [ ! -e "$S/units/synap-compose.path" ] && ok "upgrade: before heal, the host has the old unit set (no synap-compose.path)" || bad "upgrade: setup: $(ls "$S/units")"
: > "$TMP/systemctl.log"
heal; hrc=$?
grep -qx "PathExists=$(cd "$DEPLOY" && pwd -P)/state/requests/compose.json" "$S/units/synap-compose.path" 2>/dev/null \
  && grep -q "enable --now .*synap-compose.path" "$TMP/systemctl.log" && [ "$hrc" = 0 ] && grep -q "units re-rendered" "$S/heal.out" \
  && ok "upgrade: one heal tick installs + enables synap-compose.path from the installed synap" || { bad "upgrade: rc=$hrc units=$(ls "$S/units" | tr '\n' ' ') heal=$(tail -3 "$S/heal.out")"; }
: > "$TMP/systemctl.log"; heal
[ "$(reloads)" = 0 ] && ! grep -q "units" "$S/heal.out" && ok "upgrade: units current → the next heal touches nothing (no daemon-reload)" || bad "upgrade: heal re-installed current units (reloads=$(reloads)): $(cat "$S/heal.out")"
# never where the owner did not install units (no synap-heal.timer)
setup nounits
mkdir -p "$S/run" "$S/units"; : > "$TMP/systemctl.log"; heal
[ -z "$(ls -A "$S/units")" ] && [ "$(reloads)" = 0 ] && ok "nounits: heal never installs units the owner did not install" || bad "nounits: heal installed $(ls "$S/units")"
# never half-way through an update: the lock is busy → next tick
setup unitsbusy
mkdir -p "$S/run" "$S/units"
( cd "$S" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_SYSTEMD_RUN_DIR="$S/run" SYNAP_SYSTEMD_DIR="$S/units" bash "$REPO/synap" units install ) >/dev/null 2>&1 </dev/null
rm -f "$S/units/synap-compose."*
mkdir -p "$DEPLOY/state/update.lock.d"; echo "synap update pid=$$ since=now" > "$DEPLOY/state/update.lock.d/owner"
: > "$TMP/systemctl.log"; heal env SYNAP_LOCK_IMPL=mkdir
[ ! -e "$S/units/synap-compose.path" ] && [ "$(reloads)" = 0 ] && grep -q "holds the update lock" "$S/heal.out" \
  && ok "unitsbusy: an update holds the lock → heal leaves the units for the next tick" || bad "unitsbusy: $(ls "$S/units" | tr '\n' ' ') $(cat "$S/heal.out")"

exit $fail
