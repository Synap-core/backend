#!/usr/bin/env bash
# The archive runs on the HOST: pod-agent only asks for it.
#
# From inside pod-agent's container the pod's volumes are not files it can
# read: archive-pod.sh run there uploaded an EMPTY volumes archive and reported
# "completed" (2026-10-21) — and the CP deletes the server after an archive.
# pod-agent's `archive` command is now deploy/archive-request.sh: it writes
# state/requests/archive.json and waits for `synap archive-request` (started
# by synap-archive.path) to run archive-pod.sh on the host and record the
# outcome with the archive's manifest.
#
#   S. static: pod-agent's `archive` command runs archive-request.sh (server.js
#      COMMANDS), never archive-pod.sh.
#   R. round trip: the REAL agent script + the REAL `synap archive-request`,
#      with a STUB archive-pod.sh in the deploy dir (archive-restore-failure.
#      test.sh covers the real one): the host runs it with ARCHIVE_ON_HOST=1
#      and the request's recipients; the manifest travels back to the agent's
#      last stdout line. Failures carry archive-pod.sh's own ERROR; success
#      without a manifest is a failure; refusals (http URL, non-age
#      recipient); a busy update lock (waited for, bounded); no host unit.
# NOT covered: systemd itself (request-units.test.sh emulates the units).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }
RCPT="age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
URL="https://storage.example/archives/p1/archive.tar.gz.age?X-Amz-Signature=abc&X-Amz-Expires=900"

# ── S. static ────────────────────────────────────────────────────────────────
script="$(awk '/^  archive: \{/{p=1} p && /script:/{print; exit}' "$HERE/deploy/pod-agent/server.js" | sed -n 's/.*script: "\([^"]*\)".*/\1/p')"
[ "$script" = archive-request.sh ] && ok "pod-agent's archive command runs archive-request.sh (the host archives)" || bad "pod-agent's archive command runs '$script'"
grep -qE '^ *script: "archive-pod\.sh"' "$HERE/deploy/pod-agent/server.js" && bad "a pod-agent command still runs archive-pod.sh in the container" || ok "no pod-agent command runs archive-pod.sh in the container"

# ── R. round trip ────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\necho "$*" >> "$FAKE_LOG"\nexit 0\n' > "$TMP/bin/docker"
printf '#!/usr/bin/env bash\necho "wget $*" >> "$FAKE_LOG"\nexit 0\n' > "$TMP/bin/wget"
chmod +x "$TMP/bin/docker" "$TMP/bin/wget"

setup() { # <name> <stub-mode: ok|fail|nomanifest>
  S="$TMP/$1"; REPO="$S/repo"; DEPLOY="$REPO/deploy"
  mkdir -p "$DEPLOY/state"
  cp "$HERE/synap" "$REPO/synap"
  cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$DEPLOY/"
  printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\n' > "$DEPLOY/.env"
  cat > "$DEPLOY/archive-pod.sh" <<STUB
#!/bin/sh
printf 'on_host=%s recipients=%s url=%s work=%s\n' "\${ARCHIVE_ON_HOST:-}" "\${ARCHIVE_AGE_RECIPIENTS:-}" "\$1" "\${ARCHIVE_WORK_DIR:-}" > "$S/stub.args"
case "$2" in
  fail) echo "[2026-10-22T00:00:00Z] [archive] ERROR: volume minio_data (synap-backend_minio_data) could not be read — aborting archive (nothing uploaded, pod kept running)"; exit 1 ;;
  nomanifest) echo "uploaded"; exit 0 ;;
esac
echo "[2026-10-22T00:00:00Z] [archive] === Pod archive finished (upload=true) ==="
echo 'ARCHIVE_MANIFEST {"schema":1,"project":"synap-backend","volumes":[{"name":"minio_data","files":3,"empty":false}],"archive":{"bytes":9}}'
STUB
  export FAKE_LOG="$S/docker.log"; : > "$FAKE_LOG"
}
host() { # the host unit: `synap archive-request`, once the request exists
  local i
  for i in $(seq 1 50); do [ -e "$DEPLOY/state/requests/archive.json" ] && break; sleep 0.1; done
  ( cd "$S" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_ASSUME_YES=1 "$@" bash "$REPO/synap" archive-request ) >"$S/host.out" 2>&1 </dev/null
}
agent() { # pod-agent's archive command, as server.js runs it
  ( PATH="$TMP/bin:$PATH" ARCHIVE_AGE_RECIPIENTS="${RCPTS-$RCPT}" HOST_REQUEST_PICKUP_SECONDS="${PICKUP:-20}" ARCHIVE_TIMEOUT_SECONDS=30 HOST_REQUEST_POLL_SECONDS=1 \
      sh "$DEPLOY/archive-request.sh" "${AURL-$URL}" "" "" ) >"$S/agent.out" 2>&1 </dev/null
}
rec() { jq -r ".$1" "$DEPLOY/state/last-archive-request.json" 2>/dev/null; }

setup ok ok
agent & ap=$!; host; hrc=$?; wait "$ap"; arc=$?
[ "$hrc" = 0 ] && [ "$arc" = 0 ] && [ "$(rec status)" = succeeded ] && [[ "$(rec request)" == archive-* ]] \
  && ok "ok: the host ran the archive and the agent heard 'succeeded'" || { bad "ok: host=$hrc agent=$arc record=$(cat "$DEPLOY/state/last-archive-request.json" 2>/dev/null)"; tail -5 "$S/host.out" "$S/agent.out"; }
