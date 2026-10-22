#!/usr/bin/env bash
# Tripwire: a request .path unit can never retrigger itself.
#
# synap-update.path and synap-compose.path start their service while
# state/requests/<name>.json EXISTS (PathExists=). The engine used to rename
# the file away itself, so a run that died BEFORE that rename (a broken bundle,
# no jq, the compose-project refusal, any `set -e` exit) left it in place and
# systemd restarted the service at once. Measured on systemd 252 (devbox,
# 2026-10-21, the real templates): 5 runs in one second, the .path unit
# 'failed (unit-start-limit-hit)', and no later request was ever picked up.
# Now the service's ExecStartPre takes the request before the engine starts.
#
# Daemon-free emulation of systemd, DERIVED from the rendered units (`synap
# units install` into a temp dir): every *.path unit, its PathExists= file and
# its Unit= service; an activation exports the service's Environment= lines,
# runs each ExecStartPre= ($$ → $, as systemd unescapes) then ExecStart=; the
# .path loop re-activates while the watched file exists (capped at 6).
#   A. an engine that dies at once: ONE run, the request taken.
#   B. the real engine on a pre-taken request: compose runs it to 'succeeded';
#      update refuses an invalid one and records its id. One run each.
#   C. a start with no request (the update timer): a taken file left by an
#      older run is dropped, never run again.
#   ExecStopPost=: a request the engine never answered (A) gets a terminal
#      "failed" outcome the waiting side reads; one the engine answered (B)
#      is left exactly as the engine wrote it.
# NOT covered: systemd's own start-limit accounting and inotify (measured on the
# devbox, above), ExecStopPost/Restart= (none are used).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
case "$*" in
  "compose config --profiles") printf '%s\n' pod-agent; exit 0 ;;
  "compose"*"config --services") printf '%s\n' postgres kratos backend caddy; exit 0 ;;
esac
exit 0
D
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/systemctl"
chmod +x "$TMP/bin/docker" "$TMP/bin/systemctl"

setup() {
  S="$TMP/$1"; REPO="$S/repo"; DEPLOY="$REPO/deploy"; UNITS="$S/units"
  mkdir -p "$DEPLOY/state/requests" "$REPO/kratos" "$S/run" "$UNITS"
  cp "$HERE/synap" "$REPO/synap"; chmod +x "$REPO/synap"
  cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$DEPLOY/"
  cp -R "$HERE/deploy/systemd" "$DEPLOY/systemd"
  printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\nPOSTGRES_PASSWORD=x\nJWT_SECRET=x\nKRATOS_SECRETS_COOKIE=x\nPOD_ADMIN_DOMAIN=pod-admin.example.com\n' > "$DEPLOY/.env"
  echo '{"auto":false}' > "$DEPLOY/state/update-policy.json"
  ( cd "$S" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_SYSTEMD_RUN_DIR="$S/run" SYNAP_SYSTEMD_DIR="$UNITS" bash "$REPO/synap" units install ) >"$S/units.out" 2>&1 </dev/null \
    || bad "$1: synap units install failed: $(tail -2 "$S/units.out")"
  REQ="$(cd "$DEPLOY" && pwd -P)/state/requests"
}
field() { sed -n "s/^$2=//p" "$1"; }          # <unit file> <key> → every value, one per line
activate() { # <service file> — what systemd does for one start
  ( cd /
    while IFS= read -r kv; do export "${kv?}"; done < <(field "$1" Environment)
    export PATH="$TMP/bin:$PATH"
    rc=0; result=success
    while IFS= read -r c; do [ -n "$c" ] && { eval "${c//\$\$/\$}" || { rc=$?; result=exit-code; break; }; }; done < <(field "$1" ExecStartPre)
    if [ "$result" = success ]; then eval "$(field "$1" ExecStart)" || { rc=$?; result=exit-code; }; fi
    # ExecStopPost= runs after every start, told how it ended (systemd.exec(5))
    export SERVICE_RESULT="$result" EXIT_CODE=exited EXIT_STATUS="$rc"
    while IFS= read -r c; do [ -n "$c" ] && { eval "${c#-}"; true; }; done < <(field "$1" ExecStopPost | sed 's/\$\$/$/g')   # "-": failure ignored
  ) >>"$S/runs.out" 2>&1 </dev/null
  RUNS=$((RUNS + 1))
}
watch() { # <path unit> — the .path loop: start the service while the file exists
  local watched svc
  watched="$(field "$UNITS/$1" PathExists)"; svc="$(field "$UNITS/$1" Unit)"
  RUNS=0
  while [ -e "$watched" ] && [ "$RUNS" -lt 6 ]; do activate "$UNITS/$svc"; done
}

setup derive
paths="$(cd "$UNITS" && ls -1 *.path 2>/dev/null)"
n="$(printf '%s\n' "$paths" | grep -c .)"
[ "$n" -ge 2 ] && ok "derived $n .path units from the rendered templates: $(echo $paths)" || bad "only $n .path units rendered — the scan is blind"
for p in $paths; do
  w="$(field "$UNITS/$p" PathExists)"; svc="$(field "$UNITS/$p" Unit)"
  [[ "$w" == "$REQ/"*.json ]] && [ -f "$UNITS/$svc" ] && grep -q '^ExecStart=' "$UNITS/$svc" \
    && ok "$p: watches ${w#"$REQ/"}, starts $svc" || bad "$p: PathExists=$w Unit=$svc (rendered: $(ls "$UNITS"))"
