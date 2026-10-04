#!/usr/bin/env bash
# Update DRILL for the one update engine (`synap update`, update-door plan P2).
#
# Daemon-free: the REAL `synap` (engine, canary, pgdata_backup/pgdata_restore,
# verify-deploy.sh, the real docker-compose.yml for the image-key contract)
# against a fake `docker` and `curl` on PATH. The fake docker plays a pod:
# postgres with a migration level that pg_dump/pg_restore carry, a production
# backend whose image is whatever deploy/.env pins at recreate time, a canary,
# and a /status/release that reports that image's buildStamp.
#
# Scenarios (each asserts the release record AND a notification record):
#   happy       adopted legacy pod → release R2 (bundle installed, verified)
#   canary      R1 → R2, new image fails health  → previous digests, NO DB restore
#   migrate     R1 → R2, backend-migrate throws  → dump restored + previous digests
#   prod        R1 → R2, canary ok, prod fails   → rollback (dump restored: level moved)
#   restore-bad migrate throws AND pg_restore fails → rollback_failed, dbRestored:false
#   hup         SIGHUP mid-migration             → rolled back like INT/TERM
#   pull        a pull fails                     → nothing changes at all
#   source      --from-source                    → synap-dev/* only, never ghcr
#   traefik     SYNAP_EDGE=traefik               → caddy never touched, every service up
#   eve-unpinned / port80 / skip-edge             → edge refusals + eve pin
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }

D64() { printf "$1%.0s" $(seq 1 64); }
OLD_SHA="$(printf 'a%.0s' $(seq 1 40))"
NEW_SHA="$(printf 'b%.0s' $(seq 1 40))"
KEYS="$(grep -oE '\$\{SYNAP_IMAGE_[A-Z0-9_]+' "$HERE/deploy/docker-compose.yml" | sed 's/^\${//' | sort -u)"
[ "$(echo "$KEYS" | grep -c .)" -ge 8 ] && ok "compose consumes $(echo "$KEYS" | grep -c .) SYNAP_IMAGE_* pins" || bad "compose image keys not derivable: '$KEYS'"

# images_json <digest-char-for-first-party> — every compose key pinned by digest
images_json() {
  local k out="{}" repo d
  for k in $KEYS; do
    repo="$(echo "${k#SYNAP_IMAGE_}" | tr 'A-Z_' 'a-z-')"; d="$(D64 c)"
    case "$k" in SYNAP_IMAGE_BACKEND|SYNAP_IMAGE_POD_ADMIN) repo="ghcr.io/synap-core/$repo"; d="$(D64 "$1")" ;; esac
    out="$(jq -c --arg k "$k" --arg v "$repo@sha256:$d" '. + {($k): $v}' <<<"$out")"
  done
  echo "$out"
}
manifest() { # <id> <sha> <digest-char> <last-migration> [bundle-asset bundle-sha]
  jq -n --arg id "$1" --arg sha "$2" --argjson images "$(images_json "$3")" --arg last "$4" \
    --arg asset "${5:-}" --arg bsha "${6:-}" --arg compose "sha256:$(D64 e)" \
    '{schema:1, id:$id, channel:"fast", gitSha:$sha, createdAt:"2026-10-04T00:00:00Z", images:$images,
      migrations:{last:$last, count:12}, composeSha:$compose, envSchemaVersion:"sha256:x", minFrom:null,
      bundle: (if $asset == "" then null else {asset:$asset, sha256:$bsha} end)}'
}

