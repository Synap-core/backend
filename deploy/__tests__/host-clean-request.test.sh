#!/usr/bin/env bash
# The clean door (plan P3): the backend writes state/clean/request.json, the
# host runs `synap clean-request` (synap-clean.path) — only regenerable
# clean-ups, never postgres, never a volume, a backup or a dump.
#
# The REAL `synap clean-request` against a fake `docker` (images as a state
# file, every call logged) and a fake `df` whose free space grows by what the
# fake prune frees.
#   K. contracts: the request fixtures validate against
#      clean-request.v1.schema.json and every result written here against
#      clean-result.v1.schema.json (json-schema-lite.jq).
#   P. prune-build-cache: the capped prune (2 GB), done, freedBytes measured.
#   I. prune-old-images: only this pod's old release image goes; the current
#      and previous release (rollback) and another stack's image stay; no
#      pre-update dump is touched and no build cache prune runs.
#   S. restart-service: an allowlisted service is restarted; postgres,
#      postgres-backup and a service outside the list are refused and nothing
#      runs.
#   R. refusals: an unknown action, a request with no uuid id, broken JSON —
#      refused, nothing runs, each one answered.
#   L. the update lock held by a live operation: failed, nothing runs.
#   E. every answer is a `pod.clean` event; the request is taken (no .path loop).
#   M. the mounts: the backend writes state/kit and state/clean only, never
#      state/requests/ (update, compose, archive requests) nor the deploy dir.
# NOT covered: systemd itself (request-units.test.sh emulates the .path unit
# from the rendered templates, including synap-clean.path); real Docker.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }
VALIDATE="$HERE/deploy/__tests__/fixtures/json-schema-lite.jq"
violations() { jq -rn --slurpfile s "$HERE/deploy/schemas/$1" --slurpfile d "$2" -f "$VALIDATE"; }
ID=0b5e7c1a-3f2d-4a8e-9c61-2d4f8a7b9e10

mkdir -p "$TMP/bin"
# images.tsv: id|repo|tag|digest
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
F="$FAKE"; IM="$F/images.tsv"
printf '%s\n' "$*" >> "$F/log"
case "$*" in
  "info --format {{.DockerRootDir}}") echo "$F/docker-root"; exit 0 ;;
  "builder prune -f --max-used-space 2gb"|"builder prune -f --keep-storage 2gb")
    [ -n "${FAKE_PRUNE_FAIL:-}" ] && exit 1
    read -r t u a < "$F/df.docker-root"; echo "$t $((u - 1500000000)) $((a + 1500000000))" > "$F/df.docker-root"; exit 0 ;;
  "compose restart "*) [ -n "${FAKE_RESTART_FAIL:-}" ] && { echo "Error response from daemon: boom" >&2; exit 1; }; exit 0 ;;
  "image inspect -f {{.Id}} "*) awk -F'|' -v r="$5" '$2 ":" $3 == r { print $1; f = 1 } END { exit !f }' "$IM"; exit $? ;;
  "ps -aq") exit 0 ;;
  "images --digests --no-trunc --format "*) awk -F'|' '{ print $1 "|" $2 "|" $3 "|" $4 }' "$IM"; exit 0 ;;
  "images -q "*) exit 0 ;;
  "rmi "*)
    awk -F'|' -v r="$2" '$2 ":" $3 != r' "$IM" > "$IM.n"; mv "$IM.n" "$IM"
    read -r t u a < "$F/df.docker-root"; echo "$t $((u - 500000000)) $((a + 500000000))" > "$F/df.docker-root"; exit 0 ;;
esac
exit 0
D
cat > "$TMP/bin/df" <<'D'
#!/usr/bin/env bash
p="${@: -1}"; f="$FAKE/df.$(basename "$p")"
[ -f "$f" ] || { echo "df: $p: No such file or directory" >&2; exit 1; }
echo "Filesystem 1-blocks Used Available Capacity Mounted on"
echo "/dev/fake $(cat "$f") /"
D
chmod +x "$TMP/bin/"*

