#!/usr/bin/env bash
# `synap doctor` (update-door plan P3): read-only, one finding per problem,
# non-zero exit on any finding, `--json` for machines.
#
# Daemon-free: the REAL `synap` in a throwaway git checkout, with a fake
# `docker` that plays either a HEALTHY pod or the DRIFTED shape the team pod
# had on 2026-10-04 (stray `deploy` project, local compose edit, runtime keys
# in .env, no release record match, hand override, no off-host backups,
# in-layer postgres). Asserts every check fires on its own fixture, stays
# quiet on the healthy one, and that doctor never ran a mutating command.
#
# Not covered: the HTTP probe of PUBLIC_URL (SYNAP_DOCTOR_PROBE=0 here — it
# needs a network). Disk uses the host's real df with the threshold forced
# (SYNAP_DOCTOR_MIN_FREE_PCT) — 0 elsewhere so a full dev disk cannot redden it.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }

SHA="$(printf 'b%.0s' $(seq 1 40))"
REPO="$TMP/repo"; DEPLOY="$REPO/deploy"
mkdir -p "$TMP/bin" "$DEPLOY/state" "$DEPLOY/backups/postgres"
cp "$HERE/synap" "$REPO/synap"
cp "$HERE/deploy/ensure-ory-databases.sh" "$HERE/deploy/pgdata-safety.sh" "$HERE/deploy/update-lock.sh" \
   "$HERE/deploy/env-config.sh" "$HERE/deploy/env.schema" "$HERE/deploy/docker-compose.yml" "$DEPLOY/"
printf 'deploy/.env\ndeploy/.env.bak.*\ndeploy/state/\ndeploy/backups/\n' > "$REPO/.gitignore"
git -C "$REPO" init -q && git -C "$REPO" add -A && git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init

healthy_env() {
  cat > "$DEPLOY/.env" <<E
DOMAIN=pod.example.com
PUBLIC_URL=https://pod.example.com
COMPOSE_PROJECT_NAME=synap-backend
POSTGRES_PASSWORD=pgpass
JWT_SECRET=jwtsecret
KRATOS_SECRETS_COOKIE=cookie
BACKUP_REPOSITORY=/srv/restic
SYNAP_RELEASE_ID=main-bbbbbbb
SYNAP_IMAGE_BACKEND=ghcr.io/synap-core/backend@sha256:new
E
  chmod 600 "$DEPLOY/.env"
  mkdir -p "$DEPLOY/state/backup"; echo pw > "$DEPLOY/state/backup/restic-password"
  jq -n --arg sha "$SHA" '{schema:1,id:"main-bbbbbbb",gitSha:$sha,images:{SYNAP_IMAGE_BACKEND:"ghcr.io/synap-core/backend@sha256:new"}}' > "$DEPLOY/state/current-release.json"
  rm -rf "$DEPLOY/backups/postgres"; mkdir -p "$DEPLOY/backups/postgres/20261004T100000Z-auto"
  rm -f "$DEPLOY/docker-compose.override.yml"
}

# Fake docker: FAKE_POD=healthy|drifted
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "ps -a --filter label=com.docker.compose.service=postgres"*)
    echo "synap-backend|$FAKE_DEPLOY"
    [ "$FAKE_POD" = drifted ] && echo "deploy|$FAKE_DEPLOY" ;;
  "compose ls -a --format json")
    if [ "$FAKE_POD" = drifted ]; then
      printf '[{"Name":"synap-backend","Status":"running(12)","ConfigFiles":"%s/docker-compose.yml"},{"Name":"deploy","Status":"running(1)","ConfigFiles":"%s/docker-compose.yml"},{"Name":"eve","Status":"running(3)","ConfigFiles":"/opt/eve/docker-compose.yml"}]\n' "$FAKE_DEPLOY" "$FAKE_DEPLOY"
    else
      printf '[{"Name":"synap-backend","Status":"running(12)","ConfigFiles":"%s/docker-compose.yml"},{"Name":"eve","Status":"running(3)","ConfigFiles":"/opt/eve/docker-compose.yml"}]\n' "$FAKE_DEPLOY"
    fi ;;
  "compose ps -q --status running backend") echo becid ;;
  "inspect -f {{.Image}} becid") [ "$FAKE_POD" = drifted ] && echo sha256:oldlocal || echo sha256:newimg ;;
  "image inspect -f {{.Id}} ghcr.io/synap-core/backend@sha256:new") echo sha256:newimg ;;
  "exec becid node -e "*) printf '{"buildStamp":"%s"}' "$FAKE_STAMP" ;;
  "compose ps -a -q postgres") echo pgcid ;;
  *"{{range .Config.Env}}"*) echo PGDATA=/home/postgres/pgdata/data ;;
  *"{{range .Mounts}}"*) [ "$FAKE_POD" = drifted ] && echo /var/lib/other || echo /home/postgres/pgdata ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker"