mkdir -p "$TMP/bin" "$TMP/rel"
# ── fake curl: serves $TMP/rel/<path> for https://rel.test/<path> ──────────────
cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -H|--max-time|--retry) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
src="$FAKE_REL/${url#https://rel.test/}"
[ -f "$src" ] || exit 22
cp "$src" "$out"
C
# ── fake docker ───────────────────────────────────────────────────────────────
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
F="$FAKE"; echo "$*" >> "$F/log"
envget() { grep "^$1=" "$FAKE_ENV" | tail -1 | cut -d= -f2-; }
cur_image() { local v; v="$(envget SYNAP_IMAGE_BACKEND)"; [ -n "$v" ] && echo "$v" || echo "ghcr.io/synap-core/backend:$(envget BACKEND_VERSION)"; }
stamp_of() { case "$1" in *"$NEW_DIGEST"*) [ -n "${FAKE_STAMP_WRONG:-}" ] && echo "$OLD_SHA" || echo "$NEW_SHA";; synap-dev/*) echo "$LOCAL_SHA";; *) echo "$OLD_SHA";; esac; }
is_new() { case "$1" in *"$NEW_DIGEST"*|synap-dev/*) return 0;; esac; return 1; }
case "$*" in
  "compose config --services"*|"compose --profile pod-agent config --services"*)
    printf '%s\n' postgres postgres-backup redis minio typesense kratos-migrate kratos hydra-migrate hydra backend-migrate backend realtime pod-admin caddy; exit 0 ;;
  "compose ps --status running --services"*)
    printf '%s\n' postgres postgres-backup redis minio typesense kratos hydra backend realtime pod-admin; [ -s "$F/caddy_up" ] && echo caddy; exit 0 ;;
  "compose ps -q backend"*) echo be1; exit 0 ;;
  "compose ps -q pod-admin"*) echo pa1; exit 0 ;;
  "compose ps"*postgres*) echo pg1; exit 0 ;;
  "compose ps"*) exit 0 ;;
  "compose run --rm backend-migrate"*)
    if [ -n "${FAKE_HUP_AT_MIGRATE:-}" ]; then echo "$FAKE_NEW_LEVEL" > "$F/level"; kill -HUP "$PPID"; exit 0; fi
    if [ -n "${FAKE_MIGRATE_FAIL:-}" ]; then echo "$FAKE_NEW_LEVEL" > "$F/level"; echo "migration 0012 threw" >&2; exit 1; fi
    echo "$FAKE_NEW_LEVEL" > "$F/level"; exit 0 ;;
  "compose run --rm "*) exit 0 ;;
  "compose --profile canary up -d backend-canary"*) cur_image > "$F/canary_image"; exit 0 ;;
  "compose up -d --force-recreate --remove-orphans backend realtime"*) cur_image > "$F/backend_image"; exit 0 ;;
  "compose"*" up "*)
    case " $* " in *" caddy "*) [ -n "${FAKE_CADDY_FAIL:-}" ] && { echo "Bind for 0.0.0.0:80 failed: port is already allocated" >&2; exit 1; }; echo up > "$F/caddy_up";; esac
    exit 0 ;;
  "compose exec -T postgres psql"*) cat >/dev/null 2>&1; echo 1; exit 0 ;;
  "compose"*) exit 0 ;;
  "exec synap-backend-canary node -e"*)
    [ -n "${FAKE_CANARY_BAD:-}" ] && is_new "$(cat "$F/canary_image")" && exit 1; exit 0 ;;
  "exec be1 node -e"*status/release*)
    printf '{"migrations":{"lastApplied":"%s"},"buildStamp":"%s"}' "$(cut -d'|' -f2 "$F/level")" "$(stamp_of "$(cat "$F/backend_image")")"; exit 0 ;;
  "exec be1 node -e"*)
    [ -n "${FAKE_PROD_BAD:-}" ] && is_new "$(cat "$F/backend_image")" && exit 1; exit 0 ;;
  "exec pg1 psql"*_migrations*) cat "$F/level"; exit 0 ;;
  "exec pg1 psql"*"from pg_database where not datistemplate"*) echo synap; exit 0 ;;
  "exec pg1 psql"*"datname='synap'"*) echo 1; exit 0 ;;
  "exec pg1 psql"*"from users)||"*) echo "1|$(cut -d'|' -f1 "$F/level")|1"; exit 0 ;;  # fingerprint follows the data
  "exec pg1 psql"*) echo 1; exit 0 ;;
  "exec pg1 pg_isready"*) exit 0 ;;
  "exec pg1 pg_dump"*) echo "LEVEL $(cat "$F/level")"; exit 0 ;;
  "exec -i pg1 pg_restore -l"*) cat >/dev/null; exit 0 ;;
  "exec -i pg1 pg_restore"*)
    if [ -n "${FAKE_PG_RESTORE_FAIL:-}" ]; then cat >/dev/null; echo "pg_restore: error: could not execute query" >&2; exit 1; fi
    sed -n 's/^LEVEL //p' > "$F/level"; echo RESTORED >> "$F/restores"; exit 0 ;;
  "inspect -f {{.State.Running}} pg1") echo true; exit 0 ;;
  "inspect -f {{range .Config.Env}}"*) echo "PGDATA=/home/postgres/pgdata/data"; exit 0 ;;
  "inspect -f {{range .Mounts}}"*) echo "/home/postgres/pgdata"; exit 0 ;;
  "inspect -f {{.Image}} "*) echo "sha256:$(printf 'f%.0s' $(seq 1 64))"; exit 0 ;;
  "inspect"*) exit 0 ;;
  "image inspect -f"*) echo "sha256:x"; exit 0 ;;
  "image inspect "*) grep -qxF "${*: -1}" "$F/images" 2>/dev/null; exit $? ;;
  "pull "*)
    ref="${*: -1}"; [ -n "${FAKE_PULL_FAIL:-}" ] && [[ "$ref" == *"$FAKE_PULL_FAIL"* ]] && { echo "manifest unknown" >&2; exit 1; }
    echo "$ref" >> "$F/images"; exit 0 ;;
  "build "*)
    t=""; prev=""; for a in "$@"; do [ "$prev" = -t ] && t="$a"; prev="$a"; done; echo "$t" >> "$F/images"; exit 0 ;;
  "ps --filter publish"*) [ -n "${FAKE_PORT_HOLDER:-}" ] && echo "$FAKE_PORT_HOLDER"; exit 0 ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker" "$TMP/bin/curl"

OLD_LEVEL="11|0011_old.sql"
NEW_LEVEL="12|0012_new.sql"
R1="main-1111111"; R2="main-2222222"
NEW_DIGEST="$(D64 d)"
export NEW_DIGEST OLD_SHA NEW_SHA FAKE_REL="$TMP/rel"

base_env() { # legacy|r1
  printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\nPOSTGRES_PASSWORD=x\nJWT_SECRET=x\nKRATOS_SECRETS_COOKIE=x\nSYNAP_SERVICE_ENCRYPTION_KEY=x\nPROVISIONING_TOKEN=x\nADMIN_BOOTSTRAP_MODE=token\nPUBLIC_URL=https://pod.example.com\nPOD_ADMIN_URL=https://pod-admin.example.com\nPOD_ADMIN_DOMAIN=pod-admin.example.com\n'
  [ "$1" = legacy ] && echo "BACKEND_VERSION=local"
  [ "$1" = r1 ] && { echo "# >>> synap release — managed by \`synap update\`; do not edit by hand >>>"; echo "SYNAP_RELEASE_ID=$R1"; echo "BACKEND_VERSION=$R1"
    jq -r 'to_entries[] | "\(.key)=\(.value)"' <<<"$(images_json a)"; echo "# <<< synap release <<<"; }
  return 0
}

# setup <name> <legacy|r1> — a fresh pod: repo with synap + deploy/, fake state
setup() {
  S="$TMP/$1"; REPO="$S/repo"; DEPLOY="$REPO/deploy"; FAKE="$S/fake"
  mkdir -p "$DEPLOY" "$FAKE"
  cp "$HERE/synap" "$REPO/synap"
  cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$DEPLOY/"
  base_env "$2" > "$DEPLOY/.env"
  echo "$OLD_LEVEL" > "$FAKE/level"
  echo "ghcr.io/synap-core/backend:local" > "$FAKE/backend_image"
  : > "$FAKE/log"; : > "$FAKE/images"
  if [ "$2" = r1 ]; then
    jq -r '.[]' <<<"$(images_json a)" >> "$FAKE/images"
    jq -r '.[]' <<<"$(images_json c)" >> "$FAKE/images"   # third-party already cached
    mkdir -p "$DEPLOY/state"
    manifest "$R1" "$OLD_SHA" a 0011_old.sql > "$DEPLOY/state/current-release.json"
    grep '^SYNAP_IMAGE_BACKEND=' "$DEPLOY/.env" | cut -d= -f2- > "$FAKE/backend_image"
  fi
  cp "$DEPLOY/.env" "$S/env.orig"
  export FAKE FAKE_ENV="$DEPLOY/.env" FAKE_NEW_LEVEL="$NEW_LEVEL" LOCAL_SHA="${LOCAL_SHA:-x}"
}
publish() { # <id> <last-migration> [with-bundle]
  local asset="" bsha=""
  mkdir -p "$TMP/rel/$1"
  if [ "${3:-}" = bundle ]; then
    local b="$TMP/bundle-$1"; rm -rf "$b"; mkdir -p "$b/deploy"
    cp "$HERE/synap" "$b/synap"; cp "$HERE/deploy/"*.sh "$b/deploy/"
    { cat "$HERE/deploy/docker-compose.yml"; echo "# release-marker $1"; } > "$b/deploy/docker-compose.yml"
    echo "new in $1" > "$b/deploy/added-by-$1.txt"
    asset="synap-deploy-$1.tar.gz"
    tar -czf "$TMP/rel/$1/$asset" -C "$b" .
    bsha="$(shasum -a 256 "$TMP/rel/$1/$asset" 2>/dev/null | cut -d' ' -f1 || sha256sum "$TMP/rel/$1/$asset" | cut -d' ' -f1)"
  fi
  manifest "$1" "$NEW_SHA" d "$2" "$asset" "$bsha" > "$TMP/rel/$1/release.json"
}
run_update() { # <args...>
  ( cd "$S"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_RELEASE_BASE_URL=https://rel.test \
    SYNAP_HEALTH_INTERVAL=0 SYNAP_UPDATE_HEALTH_TRIES=2 SYNAP_UPDATE_MIN_FREE_MB=1 SYNAP_ASSUME_YES=1 \
    SYNAP_UPDATE_NOTIFY_CMD="cat >> '$S/notified'" bash "$REPO/synap" update "$@" ) >"$S/out" 2>&1 </dev/null
}
cur_id()  { jq -r .id "$DEPLOY/state/current-release.json" 2>/dev/null; }
last()    { jq -r ".$1" "$DEPLOY/state/last-update.json" 2>/dev/null; }
envpin()  { grep "^$1=" "$DEPLOY/.env" | tail -1 | cut -d= -f2-; }
notified(){ [ -s "$S/notified" ] && jq -e --arg s "$1" 'select(.status == $s)' "$S/notified" >/dev/null 2>&1; }
restores(){ [ -f "$FAKE/restores" ] && wc -l < "$FAKE/restores" | tr -d ' ' || echo 0; }
show()    { echo "      --- tail of output ---"; tail -15 "$S/out" | sed 's/^/      /'; }

# ── 1. happy path: adopted legacy pod → R2 with a deploy bundle ───────────────
setup happy legacy; publish "$R2" 0012_new.sql bundle
run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && ok "happy: update to $R2 succeeded" || { bad "happy: rc=$rc"; show; }
[ "$(cur_id)" = "$R2" ] && ok "happy: current-release is $R2" || bad "happy: current-release=$(cur_id)"
[ "$(jq -r .id "$DEPLOY/state/previous-release.json" 2>/dev/null)" = "adopted-ffffffffffff" ] \
  && ok "happy: the legacy pod was adopted as the previous release" || bad "happy: previous-release=$(cat "$DEPLOY/state/previous-release.json" 2>/dev/null)"
grep -q "^tag sha256:f* synap-adopted/backend:ffffffffffff" "$FAKE/log" && ok "happy: the running image is kept as synap-adopted/backend" || bad "happy: adopted image not tagged"
[ "$(envpin SYNAP_IMAGE_BACKEND)" = "ghcr.io/synap-core/backend@sha256:$NEW_DIGEST" ] && [ "$(envpin BACKEND_VERSION)" = "$R2" ] \
  && ok "happy: .env pins the release's backend digest + id" || bad "happy: .env pins: $(grep -E 'SYNAP_IMAGE_BACKEND|BACKEND_VERSION' "$DEPLOY/.env")"
[ "$(grep -c '^BACKEND_VERSION=' "$DEPLOY/.env")" = 1 ] && ok "happy: one BACKEND_VERSION line (legacy line replaced)" || bad "happy: duplicate BACKEND_VERSION"
grep -q "release-marker $R2" "$DEPLOY/docker-compose.yml" && [ -f "$DEPLOY/added-by-$R2.txt" ] && ok "happy: the release's deploy bundle was installed" || bad "happy: bundle not installed"
ls -d "$DEPLOY"/backups/postgres/*-pre-update >/dev/null 2>&1 && ok "happy: verified pre-update dump taken" || bad "happy: no pre-update dump"
b=$(grep -n "pg_dump" "$FAKE/log" | head -1 | cut -d: -f1); m=$(grep -n "run --rm backend-migrate" "$FAKE/log" | head -1 | cut -d: -f1)
p=$(grep -n "^pull " "$FAKE/log" | tail -1 | cut -d: -f1)
[ -n "$p" ] && [ -n "$b" ] && [ -n "$m" ] && [ "$p" -lt "$b" ] && [ "$b" -lt "$m" ] && ok "happy: order is pull → backup → migrate" || bad "happy: order pull=$p backup=$b migrate=$m"
grep -q "pull .*@sha256:$NEW_DIGEST" "$FAKE/log" && ! grep -qE "^pull [^@]*$" "$FAKE/log" && ok "happy: every pull is by digest" || bad "happy: a pull was not by digest: $(grep '^pull' "$FAKE/log")"
[ "$(last status)" = succeeded ] && notified succeeded && ok "happy: success recorded + notified" || bad "happy: record=$(last status)"
grep -q '^SYNAP_EVENT {' "$S/out" && ok "happy: SYNAP_EVENT line emitted" || bad "happy: no SYNAP_EVENT line"
[ "$(restores)" = 0 ] && ok "happy: no DB restore" || bad "happy: DB restored on success"

# second run on the same release is a no-op
: > "$FAKE/log"; run_update --release "$R2"
grep -q "Already on release $R2" "$S/out" && ! grep -q "run --rm" "$FAKE/log" && ok "happy: re-running the same release is a no-op" || { bad "happy: same-release re-run did work"; show; }

# ── 2. image fails health (canary) → previous digests, NO DB restore ─────────
setup canary r1; publish "$R2" 0011_old.sql bundle
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_CANARY_BAD=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && ok "canary: failed update exits non-zero" || bad "canary: rc=0"
[ "$(cur_id)" = "$R1" ] && ok "canary: current-release is back to $R1" || bad "canary: current-release=$(cur_id)"
cmp -s "$DEPLOY/.env" "$S/env.orig" && ok "canary: .env restored byte-identical (previous digests)" || bad "canary: .env differs: $(diff "$S/env.orig" "$DEPLOY/.env" | head -4)"
[ "$(cat "$FAKE/backend_image")" = "$(grep '^SYNAP_IMAGE_BACKEND=' "$S/env.orig" | cut -d= -f2-)" ] && ok "canary: backend runs the previous digest" || bad "canary: backend runs $(cat "$FAKE/backend_image")"
[ "$(restores)" = 0 ] && [ "$(last dbRestored)" = false ] && ok "canary: no DB restore (migration level unchanged)" || bad "canary: restores=$(restores) dbRestored=$(last dbRestored)"
! grep -q "release-marker" "$DEPLOY/docker-compose.yml" && [ ! -e "$DEPLOY/added-by-$R2.txt" ] && ok "canary: deploy files restored, bundle-added file removed" || bad "canary: bundle not rolled back"
[ "$(last status)" = rolled_back ] && notified rolled_back && ok "canary: rollback recorded + notified" || { bad "canary: record=$(last status)"; show; }

# ── 3. migration throws → dump restored + previous digests ───────────────────
setup migrate r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && ok "migrate: failed update exits non-zero" || bad "migrate: rc=0"
[ "$(restores)" = 1 ] && [ "$(cat "$FAKE/level")" = "$OLD_LEVEL" ] && ok "migrate: DB restored from the pre-update dump (level back to $OLD_LEVEL)" || bad "migrate: restores=$(restores) level=$(cat "$FAKE/level")"
s=$(grep -n "compose stop" "$FAKE/log" | head -1 | cut -d: -f1); r=$(grep -n "pg_restore -U" "$FAKE/log" | head -1 | cut -d: -f1)
[ -n "$s" ] && [ -n "$r" ] && [ "$s" -lt "$r" ] && ok "migrate: writers stopped (maintenance) before the restore" || bad "migrate: stop=$s restore=$r"
cmp -s "$DEPLOY/.env" "$S/env.orig" && [ "$(cur_id)" = "$R1" ] && ok "migrate: previous digests + current-release $R1" || bad "migrate: env/current-release not restored ($(cur_id))"
[ "$(last status)" = rolled_back ] && [ "$(last dbRestored)" = true ] && notified rolled_back && ok "migrate: rollback with DB restore recorded + notified" || { bad "migrate: record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
grep -q "profile canary up" "$FAKE/log" && bad "migrate: the canary ran after a failed migration" || ok "migrate: no canary / swap after the throw"

# ── 3b. migration throws AND the restore fails → never claims dbRestored ─────
# pgdata_restore only warns on a pg_restore error; the fingerprint recorded
# with the dump is what tells the rollback the data did not come back.
setup restorebad r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 FAKE_PG_RESTORE_FAIL=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rollback_failed ] && [ "$(last dbRestored)" = false ] && notified rollback_failed \
  && ok "restore-bad: a failed pg_restore records rollback_failed, dbRestored:false" || { bad "restore-bad: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
grep -q "did not bring the data back" "$S/out" && grep -q "ROLLBACK INCOMPLETE" "$S/out" \
  && ok "restore-bad: the operator is told the data did not come back" || { bad "restore-bad: no fingerprint-mismatch message"; show; }
grep -q "database restored" "$S/out" && bad "restore-bad: output still claims the database was restored" || ok "restore-bad: no 'database restored' claim"

# ── 3c. SIGHUP (ssh drop) mid-update → rolled back like INT/TERM ─────────────
setup hup r1; publish "$R2" 0012_new.sql
FAKE_HUP_AT_MIGRATE=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && [ "$(last reason)" = interrupted ] && [ "$(last dbRestored)" = true ] \
  && [ "$(cat "$FAKE/level")" = "$OLD_LEVEL" ] && cmp -s "$DEPLOY/.env" "$S/env.orig" \
  && ok "hup: SIGHUP mid-migration rolls back (dump restored, previous digests)" || { bad "hup: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null) level=$(cat "$FAKE/level")"; show; }

# ── 4. canary passes, production fails → rollback ────────────────────────────
setup prod r1; publish "$R2" 0012_new.sql
FAKE_PROD_BAD=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && ok "prod: failed update exits non-zero" || bad "prod: rc=0"
grep -q "compose --profile canary up -d backend-canary" "$FAKE/log" && ok "prod: the canary ran (and passed)" || bad "prod: no canary"
[ "$(cur_id)" = "$R1" ] && cmp -s "$DEPLOY/.env" "$S/env.orig" && [ "$(cat "$FAKE/backend_image")" != "ghcr.io/synap-core/backend@sha256:$NEW_DIGEST" ] \
  && ok "prod: back on $R1's digests" || bad "prod: current=$(cur_id) backend=$(cat "$FAKE/backend_image")"
[ "$(restores)" = 1 ] && [ "$(cat "$FAKE/level")" = "$OLD_LEVEL" ] && ok "prod: level had moved → dump restored" || bad "prod: restores=$(restores)"
[ "$(last status)" = rolled_back ] && notified rolled_back && ok "prod: rollback recorded + notified" || { bad "prod: record=$(last status)"; show; }

# ── 4b. healthy, but not the release's build (buildStamp mismatch) → rollback ─
setup verify r1; publish "$R2" 0011_old.sql
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_STAMP_WRONG=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && grep -q "buildStamp mismatch" "$S/out" && [ "$(cur_id)" = "$R1" ] && cmp -s "$DEPLOY/.env" "$S/env.orig" \
  && [ "$(last status)" = rolled_back ] && [ "$(last reason)" = "post-update verification failed" ] \
  && ok "verify: a buildStamp that is not the release's gitSha rolls back" || { bad "verify: rc=$rc record=$(last status)/$(last reason)"; show; }

# ── 5. pull failure changes nothing ──────────────────────────────────────────
setup pull r1; publish "$R2" 0012_new.sql bundle
cp "$DEPLOY/docker-compose.yml" "$S/compose.orig"
FAKE_PULL_FAIL="$NEW_DIGEST" run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && ok "pull: exits non-zero" || bad "pull: rc=0"
cmp -s "$DEPLOY/.env" "$S/env.orig" && cmp -s "$DEPLOY/docker-compose.yml" "$S/compose.orig" && ok "pull: .env and deploy files untouched" || bad "pull: files changed"
grep -E "compose (run|stop|.* up )|compose up|pg_dump" "$FAKE/log" && bad "pull: something ran after the failed pull" || ok "pull: no compose up/run/stop, no dump"
[ "$(cur_id)" = "$R1" ] && [ "$(last status)" = aborted ] && notified aborted && ok "pull: release unchanged, abort recorded + notified" || bad "pull: current=$(cur_id) record=$(last status)"

# ── 6. --from-source: synap-dev/* only, never the ghcr name ─────────────────
setup source r1
mkdir -p "$REPO/apps/pod-admin" "$REPO/packages/database/migrations"
cp "$HERE/deploy/Dockerfile" "$DEPLOY/Dockerfile"; echo "FROM scratch" > "$REPO/apps/pod-admin/Dockerfile"
: > "$REPO/packages/database/migrations/0011_old.sql"; : > "$REPO/packages/database/migrations/0012_new.sql"
( cd "$REPO" && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm fixture ) || bad "source: git fixture"
LOCAL_SHA="$(git -C "$REPO" rev-parse HEAD)"; export LOCAL_SHA
SYNAP_SKIP_GIT_SYNC=1 run_update --from-source; rc=$?
tag12="${LOCAL_SHA:0:12}"
[ "$rc" = 0 ] && ok "source: from-source update succeeded" || { bad "source: rc=$rc"; show; }
builds="$(grep '^build ' "$FAKE/log")"
[ "$(echo "$builds" | grep -c .)" = 2 ] && ok "source: two images built" || bad "source: builds: $builds"
echo "$builds" | grep -q ghcr && bad "source: a build mentions ghcr: $builds" || ok "source: no build is tagged with the ghcr name"
echo "$builds" | grep -q -- "-t synap-dev/backend:$tag12 " && echo "$builds" | grep -q -- "-t synap-dev/pod-admin:$tag12 " && ok "source: tags are synap-dev/*:$tag12" || bad "source: tags: $builds"
grep -qE "^(compose build|tag .* ghcr)" "$FAKE/log" && bad "source: compose build / ghcr retag used" || ok "source: no compose build, no ghcr retag"
[ "$(envpin SYNAP_IMAGE_BACKEND)" = "synap-dev/backend:$tag12" ] && [ "$(cur_id)" = "local-$tag12" ] && [ "$(jq -r .source "$DEPLOY/state/current-release.json")" = true ] \
  && ok "source: recorded as release local-$tag12 (source:true)" || bad "source: env=$(envpin SYNAP_IMAGE_BACKEND) id=$(cur_id)"
[ "$(envpin SYNAP_IMAGE_MINIO)" = "$(grep '^SYNAP_IMAGE_MINIO=' "$S/env.orig" | cut -d= -f2-)" ] && ok "source: third-party pins carried over from the previous release" || bad "source: minio pin lost"
ls -d "$DEPLOY"/backups/postgres/*-pre-update >/dev/null 2>&1 && grep -q "canary" "$FAKE/log" && ok "source: same backup + canary path as a release" || bad "source: skipped backup/canary"

# ── 7. edge=traefik: caddy never touched, every other service comes up ───────
setup traefik r1; publish "$R2" 0012_new.sql
echo "SYNAP_EDGE=traefik" >> "$DEPLOY/.env"; cp "$DEPLOY/.env" "$S/env.orig"
FAKE_CADDY_FAIL=1 run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && ok "traefik: update completed" || { bad "traefik: rc=$rc"; show; }
grep -E " up .*caddy|caddy .* up" "$FAKE/log" && bad "traefik: caddy was brought up" || ok "traefik: caddy never touched"
swap=$(grep -n "force-recreate --remove-orphans backend realtime" "$FAKE/log" | head -1 | cut -d: -f1)
rest=$(grep -n "up -d --remove-orphans .*redis" "$FAKE/log" | tail -1 | cut -d: -f1)
[ -n "$swap" ] && [ -n "$rest" ] && [ "$rest" -gt "$swap" ] && ok "traefik: the other services come up after the swap" || bad "traefik: swap=$swap rest=$rest"
for svc in postgres redis minio typesense kratos hydra pod-admin postgres-backup; do
  sed -n "${rest:-0}p" "$FAKE/log" | grep -qw -- "$svc" || bad "traefik: $svc missing from the post-swap bring-up"
done
grep -q "up -d --force-recreate kratos" "$FAKE/log" && grep -q "up -d --force-recreate pod-admin" "$FAKE/log" && ok "traefik: kratos + pod-admin recreated" || bad "traefik: kratos/pod-admin not recreated"
[ "$(cur_id)" = "$R2" ] && [ "$(last status)" = succeeded ] && ok "traefik: release recorded" || bad "traefik: current=$(cur_id)"

# ── 8. edge refusals (nothing changes) + eve's SYNAP_SKIP_EDGE pin ────────────
setup eve r1; publish "$R2" 0012_new.sql
echo "# Marker: eve-managed:synap-loopback-override:v3" > "$DEPLOY/docker-compose.override.yml"
run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && grep -q "SYNAP_EDGE=traefik" "$S/out" && cmp -s "$DEPLOY/.env" "$S/env.orig" && [ -z "$(grep -E '^pull|compose (run|up)' "$FAKE/log")" ] \
  && ok "eve-unpinned: refused with the SYNAP_EDGE hint, nothing changed" || { bad "eve-unpinned: rc=$rc"; show; }
( cd "$S"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_RELEASE_BASE_URL=https://rel.test SYNAP_SKIP_EDGE=1 \
  SYNAP_HEALTH_INTERVAL=0 SYNAP_UPDATE_HEALTH_TRIES=2 SYNAP_UPDATE_MIN_FREE_MB=1 bash "$REPO/synap" update --release "$R2" ) >"$S/out" 2>&1 </dev/null; rc=$?
[ "$rc" = 0 ] && [ "$(grep -c '^SYNAP_EDGE=traefik' "$DEPLOY/.env")" = 1 ] && ! grep -qE " up .*caddy" "$FAKE/log" \
  && ok "skip-edge: eve's SYNAP_SKIP_EDGE=1 pins SYNAP_EDGE=traefik once and skips caddy" || { bad "skip-edge: rc=$rc"; show; }

setup port80 r1; publish "$R2" 0012_new.sql
FAKE_PORT_HOLDER="eve-legs-traefik||" run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && grep -q "eve-legs-traefik" "$S/out" && cmp -s "$DEPLOY/.env" "$S/env.orig" && [ -z "$(grep -E '^pull|compose (run|up)' "$FAKE/log")" ] \
  && ok "port80: edge=caddy with :80 held elsewhere is refused before anything changes" || { bad "port80: rc=$rc"; show; }

# ── 9. an invalid manifest is refused before anything changes ────────────────
setup invalid r1; publish "$R2" 0012_new.sql
jq '.images.SYNAP_IMAGE_REDIS = "redis:7-alpine"' "$TMP/rel/$R2/release.json" > "$TMP/x" && mv "$TMP/x" "$TMP/rel/$R2/release.json"
run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && grep -q "SYNAP_IMAGE_REDIS is not pinned by digest" "$S/out" && cmp -s "$DEPLOY/.env" "$S/env.orig" \
  && ok "invalid: an unpinned image refuses the manifest, nothing changed" || { bad "invalid: rc=$rc"; show; }

# ── 10. channels resolve through channel-<name>/release.json ──────────────────
setup channel r1; publish "$R2" 0012_new.sql
mkdir -p "$TMP/rel/channel-fast"; cp "$TMP/rel/$R2/release.json" "$TMP/rel/channel-fast/release.json"
echo "SYNAP_UPDATE_CHANNEL=fast" >> "$DEPLOY/.env"
run_update; rc=$?
[ "$rc" = 0 ] && [ "$(cur_id)" = "$R2" ] && ok "channel: bare \`synap update\` follows SYNAP_UPDATE_CHANNEL=fast" || { bad "channel: rc=$rc current=$(cur_id)"; show; }

exit $fail