setup() {
  S="$TMP/$1"; REPO="$S/repo"; DEPLOY="$REPO/deploy"; FAKE="$S/fake"
  mkdir -p "$DEPLOY/state/clean" "$REPO/kratos" "$FAKE/docker-root"
  cp "$HERE/synap" "$REPO/synap"
  cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$DEPLOY/"
  cp -R "$HERE/deploy/systemd" "$DEPLOY/systemd"
  printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\n' > "$DEPLOY/.env"
  export FAKE; : > "$FAKE/log"
  echo "200000000000 150000000000 30000000000" > "$FAKE/df.docker-root"
  printf '%s\n' "sha256:cur|ghcr.io/synap-core/backend|v2|<none>" "sha256:prev|ghcr.io/synap-core/backend|v1|<none>" \
    "sha256:old|ghcr.io/synap-core/backend|v0|<none>" "sha256:other|ghcr.io/open-webui/open-webui|main|<none>" > "$FAKE/images.tsv"
  echo '{"schema":1,"id":"v2","images":{"SYNAP_IMAGE_BACKEND":"ghcr.io/synap-core/backend:v2"}}' > "$DEPLOY/state/current-release.json"
  echo '{"schema":1,"id":"v1","images":{"SYNAP_IMAGE_BACKEND":"ghcr.io/synap-core/backend:v1"}}' > "$DEPLOY/state/previous-release.json"
  for d in 20261001T000000Z-pre-update 20261005T000000Z-pre-update 20261010T000000Z-pre-update; do mkdir -p "$DEPLOY/backups/postgres/$d"; done
}
ask() { # <json> — the backend's write: tmp + rename inside state/clean/
  printf '%s\n' "$1" > "$DEPLOY/state/clean/.request.json.tmp" && mv "$DEPLOY/state/clean/.request.json.tmp" "$DEPLOY/state/clean/request.json"
}
host() {
  ( cd "$S" || exit 1; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_LOCK_IMPL=mkdir SYNAP_ASSUME_YES=1 bash "$REPO/synap" clean-request ) >"$S/out" 2>&1 </dev/null
}
res() { jq -r "$1" "$DEPLOY/state/clean/result.json" 2>/dev/null; }
valid_result() {
  local v; v="$(violations clean-result.v1.schema.json "$DEPLOY/state/clean/result.json")"
  [ -z "$v" ] && ok "$1: the result is valid against clean-result.v1.schema.json" || bad "$1: result violations: $v"
}
acted() { grep -E '^(builder prune|compose restart|rmi|system|volume|image prune|container prune)' "$FAKE/log"; }
req() { jq -cn --arg id "$ID" --arg a "$1" --arg s "${2:-}" '{id: $id, action: $a, requestedBy: "u-1", requestedAt: "2026-11-04T10:00:00Z"} + (if $s == "" then {} else {service: $s} end)'; }

# ── K. the request fixtures are the contract's ───────────────────────────────
setup k
for r in "$(req prune-build-cache)" "$(req prune-old-images)" "$(req restart-service backend)"; do
  printf '%s\n' "$r" > "$S/r.json"; v="$(violations clean-request.v1.schema.json "$S/r.json")"
  [ -z "$v" ] && ok "contract: $(jq -r '.action + " " + (.service // "")' "$S/r.json")is a valid clean request" || bad "contract: fixture invalid: $v"
done
printf '%s\n' "$(req restart-service postgres)" > "$S/r.json"
violations clean-request.v1.schema.json "$S/r.json" | grep -q 'service' && ok "contract: the schema itself has no postgres restart" || bad "contract: the schema admits restarting postgres"

# ── P. prune-build-cache ─────────────────────────────────────────────────────
setup prune
ask "$(req prune-build-cache)"; host; rc=$?
[ "$rc" = 0 ] && [ "$(res .status)" = "done" ] && [ "$(res .id)" = "$ID" ] && [ "$(res .action)" = prune-build-cache ] \
  && ok "prune: done, answered for the request's id" || { bad "prune: rc=$rc $(cat "$DEPLOY/state/clean/result.json" 2>/dev/null)"; tail -5 "$S/out"; }