export FAKE_LOG="$TMP/log" FAKE_DEPLOY="$DEPLOY" FAKE_STAMP="$SHA"

doctor() { # <healthy|drifted> [args]
  local pod="$1"; shift
  : > "$FAKE_LOG"
  ( cd "$TMP"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_DOCTOR_PROBE=0 SYNAP_DOCTOR_MIN_FREE_PCT="${MIN_FREE:-0}" FAKE_POD="$pod" bash "$REPO/synap" doctor "$@" ) >"$TMP/out" 2>"$TMP/err"
}
finding() { jq -e --arg c "$1" --arg re "$2" '[.findings[] | select(.check == $c and (.message | test($re)))] | length > 0' "$TMP/out" >/dev/null 2>&1; }
state_sum() { (cd "$DEPLOY" && find . -type f ! -path './state/update.lock*' -exec cksum {} + | sort; cd "$REPO" && git status --porcelain) | cksum; }

# ── 1. a healthy pod: exit 0, no findings, every check reported ──────────────
healthy_env
doctor healthy; rc=$?
[ "$rc" = 0 ] && ok "healthy pod: exit 0" || bad "healthy pod exit $rc: $(cat "$TMP/out" "$TMP/err")"
grep -q "No findings" "$TMP/out" && ok "healthy pod: 'No findings'" || bad "healthy text: $(cat "$TMP/out")"
doctor healthy --json; rc=$?
[ "$rc" = 0 ] && [ "$(jq -r .ok "$TMP/out")" = true ] && [ "$(jq '.findings|length' "$TMP/out")" = 0 ] && ok "healthy --json: ok:true, 0 findings" || bad "healthy json (rc=$rc): $(cat "$TMP/out" "$TMP/err")"
for c in env project checkout release override backup pgdata; do
  jq -e --arg c "$c" '[.checks[] | select(.check == $c and .severity == "ok")] | length > 0' "$TMP/out" >/dev/null && : || bad "healthy: check '$c' did not report ok"
done
ok "healthy: env, project, checkout, release, override, backup, pgdata all report ok"