grep -qx "on_host=1 recipients=$RCPT url=$URL work=$(cd "$DEPLOY" && pwd -P)/state/archive-work" "$S/stub.args" 2>/dev/null \
  || grep -qx "on_host=1 recipients=$RCPT url=$URL work=$DEPLOY/state/archive-work" "$S/stub.args" 2>/dev/null \
  && ok "ok: archive-pod.sh ran on the host (ARCHIVE_ON_HOST=1) with the request's recipients and URL, working in state/" || bad "ok: stub args: $(cat "$S/stub.args" 2>/dev/null)"
m="$(sed -n 's/^ARCHIVE_MANIFEST //p' "$S/agent.out" | tail -1)"
[ "$(tail -n 1 "$S/agent.out" | cut -c1-17)" = "ARCHIVE_MANIFEST " ] && jq -e '.volumes[0].name == "minio_data" and .volumes[0].files == 3' <<<"$m" >/dev/null 2>&1 \
  && jq -e --argjson m "$m" '.manifest == $m' "$DEPLOY/state/last-archive-request.json" >/dev/null \
  && ok "ok: the manifest is in the host record AND the agent's last stdout line (pod-agent's data.archiveManifest)" || bad "ok: manifest agent=$m record=$(rec manifest)"
[ ! -e "$DEPLOY/state/requests/archive.json" ] && [ "$(stat -c %a "$DEPLOY/state/requests/archive.taken.json" 2>/dev/null || stat -f %Lp "$DEPLOY/state/requests/archive.taken.json")" = 600 ] \
  && ok "ok: the request (it carries a presigned URL) was taken and is mode 600" || bad "ok: request left or readable: $(ls -l "$DEPLOY/state/requests")"

setup fail fail
agent & ap=$!; host; hrc=$?; wait "$ap"; arc=$?
[ "$hrc" != 0 ] && [ "$arc" != 0 ] && [ "$(rec status)" = failed ] && [[ "$(rec reason)" == "volume minio_data (synap-backend_minio_data) could not be read"* ]] \
  && grep -q "could not be read" "$S/agent.out" && ! grep -q '^ARCHIVE_MANIFEST' "$S/agent.out" \
  && ok "fail: archive-pod.sh's own ERROR is the recorded reason, the agent fails with it, no manifest" || { bad "fail: host=$hrc agent=$arc reason=$(rec reason)"; cat "$S/agent.out"; }

setup nomanifest nomanifest
agent & ap=$!; host; hrc=$?; wait "$ap"; arc=$?
[ "$hrc" != 0 ] && [ "$arc" != 0 ] && [ "$(rec status)" = failed ] && [ "$(rec reason)" = "the archive reported success without a manifest" ] \
  && ok "nomanifest: success without a manifest is a FAILED archive (the CP must never delete on it)" || bad "nomanifest: host=$hrc agent=$arc record=$(cat "$DEPLOY/state/last-archive-request.json" 2>/dev/null)"

setup httpurl ok
AURL="http://storage.example/x" agent; arc=$?
[ "$arc" != 0 ] && grep -q ARCHIVE_UPLOAD_URL_INVALID "$S/agent.out" && [ ! -e "$DEPLOY/state/requests/archive.json" ] \
  && ok "httpurl: a non-https upload URL is refused before anything is asked of the host" || bad "httpurl: agent=$arc $(cat "$S/agent.out")"
setup norcpt ok
RCPTS="" agent; arc=$?
[ "$arc" != 0 ] && grep -q ARCHIVE_RECIPIENT_MISSING "$S/agent.out" && [ ! -e "$DEPLOY/state/requests/archive.json" ] \
  && ok "norcpt: no recipient is refused before anything is asked of the host" || bad "norcpt: agent=$arc $(cat "$S/agent.out")"
setup badrcpt ok
mkdir -p "$DEPLOY/state/requests"
printf '{"schema":1,"id":"h1","uploadUrl":"%s","recipients":["ssh-ed25519 AAAA"]}\n' "$URL" > "$DEPLOY/state/requests/archive.json"
host; hrc=$?
[ "$hrc" != 0 ] && [ "$(rec status)" = aborted ] && [ "$(rec request)" = h1 ] && [ ! -e "$S/stub.args" ] \
  && ok "badrcpt: a request whose recipient is not age is refused by the host, nothing run" || bad "badrcpt: host=$hrc record=$(cat "$DEPLOY/state/last-archive-request.json" 2>/dev/null)"

setup busy ok
mkdir -p "$DEPLOY/state/update.lock.d"; ( sleep 8 ) & HOLD=$!; echo "synap update pid=$HOLD since=now" > "$DEPLOY/state/update.lock.d/owner"
agent & ap=$!; SYNAP_LOCK_IMPL=mkdir SYNAP_ARCHIVE_LOCK_WAIT=2 host; hrc=$?; wait "$ap"; arc=$?; kill "$HOLD" 2>/dev/null; wait "$HOLD" 2>/dev/null
[ "$hrc" != 0 ] && [ "$arc" != 0 ] && [ "$(rec status)" = aborted ] && [[ "$(rec reason)" == *"held the update lock for 2s"* ]] && [ ! -e "$S/stub.args" ] \
  && ok "busy: an update holds the lock past the bound → aborted, the archive never ran beside it" || bad "busy: host=$hrc agent=$arc record=$(cat "$DEPLOY/state/last-archive-request.json" 2>/dev/null)"

setup nopickup ok
PICKUP=2 agent; arc=$?
[ "$arc" != 0 ] && [ -e "$DEPLOY/state/requests/archive.unclaimed.json" ] && [ ! -e "$DEPLOY/state/requests/archive.json" ] && grep -q "synap units install" "$S/agent.out" \
  && ok "nopickup: no host unit → the request is taken back (a late unit cannot run it) and the fix is named" || bad "nopickup: agent=$arc $(cat "$S/agent.out")"

exit $fail