[ "$(acted)" = "builder prune -f --max-used-space 2gb" ] && ok "prune: exactly the capped prune (2 GB kept), nothing else" || bad "prune: acted: $(acted)"
[ "$(res .freedBytes)" = 1500000000 ] && ok "prune: freedBytes = the free space gained on Docker's root" || bad "prune: freedBytes $(res .freedBytes)"
valid_result prune
[ ! -e "$DEPLOY/state/clean/request.json" ] && [ -e "$DEPLOY/state/clean/request.taken.json" ] && ok "prune: the request was taken (no .path loop)" || bad "prune: request not taken"
jq -e --arg id "$ID" 'select(.kind == "pod.clean") | .request == $id and .status == "done" and .requestedBy == "u-1" and .freedBytes == 1500000000' "$DEPLOY/state/events.jsonl" >/dev/null \
  && ok "prune: a pod.clean event in state/events.jsonl" || bad "prune: events $(cat "$DEPLOY/state/events.jsonl" 2>/dev/null)"
setup prunefail
ask "$(req prune-build-cache)"; FAKE_PRUNE_FAIL=1 host; rc=$?
[ "$rc" != 0 ] && [ "$(res .status)" = failed ] && [ "$(res .freedBytes)" = null ] && ok "prunefail: a prune Docker refused is failed, no freedBytes" || bad "prunefail: rc=$rc $(res .)"
valid_result prunefail

# ── I. prune-old-images ──────────────────────────────────────────────────────
setup images
ask "$(req prune-old-images)"; host; rc=$?
[ "$rc" = 0 ] && [ "$(res .status)" = "done" ] && [ "$(acted)" = "rmi ghcr.io/synap-core/backend:v0" ] \
  && ok "images: only the old release image v0 is removed" || { bad "images: rc=$rc acted=$(acted)"; tail -5 "$S/out"; }
grep -q '|v2|' "$FAKE/images.tsv" && grep -q '|v1|' "$FAKE/images.tsv" && grep -q 'open-webui' "$FAKE/images.tsv" \
  && ok "images: the current (v2) and previous (v1) release and another stack's image stay" || bad "images: left $(cat "$FAKE/images.tsv")"
dumps=("$DEPLOY/backups/postgres/"*-pre-update); [ "${#dumps[@]}" = 3 ] && ok "images: all 3 pre-update dumps are kept (the door never prunes dumps)" || bad "images: dumps left: $(ls "$DEPLOY/backups/postgres")"
! grep -q '^builder prune' "$FAKE/log" && ok "images: no build cache prune (that is the other action)" || bad "images: pruned the cache too"
[ "$(res .freedBytes)" = 500000000 ] && ok "images: freedBytes measured" || bad "images: freedBytes $(res .freedBytes)"
valid_result images
setup norelease
rm -f "$DEPLOY/state/current-release.json"
ask "$(req prune-old-images)"; host
[ "$(res .status)" = "done" ] && [ -z "$(acted)" ] && [[ "$(res .detail)" == *"no release record"* ]] \
  && ok "norelease: no release record → done, no image removed, said so" || bad "norelease: $(res .) acted=$(acted)"

# ── S. restart-service ───────────────────────────────────────────────────────
setup restart
ask "$(req restart-service backend)"; host; rc=$?
[ "$rc" = 0 ] && [ "$(res .status)" = "done" ] && [ "$(acted)" = "compose restart backend" ] \
  && ok "restart: backend restarted, nothing else" || { bad "restart: rc=$rc acted=$(acted)"; tail -5 "$S/out"; }