# ── 2. the drifted pod: every check fires ────────────────────────────────────
healthy_env
printf 'NODE_VERSION=20\nPATH=/usr/bin\n' >> "$DEPLOY/.env"
sed -i.x '/^BACKUP_REPOSITORY=/d' "$DEPLOY/.env" && rm -f "$DEPLOY/.env.x"
chmod 644 "$DEPLOY/.env"
echo "# local edit" >> "$DEPLOY/docker-compose.yml"
printf 'services:\n  backend:\n    environment:\n      X: 1\n' > "$DEPLOY/docker-compose.override.yml"
rm -rf "$DEPLOY/backups/postgres"/*; echo "0 users" > "$DEPLOY/backups/postgres/.alarm"
sum_before="$(state_sum)"; touch "$TMP/marker"; sleep 1
doctor drifted --json; rc=$?
[ "$rc" != 0 ] && [ "$(jq -r .ok "$TMP/out")" = false ] && ok "drifted pod: non-zero exit, ok:false" || bad "drifted (rc=$rc): $(cat "$TMP/out" "$TMP/err")"
finding env "NODE_VERSION: unknown key"          && ok "finds a runtime key (NODE_VERSION) in .env"   || bad "env: NODE_VERSION not reported"
finding env "PATH: unknown key"                  && ok "finds PATH in .env"                           || bad "env: PATH not reported"
finding env "readable by every local user"       && ok "finds a world-readable .env"                  || bad "env: mode not reported"
finding project "other compose project.*deploy" && ok "finds the stray 'deploy' compose project"     || bad "project: stray project not reported: $(jq -c .findings "$TMP/out")"

finding checkout "docker-compose.yml"            && ok "finds the locally modified compose file"      || bad "checkout: local edit not reported"
finding release "running backend image"          && ok "finds the running image ≠ the release record" || bad "release: image drift not reported"
finding override "no eve-managed marker"         && ok "finds an unmanaged override"                  || bad "override: not reported"
finding backup "no off-host backup"              && ok "finds 'no off-host repository'"               || bad "backup: repository not reported"
finding backup "ALERT alarm"                     && ok "finds a backup alarm"                         || bad "backup: alarm not reported"
finding backup "no hourly database dump"         && ok "finds 'no dump'"                              || bad "backup: missing dump not reported"
finding pgdata "writable layer"                  && ok "finds the in-layer postgres cluster"          || bad "pgdata: legacy layout not reported"
jq -e '.findings | length >= 10' "$TMP/out" >/dev/null && ok "every finding is listed ($(jq '.findings|length' "$TMP/out"))" || bad "too few findings"

# ── 3. read-only ──────────────────────────────────────────────────────────────
grep -E "compose (.* )?(up|run|create|down|rm|stop|start|restart|pull|build)( |$)|^(rm|stop|kill|pull|tag|rmi|run|volume|system|image prune|network rm)" "$FAKE_LOG" \
  && bad "doctor ran a mutating docker command" || ok "doctor ran no mutating docker command ($(wc -l < "$FAKE_LOG" | tr -d ' ') read calls)"
touched="$(find "$REPO" -newer "$TMP/marker" -type f ! -path '*/.git/*' ! -name 'update.lock*' 2>/dev/null)"
[ "$(state_sum)" = "$sum_before" ] && [ -z "$touched" ] && ok "doctor created or changed no file in the deploy dir or the checkout" || bad "doctor wrote: ${touched:-content changed}"

# ── 4. buildStamp drift with the right image ─────────────────────────────────
healthy_env; git -C "$REPO" show HEAD:deploy/docker-compose.yml > "$DEPLOY/docker-compose.yml"
FAKE_STAMP="$(printf 'a%.0s' $(seq 1 40))" doctor healthy --json; rc=$?
[ "$rc" != 0 ] && finding release "buildStamp aaaaaaaaaaaa" && ok "finds buildStamp ≠ release gitSha" || bad "buildStamp drift (rc=$rc): $(jq -c .findings "$TMP/out")"

# ── 5. no release record / two unpinned owners (doctor is exempt from the refusal) ──
healthy_env; rm -f "$DEPLOY/state/current-release.json"; sed -i.x '/^COMPOSE_PROJECT_NAME=/d' "$DEPLOY/.env" && rm -f "$DEPLOY/.env.x"
doctor drifted --json; rc=$?
[ "$rc" != 0 ] && finding release "no state/current-release.json" && ok "finds a pod with no release record" || bad "no release record: $(cat "$TMP/out" "$TMP/err" | head -5)"
finding project "each own a postgres container" && ok "doctor still runs (and reports) when two projects own postgres" || bad "conflict: $(cat "$TMP/out" "$TMP/err" | head -5)"
healthy_env; sed -i.x '/^COMPOSE_PROJECT_NAME=/d' "$DEPLOY/.env" && rm -f "$DEPLOY/.env.x"
doctor healthy --json
finding project "not pinned" && ok "finds an unpinned COMPOSE_PROJECT_NAME" || bad "pin: $(jq -c .findings "$TMP/out")"

# ── 6. disk below the threshold is a finding (the host's real df; threshold forced)
healthy_env; MIN_FREE=101 doctor healthy --json
finding disk "free on" && ok "low disk is a finding" || bad "disk: $(jq -c .findings "$TMP/out")"

# ── 7. Eve-managed override without an edge pin ──────────────────────────────
healthy_env; printf '# eve-managed: loopback\nservices:\n  backend:\n    ports: ["127.0.0.1:4000:4000"]\n' > "$DEPLOY/docker-compose.override.yml"
doctor healthy --json
finding override "SYNAP_EDGE is not pinned" && ok "Eve override without SYNAP_EDGE is a finding" || bad "eve override: $(jq -c .findings "$TMP/out")"
echo "SYNAP_EDGE=traefik" >> "$DEPLOY/.env"
doctor healthy --json; [ $? = 0 ] && ok "…and pinned SYNAP_EDGE=traefik clears it" || bad "edge pin not honoured: $(jq -c .findings "$TMP/out")"
exit $fail