done

for p in $paths; do
  name="$(basename "$(field "$UNITS/$p" PathExists)" .json)"

  # A. the engine dies before it can take anything (a broken bundle swap)
  setup "die-$name"
  echo "{\"schema\":1,\"id\":\"a1\",\"release\":\"stable\",\"services\":[]}" > "$REQ/$name.json"
  printf '#!/usr/bin/env bash\nexit 1\n' > "$REPO/synap"
  watch "$p"
  [ "$RUNS" = 1 ] && [ ! -e "$REQ/$name.json" ] && [ "$(jq -r .id "$REQ/$name.taken.json" 2>/dev/null)" = a1 ] \
    && ok "die[$name]: the engine exits 1 at once → ONE run, the request was taken (no restart loop)" \
    || bad "die[$name]: $RUNS runs (6 = the loop), request left=$([ -e "$REQ/$name.json" ] && echo yes || echo no)"
  case "$name" in update) latest="$DEPLOY/state/last-update.json" ;; *) latest="$DEPLOY/state/last-$name-request.json" ;; esac
  jq -e '.status == "failed" and .by == "unit" and .request == "a1" and (.reason | test("stopped before recording an outcome.*exit-code exited 1.*may have changed — run synap doctor"))' "$latest" >/dev/null 2>&1 \
    && grep -q '"request":"a1"' "$DEPLOY/state/events.jsonl" \
    && ok "die[$name]: the waiting side still gets a terminal outcome for a1 (failed, naming how the engine ended)" \
    || bad "die[$name]: no terminal outcome for the taken request: $(cat "$latest" 2>/dev/null)"

  # … an id is matched as a FIXED string: an earlier outcome for "aZ1" is not
  # the answer to request "a.1" (a regex match would think it was).
  setup "dotid-$name"
  case "$name" in update) latest="$DEPLOY/state/last-update.json" ;; *) latest="$DEPLOY/state/last-$name-request.json" ;; esac
  echo '{"kind":"x","status":"succeeded","request":"aZ1"}' > "$latest"
  echo "{\"schema\":1,\"id\":\"a.1\",\"release\":\"stable\",\"services\":[]}" > "$REQ/$name.json"
  printf '#!/usr/bin/env bash\nexit 1\n' > "$REPO/synap"
  watch "$p"
  jq -e '.request == "a.1" and .by == "unit"' "$latest" >/dev/null 2>&1 \
    && ok "dotid[$name]: request a.1 gets its own outcome (an outcome for aZ1 is not a match)" || bad "dotid[$name]: $(cat "$latest")"

  # C. no request (a timer start): an older run's taken file is never run again
  setup "none-$name"
  echo "{\"schema\":1,\"id\":\"stale\",\"release\":\"latest\",\"services\":[\"nosuch\"]}" > "$REQ/$name.taken.json"
  RUNS=0; activate "$UNITS/$(field "$UNITS/$p" Unit)"
  [ ! -e "$REQ/$name.taken.json" ] && ! grep -q '"stale"' "$DEPLOY/state/events.jsonl" 2>/dev/null \
    && ok "none[$name]: a start with no request drops the stale taken file and runs nothing from it" \
    || bad "none[$name]: taken left=$([ -e "$REQ/$name.taken.json" ] && echo yes || echo no) events=$(cat "$DEPLOY/state/events.jsonl" 2>/dev/null)"
done

# B. the real engine reads the request the unit took
setup real-compose
echo '{"schema":1,"id":"c1","services":["kratos"],"recreate":true}' > "$REQ/compose.json"
watch synap-compose.path
[ "$RUNS" = 1 ] && [ "$(jq -r '.status + "|" + .request' "$DEPLOY/state/last-compose-request.json" 2>/dev/null)" = "succeeded|c1" ] \
  && [ "$(grep -c '"request":"c1"' "$DEPLOY/state/events.jsonl")" = 1 ] \
  && ok "real[compose]: the engine runs the pre-taken request c1 to 'succeeded', in one run (its own outcome kept, nothing added)" \
  || { bad "real[compose]: runs=$RUNS record=$(cat "$DEPLOY/state/last-compose-request.json" 2>/dev/null)"; tail -5 "$S/runs.out"; }
setup real-update
echo '{"schema":1,"id":"u1","release":"latest"}' > "$REQ/update.json"
watch synap-update.path
[ "$RUNS" = 1 ] && jq -e '.status == "aborted" and .request == "u1" and (.reason | test("invalid update request u1"))' "$DEPLOY/state/last-update.json" >/dev/null 2>&1 \
  && [ "$(grep -c '"request":"u1"' "$DEPLOY/state/events.jsonl")" = 1 ] \
  && ok "real[update]: the engine reads the pre-taken request u1 and refuses it (release 'latest'), recorded once, one run" \
  || { bad "real[update]: runs=$RUNS record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; tail -5 "$S/runs.out"; }

exit $fail