valid_result restart
setup restartfail
ask "$(req restart-service kratos)"; FAKE_RESTART_FAIL=1 host; rc=$?
[ "$rc" != 0 ] && [ "$(res .status)" = failed ] && [[ "$(res .detail)" == *boom* ]] && ok "restartfail: a failed restart is failed, with Docker's line" || bad "restartfail: $(res .)"
for svc in postgres postgres-backup caddy "" "backend; rm -rf /"; do
  setup "refuse-svc"
  ask "$(req restart-service "$svc")"; host; rc=$?
  [ "$rc" != 0 ] && [ "$(res .status)" = refused ] && [ -z "$(acted)" ] && ! grep -q '^compose restart' "$FAKE/log" \
    && ok "refuse: restart-service '${svc}' is refused and nothing runs" || bad "refuse: '${svc}' rc=$rc $(res .status) acted=$(acted)"
done
valid_result refuse-svc

# ── R. refusals ──────────────────────────────────────────────────────────────
setup unknown
ask "$(req system-prune)"; host; rc=$?
[ "$rc" != 0 ] && [ "$(res .status)" = refused ] && [ "$(res .id)" = "$ID" ] && [ -z "$(acted)" ] \
  && ok "unknown: an unknown action is refused, answered for its id, nothing runs" || bad "unknown: $(res .) acted=$(acted)"
valid_result unknown
setup noid
ask '{"id":"../../etc","action":"prune-build-cache"}'; host; rc=$?
[ "$rc" != 0 ] && [ "$(res .status)" = refused ] && [ "$(res .id)" = "" ] && [ -z "$(acted)" ] \
  && ok "noid: a request without a uuid id is refused, nothing runs" || bad "noid: $(res .) acted=$(acted)"
valid_result noid
setup broken
ask '{"id": "'"$ID"'", "action": '; host; rc=$?
[ "$rc" != 0 ] && [ "$(res .status)" = refused ] && [ -z "$(acted)" ] && ok "broken: broken JSON is refused, nothing runs" || bad "broken: $(res .) acted=$(acted)"
setup none
host; rc=$?
[ "$rc" = 0 ] && [ ! -e "$DEPLOY/state/clean/result.json" ] && ok "none: no request → nothing written" || bad "none: rc=$rc"

# ── L. the update lock ───────────────────────────────────────────────────────
setup lock
mkdir -p "$DEPLOY/state/update.lock.d"; echo "synap update pid=$$ since=2026-11-04T00:00:00Z" > "$DEPLOY/state/update.lock.d/owner"
ask "$(req prune-build-cache)"; SYNAP_CLEAN_LOCK_WAIT=1 host; rc=$?
[ "$rc" != 0 ] && [ "$(res .status)" = failed ] && [[ "$(res .detail)" == *"update lock"* ]] && [ -z "$(acted)" ] \
  && [ -d "$DEPLOY/state/update.lock.d" ] && ok "lock: held by a live update → failed, nothing runs, the holder's lock is left" || bad "lock: rc=$rc $(res .) acted=$(acted)"

# ── M. the backend's writable mounts ─────────────────────────────────────────
mounts="$(awk '/^  backend:$/ { b = 1; next } b && /^  [a-z]/ { b = 0 } b && /^      - \./ { print $2 }' "$HERE/deploy/docker-compose.yml")"
[ -n "$mounts" ] && ok "mounts: read the backend's binds: $(echo $mounts)" || bad "mounts: no backend binds found — the scan is blind"
rw="$(printf '%s\n' $mounts | grep -v ':ro$' | sort | tr '\n' ' ')"
[ "$rw" = "./state/clean:/opt/synap/deploy/state/clean:rw ./state/kit:/opt/synap/deploy/state/kit:rw " ] \
  && ok "mounts: the backend may write state/kit and state/clean only" || bad "mounts: the backend's writable binds are: $rw"
grep -qE '^PathExists=@DEPLOY_DIR@/state/clean/request\.json$' "$HERE/deploy/systemd/synap-clean.path" \
  && ok "mounts: synap-clean.path watches state/clean/request.json, the file the backend writes" || bad "mounts: synap-clean.path watches $(grep PathExists "$HERE/deploy/systemd/synap-clean.path")"

exit $fail
