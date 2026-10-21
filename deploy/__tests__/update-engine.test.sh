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
#   canary      R1 → R2, new image fails health  → previous digests, schema unchanged
#   migrate     R1 → R2, backend-migrate throws  → previous digests, data KEPT migrated,
#                                                  the dump + `synap restore` command offered
#   restore-*   the operator's `synap restore <dump>`: confirm, fresh-db restore,
#               failed/drifted/full/unreadable/locked restores change nothing
#   prod        R1 → R2, canary ok, prod fails   → rollback, schema stays migrated
#   hup         SIGHUP mid-migration             → rolled back like INT/TERM
#   ledger*     unreadable ledger → refused before anything; lost after → schema:unknown
#   minfrom*    minFrom compares the newest migration by NAME (byte order), of the
#               database AND of the running release; the refusal names minFromRelease
#   pull        a pull fails                     → nothing changes at all
#   source      --from-source                    → synap-dev/* only, never ghcr
#   traefik     SYNAP_EDGE=traefik               → caddy never touched, every service up
#   eve-unpinned / port80 / skip-edge             → edge refusals + eve pin
#   kprefer/kgood  rollback kratos.yml: valid .before wins; a broken one → kratos.yml.good (W6-HEAL N5)
#   kratosdown  rollback, Kratos never ready     → rollback_failed (N1)
#   unhealthy/starting  Docker health not healthy after the swap → rollback (N2);
#   slowstart/unhealthybefore  long start_period / already unhealthy → warned, not rolled back
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
    [ "$k" = SYNAP_IMAGE_POSTGRES ] && [ -n "${PG_DIGEST:-}" ] && d="$(D64 "$PG_DIGEST")"   # a release that moves postgres
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
# Edge probes (…/health through 127.0.0.1): FAKE_EDGE=down → nothing answers,
# http-only → only :80 answers (a tunnelled pod); default → https answers.
cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
out=""; url=""; w=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -w) w="$2"; shift 2;; -H|--max-time|--retry|--resolve) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
case "$url" in */health)
  [ -n "${FAKE:-}" ] && echo "edge $url" >> "$FAKE/curl_edge"
  code=200
  case "${FAKE_EDGE:-ok}" in down) code=000 ;; http-only) case "$url" in https:*) code=000 ;; esac ;; esac
  [ -n "$w" ] && printf '%s' "$code"; [ "$code" = 200 ]; exit $? ;;
esac
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
    printf '%s\n' postgres postgres-backup redis minio typesense kratos-migrate kratos backend-migrate backend realtime pod-admin caddy; exit 0 ;;
  "compose ps --status running --services"*)
    printf '%s\n' postgres postgres-backup redis minio typesense kratos backend realtime pod-admin; [ -s "$F/caddy_up" ] && echo caddy; exit 0 ;;
  "compose ps -q backend"*) echo be1; exit 0 ;;
  "compose ps -q caddy"*) [ -s "$F/caddy_up" ] && echo caddy1; exit 0 ;;
  "exec caddy1 sha256sum /etc/caddy/Caddyfile") printf '%s  /etc/caddy/Caddyfile\n' "$(cat "$F/caddy_loaded" 2>/dev/null)"; exit 0 ;;
  "compose run --rm --no-deps caddy caddy validate"*)
    [ -n "${FAKE_CADDY_INVALID:-}" ] && { echo "Error: adapting config using caddyfile: unrecognized directive: reverse_prox" >&2; exit 1; }; exit 0 ;;
  "compose ps -q pod-admin"*) echo pa1; exit 0 ;;
  "compose ps"*postgres*) echo pg1; exit 0 ;;
  "compose ps -q") [ -n "${FAKE_HEALTH:-}" ] && printf '%s\n' c-backend c-kratos c-postgres-backup; exit 0 ;;
  "compose ps"*) exit 0 ;;
  "compose run --rm backend-migrate"*)
    : > "$F/migrated"
    if [ -n "${FAKE_HUP_AT_MIGRATE:-}" ]; then echo "$FAKE_NEW_LEVEL" > "$F/level"; kill -HUP "$PPID"; exit 0; fi
    if [ -n "${FAKE_MIGRATE_FAIL:-}" ]; then echo "$FAKE_NEW_LEVEL" > "$F/level"; echo "migration 0012 threw" >&2; exit 1; fi
    echo "$FAKE_NEW_LEVEL" > "$F/level"; exit 0 ;;
  "compose run --rm "*) exit 0 ;;
  "compose --profile canary up -d backend-canary"*) cur_image > "$F/canary_image"; exit 0 ;;
  "compose up -d --force-recreate --remove-orphans backend realtime"*) cur_image > "$F/backend_image"; exit 0 ;;
  "compose"*" up "*)
    # caddy (re)creation, the way Compose does it: a new container mounts the
    # Caddyfile on disk now; a plain `up` recreates only when the service's
    # definition changed (modelled as: docker-compose.yml changed).
    case " $* " in *" caddy "*)
      [ -n "${FAKE_CADDY_FAIL:-}" ] && { echo "Bind for 0.0.0.0:80 failed: port is already allocated" >&2; exit 1; }
      dd="$(dirname "$FAKE_ENV")"; cs="$(cksum < "$dd/docker-compose.yml")"
      if [ ! -s "$F/caddy_up" ] || [[ " $* " == *" --force-recreate "* ]] || [ "$cs" != "$(cat "$F/caddy_def" 2>/dev/null)" ]; then
        echo up > "$F/caddy_up"; echo "$cs" > "$F/caddy_def"; echo create >> "$F/caddy_creates"
        cf="$(grep '^CADDYFILE_PATH=' "$FAKE_ENV" | tail -1 | cut -d= -f2-)"; cf="${cf:-$dd/Caddyfile}"
        { shasum -a 256 "$cf" 2>/dev/null || sha256sum "$cf"; } | cut -d' ' -f1 > "$F/caddy_loaded"
      fi;;
    esac
    exit 0 ;;
  "compose exec -T postgres psql"*) cat >/dev/null 2>&1; echo 1; exit 0 ;;
  "compose exec -T kratos wget"*) [ -n "${FAKE_KRATOS_DOWN:-}" ] && exit 1; exit 0 ;;
  "compose stop"*|"compose"*" stop "*) echo armed > "$F/restores_armed"; exit 0 ;;
  "compose"*) exit 0 ;;
  "exec synap-backend-canary node -e"*)
    [ -n "${FAKE_CANARY_BAD:-}" ] && is_new "$(cat "$F/canary_image")" && exit 1; exit 0 ;;
  "exec be1 node -e"*status/release*)
    printf '{"migrations":{"lastApplied":"%s"},"buildStamp":"%s"}' "$(cut -d'|' -f2 "$F/level")" "$(stamp_of "$(cat "$F/backend_image")")"; exit 0 ;;
  "exec be1 node -e"*)
    [ -n "${FAKE_PROD_BAD:-}" ] && is_new "$(cat "$F/backend_image")" && exit 1; exit 0 ;;
  "exec pg1 psql"*pg_encoding_to_char*) echo "UTF8|C.UTF-8|C.UTF-8"; exit 0 ;;
  "exec pg1 psql"*"pg_database_size"*) case "$*" in *::bigint*) echo 100 ;; *) echo 21422.701171875000 ;; esac; exit 0 ;;  # numeric unless cast, as postgres answers
  # The synap _migrations ledger. $F/level is the newest BY NAME; a ledger
  # where a late-merged migration was applied last also has $F/level_by_time.
  # Only the two query shapes are modelled; any other ledger query is refused,
  # so a reader that changes its SQL cannot pass on a canned answer.
  # FAKE_LEDGER_FAIL=1 → every ledger read fails; =after-migrate → only once
  # backend-migrate ran.
  "exec pg1 psql"*_migrations*)
    case "${FAKE_LEDGER_FAIL:-}" in 1) echo "psql: connection refused" >&2; exit 2 ;;
      after-migrate) [ -e "$F/migrated" ] && { echo "psql: connection refused" >&2; exit 2; } ;; esac
    case "$*" in
      *"to_regclass('public._migrations')"*) [ -n "${FAKE_NO_LEDGER:-}" ] && echo f || echo t ;;
      *'max(filename collate "C")'*) [ -n "${FAKE_NO_LEDGER:-}" ] && { echo 'ERROR: relation "_migrations" does not exist' >&2; exit 1; }; cat "$F/level" ;;
      *"order by applied_at desc"*) cat "$F/level_by_time" 2>/dev/null || cat "$F/level" ;;
      *) echo "fake psql: unmodelled ledger query: $*" >&2; exit 1 ;;
    esac; exit 0 ;;
  "exec pg1 psql"*"from pg_database where not datistemplate"*) echo synap; exit 0 ;;
  "exec pg1 psql"*"where datallowconn and not datistemplate"*) printf '%s\n' postgres synap; exit 0 ;;
  "exec pg1 psql -U synap -d synap "*"extname = 'timescaledb'"*)
    [ -n "${FAKE_TSDB_READ_FAIL:-}" ] && { echo "psql: connection refused" >&2; exit 2; }
    echo "${FAKE_TSDB_EXT:-2.26.4}"; exit 0 ;;
  "exec pg1 psql"*"extname = 'timescaledb'"*) exit 0 ;;   # no extension in the other databases
  # A model of the cluster's database list ($F/dbs), so a restore that renames
  # the live database aside and creates a fresh one is observable.
  "exec pg1 psql"*"from pg_database where datname="*)
    [ -f "$F/dbs" ] || echo synap > "$F/dbs"
    n="$(sed -n "s/.*datname='\([^']*\)'.*/\1/p" <<<"$*")"
    [ -n "${FAKE_DB_STATE_FAIL:-}" ] && [ "$n" = "$FAKE_DB_STATE_FAIL" ] && [ -s "$F/restores_armed" ] && { echo "connection lost" >&2; exit 2; }
    grep -qx "$n" "$F/dbs" && echo 1 || echo 0; exit 0 ;;
  "exec pg1 psql"*"alter database "*" rename to "*)
    [ -f "$F/dbs" ] || echo synap > "$F/dbs"
    a="$(sed -n 's/.*alter database "\([^"]*\)" rename to.*/\1/p' <<<"$*")"; b="$(sed -n 's/.*rename to "\([^"]*\)".*/\1/p' <<<"$*")"
    grep -qx "$a" "$F/dbs" || exit 1
    { grep -vx "$a" "$F/dbs"; echo "$b"; } > "$F/dbs.n"; mv "$F/dbs.n" "$F/dbs"; exit 0 ;;
  "exec pg1 psql"*"create database "*)
    n="$(sed -n 's/.*create database "\([^"]*\)".*/\1/p' <<<"$*")"; grep -qx "$n" "$F/dbs" 2>/dev/null && exit 1; echo "$n" >> "$F/dbs"; exit 0 ;;
  "exec pg1 psql"*"drop database "*)
    n="$(sed -n 's/.*drop database \(if exists \)\{0,1\}"\([^"]*\)".*/\2/p' <<<"$*")"; grep -vx "$n" "$F/dbs" > "$F/dbs.n"; mv "$F/dbs.n" "$F/dbs"; exit 0 ;;
  "exec pg1 psql"*pg_terminate_backend*) exit 0 ;;
  "exec pg1 df "*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 %s 1%% /\n' "${FAKE_PG_FREE_KB:-999999}"; exit 0 ;;
  "exec pg1 psql"*"from users)||"*)  # fingerprint follows the data
    if [ -n "${FAKE_FP_DRIFT:-}" ] && [ -s "$F/restores" ]; then echo "1|999|1"; else echo "1|$(cut -d'|' -f1 "$F/level")|1"; fi; exit 0 ;;
  "exec pg1 psql"*) echo 1; exit 0 ;;
  "exec pg1 pg_isready"*) exit 0 ;;
  "exec pg1 pg_dump"*) echo "LEVEL $(cat "$F/level")"; exit 0 ;;
  "exec -i pg1 pg_restore -l"*) cat >/dev/null; exit 0 ;;
  "exec -i pg1 pg_restore"*)
    if [ -n "${FAKE_PG_RESTORE_FAIL:-}" ]; then cat >/dev/null; echo "pg_restore: error: could not execute query" >&2; exit 1; fi
    sed -n 's/^LEVEL //p' > "$F/level"; echo RESTORED >> "$F/restores"; exit 0 ;;
  "inspect -f {{index .Config.Labels"*)
    # FAKE_HEALTH="<svc>=<health>[:<startPeriodNs>] ..." while the NEW release
    # runs (FAKE_HEALTH_ALWAYS=1: before the update too); healthy otherwise.
    for svc in backend kratos postgres-backup; do
      st=healthy; sp=0
      if [ -n "${FAKE_HEALTH_ALWAYS:-}" ] || is_new "$(cat "$F/backend_image")"; then
        for kv in $FAKE_HEALTH; do [ "${kv%%=*}" = "$svc" ] && { v="${kv#*=}"; st="${v%%:*}"; [ "$v" != "$st" ] && sp="${v#*:}"; }; done
      fi
      echo "$svc $st $sp"
    done; exit 0 ;;
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
    t=""; prev=""; for a in "$@"; do [ "$prev" = -t ] && t="$a"; prev="$a"; done
    [ -n "${FAKE_BUILD_FAIL:-}" ] && { echo "build failed (injected)" >&2; exit 1; }
    echo "$t" >> "$F/images"; exit 0 ;;
  "run --rm --entrypoint sh "*" -c ls /usr/lib/postgresql/*/lib/")
    # the postgres image's TimescaleDB libraries: FAKE_TSDB_LIBS_NEW for a
    # release's moved postgres image (PG_DIGEST=b), FAKE_TSDB_LIBS otherwise
    libs="${FAKE_TSDB_LIBS:-2.26.4}"; case "$*" in *"@sha256:$(printf 'b%.0s' $(seq 1 64))"*) libs="${FAKE_TSDB_LIBS_NEW:-$libs}" ;; esac
    echo plpgsql.so; for v in $libs; do echo "timescaledb-$v.so"; done; echo timescaledb.so; exit 0 ;;
  "exec pg1 sh -c ls /usr/lib/postgresql/*/lib/")   # the running postgres: the image .env pins
    libs="${FAKE_TSDB_LIBS:-2.26.4}"; grep -q "^SYNAP_IMAGE_POSTGRES=.*@sha256:$(printf 'b%.0s' $(seq 1 64))" "$FAKE_ENV" && libs="${FAKE_TSDB_LIBS_NEW:-$libs}"
    for v in $libs; do echo "timescaledb-$v.so"; done; exit 0 ;;
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
  cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/Caddyfile" "$DEPLOY/"
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
    # caddy runs, created from this compose file and this Caddyfile
    echo up > "$FAKE/caddy_up"; cksum < "$DEPLOY/docker-compose.yml" > "$FAKE/caddy_def"
    { shasum -a 256 "$DEPLOY/Caddyfile" 2>/dev/null || sha256sum "$DEPLOY/Caddyfile"; } | cut -d' ' -f1 > "$FAKE/caddy_loaded"
  fi
  cp "$DEPLOY/.env" "$S/env.orig"
  export FAKE FAKE_ENV="$DEPLOY/.env" FAKE_NEW_LEVEL="$NEW_LEVEL" LOCAL_SHA="${LOCAL_SHA:-x}"
}
# bundle = new compose AND a new Caddyfile; bundle-caddy = only the Caddyfile
# changes; bundle-same = neither does.
publish() { # <id> <last-migration> [bundle|bundle-caddy|bundle-same]
  local asset="" bsha=""
  mkdir -p "$TMP/rel/$1"
  if [ -n "${3:-}" ]; then
    local b="$TMP/bundle-$1"; rm -rf "$b"; mkdir -p "$b/deploy"
    cp "$HERE/synap" "$b/synap"; cp "$HERE/deploy/"*.sh "$HERE/deploy/Caddyfile" "$HERE/deploy/docker-compose.yml" "$b/deploy/"
    cp -R "$HERE/deploy/systemd" "$b/deploy/systemd"
    # PUBLISH_MARK_ENGINE=1: the release's engine marks the step that installs
    # its own files, so a test can see WHICH engine ran the post-bundle steps.
    if [ -n "${PUBLISH_MARK_ENGINE:-}" ]; then
      awk '{print} /^_ue_install_bundle\(\) \{$/{print "    echo \"engine=$0 handoff=${SYNAP_UE_HANDOFF:-} pid=$$\" >> \"$FAKE/engine_marks\""}' "$HERE/synap" > "$b/synap"
      grep -q 'engine_marks' "$b/synap" || { echo "FAIL - could not mark the release engine"; exit 1; }
    fi
    [ "$3" = bundle ] && echo "# release-marker $1" >> "$b/deploy/docker-compose.yml"
    [ "$3" != bundle-same ] && echo "# caddy-marker $1" >> "$b/deploy/Caddyfile"
    echo "new in $1" > "$b/deploy/added-by-$1.txt"
    asset="synap-deploy-$1.tar.gz"
    tar -czf "$TMP/rel/$1/$asset" -C "$b" .
    bsha="$(shasum -a 256 "$TMP/rel/$1/$asset" 2>/dev/null | cut -d' ' -f1 || sha256sum "$TMP/rel/$1/$asset" | cut -d' ' -f1)"
  fi
  manifest "$1" "$NEW_SHA" d "$2" "$asset" "$bsha" > "$TMP/rel/$1/release.json"
}
run_update() { # <args...>
  ( cd "$S"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_RELEASE_BASE_URL=https://rel.test \
    SYNAP_HEALTH_INTERVAL=0 SYNAP_UPDATE_HEALTH_TRIES=2 SYNAP_UPDATE_MIN_FREE_MB=1 SYNAP_UPDATE_MIN_FREE_SOURCE_MB=1 SYNAP_ASSUME_YES=1 \
    SYNAP_UPDATE_HEALTHY_WAIT=0 SYNAP_UPDATE_HEALTHY_INTERVAL=0 SYNAP_KRATOS_READY_TRIES=2 SYNAP_KRATOS_READY_INTERVAL=0 \
    SYNAP_UPDATE_EDGE_TRIES=2 SYNAP_UPDATE_EDGE_INTERVAL=0 \
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
mkdir -p "$REPO/kratos"   # generate_kratos_config renders only into an existing dir
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
grep -q "caddy-marker $R2" "$DEPLOY/Caddyfile" && [ "$(cat "$FAKE/caddy_loaded")" = "$(shasum -a 256 "$DEPLOY/Caddyfile" | cut -d' ' -f1)" ] \
  && ok "happy: caddy serves the release's Caddyfile" || bad "happy: caddy does not serve the release's Caddyfile"
grep -q "edge https://pod.example.com/health" "$FAKE/curl_edge" 2>/dev/null && ok "happy: verified through the edge (https on 127.0.0.1:443)" || bad "happy: no edge probe"
ls -d "$DEPLOY"/backups/postgres/*-pre-update >/dev/null 2>&1 && ok "happy: verified pre-update dump taken" || bad "happy: no pre-update dump"
b=$(grep -n "pg_dump" "$FAKE/log" | head -1 | cut -d: -f1); m=$(grep -n "run --rm backend-migrate" "$FAKE/log" | head -1 | cut -d: -f1)
p=$(grep -n "^pull " "$FAKE/log" | tail -1 | cut -d: -f1)
[ -n "$p" ] && [ -n "$b" ] && [ -n "$m" ] && [ "$p" -lt "$b" ] && [ "$b" -lt "$m" ] && ok "happy: order is pull → backup → migrate" || bad "happy: order pull=$p backup=$b migrate=$m"
grep -q "pull .*@sha256:$NEW_DIGEST" "$FAKE/log" && ! grep -qE "^pull [^@]*$" "$FAKE/log" && ok "happy: every pull is by digest" || bad "happy: a pull was not by digest: $(grep '^pull' "$FAKE/log")"
[ "$(last status)" = succeeded ] && notified succeeded && ok "happy: success recorded + notified" || bad "happy: record=$(last status)"
grep -q '^SYNAP_EVENT {' "$S/out" && ok "happy: SYNAP_EVENT line emitted" || bad "happy: no SYNAP_EVENT line"
[ "$(restores)" = 0 ] && ok "happy: no DB restore" || bad "happy: DB restored on success"
[ -s "$REPO/kratos/kratos.yml.good" ] && cmp -s "$REPO/kratos/kratos.yml" "$REPO/kratos/kratos.yml.good" \
  && ok "happy: the verified kratos.yml is kept as kratos.yml.good" || bad "happy: no kratos.yml.good after a verified update"

# second run on the same release is a no-op
: > "$FAKE/log"; run_update --release "$R2"
grep -q "Already on release $R2" "$S/out" && ! grep -q "run --rm" "$FAKE/log" && ok "happy: re-running the same release is a no-op" || { bad "happy: same-release re-run did work"; show; }
[ "$(last status)" = noop ] && [ "$(last to)" = "$R2" ] && notified noop \
  && ok "happy: the no-op is RECORDED (status noop), so a waiting pod-agent hears back" || bad "happy: no-op not recorded: $(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"

# ── 1b. caddy: recreated only when its loaded Caddyfile differs, validated
#        first, verified through the edge (review should-fix 3) ───────────────
creates() { [ -f "$FAKE/caddy_creates" ] && wc -l < "$FAKE/caddy_creates" | tr -d ' ' || echo 0; }
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1 || sha256sum "$1" | cut -d' ' -f1; }
setup caddyonly r1; publish "$R2" 0011_old.sql bundle-caddy
FAKE_NEW_LEVEL="$OLD_LEVEL" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && [ "$(creates)" = 1 ] && grep -q "up -d --force-recreate caddy" "$FAKE/log" && [ "$(cat "$FAKE/caddy_loaded")" = "$(sha "$DEPLOY/Caddyfile")" ] \
  && ok "caddyonly: a new Caddyfile alone recreates caddy once, and it serves it" || { bad "caddyonly: rc=$rc creates=$(creates)"; show; }
grep -q "run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile" "$FAKE/log" && ok "caddyonly: the Caddyfile is validated by caddy" || bad "caddyonly: no caddy validate"
v=$(grep -n "caddy caddy validate" "$FAKE/log" | head -1 | cut -d: -f1); m=$(grep -n "run --rm backend-migrate" "$FAKE/log" | head -1 | cut -d: -f1)
[ -n "$v" ] && [ -n "$m" ] && [ "$v" -lt "$m" ] && ok "caddyonly: validated before any migration" || bad "caddyonly: validate=$v migrate=$m"
setup caddyboth r1; publish "$R2" 0011_old.sql bundle
FAKE_NEW_LEVEL="$OLD_LEVEL" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && [ "$(creates)" = 1 ] && ! grep -q "force-recreate caddy" "$FAKE/log" \
  && ok "caddyboth: compose definition + Caddyfile changed → caddy recreated ONCE (by compose), never twice" || { bad "caddyboth: rc=$rc creates=$(creates) forced=$(grep -c 'force-recreate caddy' "$FAKE/log")"; show; }
setup caddysame r1; publish "$R2" 0011_old.sql bundle-same
FAKE_NEW_LEVEL="$OLD_LEVEL" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && [ "$(creates)" = 0 ] && grep -q "caddy already serves this Caddyfile" "$S/out" \
  && ok "caddysame: nothing changed for caddy → not recreated (no TLS/connection blip)" || { bad "caddysame: rc=$rc creates=$(creates)"; show; }
setup caddybad r1; publish "$R2" 0012_new.sql bundle-caddy
FAKE_CADDY_INVALID=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && [ "$(last reason)" = "the Caddyfile does not validate" ] && [ "$(last dbRestored)" = false ] \
  && ! grep -q "run --rm backend-migrate" "$FAKE/log" && [ "$(creates)" = 0 ] && ! grep -q "caddy-marker" "$DEPLOY/Caddyfile" \
  && grep -q "unrecognized directive" "$S/out" \
  && ok "caddybad: an invalid Caddyfile rolls back before migrating; caddy never loads it; caddy's reason is shown" || { bad "caddybad: rc=$rc record=$(last status)/$(last reason) creates=$(creates)"; show; }
setup edgedown r1; publish "$R2" 0011_old.sql bundle-caddy
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_EDGE=down run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && [ "$(last reason)" = "post-update verification failed" ] && grep -q "does not serve pod.example.com/health" "$S/out" \
  && [ "$(cat "$FAKE/caddy_loaded")" = "$(sha "$DEPLOY/Caddyfile")" ] && ! grep -q "caddy-marker" "$DEPLOY/Caddyfile" \
  && ok "edgedown: an edge that does not answer /health rolls back, and caddy is back on the previous Caddyfile" || { bad "edgedown: rc=$rc record=$(last status)/$(last reason)"; show; }
setup edgehttp r1; publish "$R2" 0011_old.sql bundle-caddy
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_EDGE=http-only run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && grep -q "answers over :80" "$S/out" && ok "edgehttp: a pod served only on :80 (tunnel, or no certificate yet) passes, and says so" || { bad "edgehttp: rc=$rc"; show; }
# H6: a hand-edited deploy/Caddyfile is named before the release replaces it;
# CADDYFILE_PATH is the escape hatch, and updates leave it alone.
setup caddyedit r1; publish "$R2" 0011_old.sql bundle-caddy
mkdir -p "$DEPLOY/state"; sha "$DEPLOY/Caddyfile" > "$DEPLOY/state/caddyfile.release.sha256"
echo "# my own rule" >> "$DEPLOY/Caddyfile"
FAKE_NEW_LEVEL="$OLD_LEVEL" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && grep -q "deploy/Caddyfile was edited by hand" "$S/out" && grep -q "CADDYFILE_PATH" "$S/out" \
  && [ "$(cat "$DEPLOY/state/caddyfile.release.sha256")" = "$(sha "$DEPLOY/Caddyfile")" ] \
  && ok "caddyedit: a hand edit is warned about (with the CADDYFILE_PATH escape hatch); the marker follows the new release copy" || { bad "caddyedit: rc=$rc"; show; }
setup caddycustom r1; publish "$R2" 0011_old.sql bundle-caddy
printf '{$DOMAIN} {\n  respond "mine"\n}\n' > "$S/custom.Caddyfile"; echo "CADDYFILE_PATH=$S/custom.Caddyfile" >> "$DEPLOY/.env"
sha "$S/custom.Caddyfile" > "$FAKE/caddy_loaded"; cp "$S/custom.Caddyfile" "$S/custom.orig"
FAKE_NEW_LEVEL="$OLD_LEVEL" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && grep -q "caddy serves CADDYFILE_PATH=" "$S/out" && [ "$(creates)" = 0 ] && cmp -s "$S/custom.Caddyfile" "$S/custom.orig" \
  && ok "caddycustom: a CADDYFILE_PATH file is left alone, not reloaded, and the operator is told release rules miss it" || { bad "caddycustom: rc=$rc creates=$(creates)"; show; }

# ── 1c. update the updater first (H1) ─────────────────────────────────────────
# The release's bundle carries a `synap` that marks _ue_install_bundle; the
# host runs the plain (unmarked) one. A mark proves the release's OWN engine
# ran the post-bundle steps; units are re-rendered from the INSTALLED synap.
setup handoff r1; PUBLISH_MARK_ENGINE=1 publish "$R2" 0012_new.sql bundle
mkdir -p "$S/fakesys" "$S/run" "$S/units"
printf '#!/usr/bin/env bash\necho "$*" >> "%s/systemctl.log"\n' "$S" > "$S/fakesys/systemctl"; chmod +x "$S/fakesys/systemctl"
PATH="$S/fakesys:$PATH" SYNAP_SYSTEMD_RUN_DIR="$S/run" SYNAP_SYSTEMD_DIR="$S/units" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && [ "$(cur_id)" = "$R2" ] && ok "handoff: update to $R2 succeeded" || { bad "handoff: rc=$rc"; show; }
grep -q "engine=.*state/update/bundle/synap handoff=$R2 " "$FAKE/engine_marks" 2>/dev/null \
  && ok "handoff: the release's OWN synap (staged bundle) ran the post-bundle steps" || { bad "handoff: the host's old engine ran them: $(cat "$FAKE/engine_marks" 2>/dev/null)"; show; }
[ "$(grep -c 'Handing the rest of the update' "$S/out")" = 1 ] && ok "handoff: exactly one handoff (the new engine never hands off again)" || bad "handoff: $(grep -c 'Handing the rest' "$S/out") handoffs"
! grep -q "already running" "$S/out" && ok "handoff: the new engine keeps the update lock (same pid)" || bad "handoff: lock refused after the exec"
[ -s "$S/units/synap-update.service" ] && grep -qE "^ExecStart=/.*/handoff/repo/synap update --unattended$" "$S/units/synap-update.service" \
  && ! grep -rq "state/update/bundle" "$S/units" && grep -q "daemon-reload" "$S/systemctl.log" \
  && ok "handoff: systemd units re-rendered from the INSTALLED synap after the verified update" || { bad "handoff: units not refreshed: $(ls "$S/units" 2>/dev/null | tr '\n' ' ') $(grep ExecStart "$S/units/synap-update.service" 2>/dev/null)"; show; }
# rollback through the handed-off engine: still a clean rollback, units untouched
setup handoffrb r1; PUBLISH_MARK_ENGINE=1 publish "$R2" 0012_new.sql bundle
mkdir -p "$S/fakesys" "$S/run" "$S/units"
printf '#!/usr/bin/env bash\necho "$*" >> "%s/systemctl.log"\n' "$S" > "$S/fakesys/systemctl"; chmod +x "$S/fakesys/systemctl"
FAKE_PROD_BAD=1 PATH="$S/fakesys:$PATH" SYNAP_SYSTEMD_RUN_DIR="$S/run" SYNAP_SYSTEMD_DIR="$S/units" run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && [ "$(cur_id)" = "$R1" ] && cmp -s "$DEPLOY/.env" "$S/env.orig" \
  && grep -q "handoff=$R2" "$FAKE/engine_marks" 2>/dev/null && [ -z "$(ls "$S/units")" ] \
  && ok "handoffrb: the release's engine rolls back cleanly; units are only refreshed after a verified update" || { bad "handoffrb: rc=$rc status=$(last status) units=$(ls "$S/units")"; show; }
# A stale or foreign handoff never runs: the manifest on disk must be that release.
setup handoffbad r1; publish "$R2" 0012_new.sql bundle
mkdir -p "$DEPLOY/state/update"; manifest "$R2" "$NEW_SHA" d 0012_new.sql > "$DEPLOY/state/update/manifest.json"
SYNAP_UE_HANDOFF="main-9999999" run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = aborted ] && [[ "$(last reason)" == *"handoff manifest"* ]] && ! grep -qE '^pull |compose (run|up)' "$FAKE/log" \
  && ok "handoffbad: a handoff naming another release is refused before anything changes" || { bad "handoffbad: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }

# ── 2. image fails health (canary) → previous digests, schema unchanged ──────
setup canary r1; publish "$R2" 0011_old.sql bundle
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_CANARY_BAD=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && ok "canary: failed update exits non-zero" || bad "canary: rc=0"
[ "$(cur_id)" = "$R1" ] && ok "canary: current-release is back to $R1" || bad "canary: current-release=$(cur_id)"
cmp -s "$DEPLOY/.env" "$S/env.orig" && ok "canary: .env restored byte-identical (previous digests)" || bad "canary: .env differs: $(diff "$S/env.orig" "$DEPLOY/.env" | head -4)"
[ "$(cat "$FAKE/backend_image")" = "$(grep '^SYNAP_IMAGE_BACKEND=' "$S/env.orig" | cut -d= -f2-)" ] && ok "canary: backend runs the previous digest" || bad "canary: backend runs $(cat "$FAKE/backend_image")"
[ "$(restores)" = 0 ] && [ "$(last dbRestored)" = false ] && [ "$(last schema)" = unchanged ] && ! grep -q "synap restore" "$S/out" \
  && ok "canary: no DB restore, schema unchanged, no restore command offered" || bad "canary: restores=$(restores) dbRestored=$(last dbRestored) schema=$(last schema)"
! grep -q "release-marker" "$DEPLOY/docker-compose.yml" && [ ! -e "$DEPLOY/added-by-$R2.txt" ] && ok "canary: deploy files restored, bundle-added file removed" || bad "canary: bundle not rolled back"
[ "$(last status)" = rolled_back ] && notified rolled_back && ok "canary: rollback recorded + notified" || { bad "canary: record=$(last status)"; show; }

# ── 3. migration throws → images roll back, the DATA IS KEPT ─────────────────
# A rollback swaps images only (founder, 2026-10-20): the schema stays where the
# migration left it, the pre-update dump is kept and offered to the operator.
setup migrate r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && ok "migrate: failed update exits non-zero" || bad "migrate: rc=0"
# (the backup's own `pg_restore -l` lists the dump it wrote; it restores nothing)
[ "$(restores)" = 0 ] && ! grep -q "pg_restore -U" "$FAKE/log" && ! grep -qE 'rename to|create database|drop database' "$FAKE/log" \
  && [ "$(cat "$FAKE/level")" = "$NEW_LEVEL" ] \
  && ok "migrate: no restore of any kind — the database stays migrated ($NEW_LEVEL)" || bad "migrate: restores=$(restores) level=$(cat "$FAKE/level") restore-calls=$(grep -E 'pg_restore -U|rename to|create database|drop database' "$FAKE/log")"
grep -qE "compose stop|compose .* stop " "$FAKE/log" && bad "migrate: writers were stopped (a maintenance window for a restore that no longer happens)" || ok "migrate: writers never stopped"
cmp -s "$DEPLOY/.env" "$S/env.orig" && [ "$(cur_id)" = "$R1" ] && ok "migrate: previous digests + current-release $R1" || bad "migrate: env/current-release not restored ($(cur_id))"
BK="$(last backup)"
[ "$(last status)" = rolled_back ] && [ "$(last dbRestored)" = false ] && [ "$(last schema)" = migrated ] && [ -d "$BK" ] && [ -s "$BK/synap.dump" ] && notified rolled_back \
  && ok "migrate: rolled_back recorded + notified: dbRestored:false, schema:migrated, backup = the kept pre-update dump" || { bad "migrate: record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
[[ "$(last reason)" == "backend migration failed; the database schema stays migrated"* ]] \
  && ok "migrate: the reason says the schema stayed migrated" || bad "migrate: reason=$(last reason)"
grep -qF "synap restore $BK" "$S/out" && grep -q "DISCARDS everything written since" "$S/out" && grep -q "data was not touched" "$S/out" \
  && ok "migrate: the operator is given the exact restore command and what it costs" || { bad "migrate: no restore command printed"; show; }
grep -q "profile canary up" "$FAKE/log" && bad "migrate: the canary ran after a failed migration" || ok "migrate: no canary / swap after the throw"

# ── 3b. restoring the kept dump is the operator's door: `synap restore <dir>` ─
# These were the rollback's restore checks; they now guard the door it offers.
# restore_from <answer> [env...] — runs `synap restore $BK` against this pod.
restore_from() {
  local answer="$1"; shift
  : > "$FAKE/log"
  ( cd "$S"; env "$@" PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" bash "$REPO/synap" restore "$BK" ) >"$S/rout" 2>&1 <<<"$answer"
}
started() { grep -q "^compose up -d --remove-orphans$" "$FAKE/log"; }
rshow()   { echo "      --- tail of restore output ---"; tail -10 "$S/rout" | sed 's/^/      /'; }

restore_from no; rc=$?
[ "$rc" = 0 ] && grep -q "Restore cancelled" "$S/rout" && ! grep -qE "pg_restore|rename to|compose stop" "$FAKE/log" \
  && ok "restore-no: answering anything but yes restores nothing" || { bad "restore-no: rc=$rc"; rshow; }

restore_from yes; rc=$?
[ "$rc" = 0 ] && [ "$(restores)" = 1 ] && [ "$(cat "$FAKE/level")" = "$OLD_LEVEL" ] && started \
  && ok "restore-ok: the pre-update dump is restored (level back to $OLD_LEVEL), then the stack starts" || { bad "restore-ok: rc=$rc restores=$(restores) level=$(cat "$FAKE/level")"; rshow; }
s=$(grep -n "compose stop" "$FAKE/log" | head -1 | cut -d: -f1); r=$(grep -n "pg_restore -U" "$FAKE/log" | head -1 | cut -d: -f1)
[ -n "$s" ] && [ -n "$r" ] && [ "$s" -lt "$r" ] && ok "restore-ok: writers stopped before the restore" || bad "restore-ok: stop=$s restore=$r"
a=$(grep -n 'rename to "synap__pre_restore"' "$FAKE/log" | head -1 | cut -d: -f1); cr=$(grep -n 'create database "synap"' "$FAKE/log" | head -1 | cut -d: -f1); dr=$(grep -n 'drop database "synap__pre_restore"' "$FAKE/log" | head -1 | cut -d: -f1)
[ -n "$a" ] && [ -n "$cr" ] && [ -n "$dr" ] && [ "$a" -lt "$cr" ] && [ "$cr" -lt "$r" ] && [ "$r" -lt "$dr" ] && ! grep -q "pg_restore .*--clean" "$FAKE/log" && [ "$(cat "$FAKE/dbs")" = synap ] \
  && ok "restore-ok: restored into a FRESH database (live renamed aside, new created, no --clean, aside dropped after)" || bad "restore-ok: rename=$a create=$cr restore=$r drop=$dr clean=$(grep -c 'pg_restore .*--clean' "$FAKE/log") dbs=$(tr '\n' ' ' < "$FAKE/dbs" 2>/dev/null)"
grep -q "fingerprint matches the dump" "$S/rout" && ok "restore-ok: the dump's fingerprint is checked" || { bad "restore-ok: no fingerprint check"; rshow; }

# Any pg_restore error puts the live database back (fresh copy dropped, aside renamed back).
setup restorebad r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 run_update --release "$R2"; BK="$(last backup)"
restore_from yes FAKE_PG_RESTORE_FAIL=1; rc=$?
[ "$rc" != 0 ] && grep -q "putting every database back" "$S/rout" && [ "$(cat "$FAKE/dbs")" = synap ] && ! started && ! grep -q "Restore complete" "$S/rout" \
  && ok "restore-bad: a failed pg_restore puts the live database back, claims nothing, starts nothing" || { bad "restore-bad: rc=$rc dbs=$(tr '\n' ' ' < "$FAKE/dbs" 2>/dev/null)"; rshow; }

# The restore succeeds but the data is not the dump's → refused, stack not started.
setup restoredrift r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 run_update --release "$R2"; BK="$(last backup)"
restore_from yes FAKE_FP_DRIFT=1; rc=$?
[ "$rc" != 0 ] && grep -q "did not bring the data back" "$S/rout" && ! started \
  && ok "restore-drift: a fingerprint that differs from the dump's is refused, the stack is not started" || { bad "restore-drift: rc=$rc"; rshow; }

# No room for the fresh copy → refused before anything is stopped.
setup restorefull r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 run_update --release "$R2"; BK="$(last backup)"
restore_from yes FAKE_PG_FREE_KB=1; rc=$?
[ "$rc" != 0 ] && grep -q "not enough room to restore" "$S/rout" && ! grep -q "compose stop" "$FAKE/log" && [ "$(cat "$FAKE/dbs" 2>/dev/null || echo synap)" = synap ] \
  && ok "restore-full: a full volume refuses the restore and leaves the database alone" || { bad "restore-full: rc=$rc"; rshow; }

# The existence check FAILS during the restore → the live database is never
# dropped (a failed read once read as "absent", and the revert then dropped it).
setup restoreread r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 run_update --release "$R2"; BK="$(last backup)"
restore_from yes FAKE_DB_STATE_FAIL=synap; rc=$?
[ "$rc" != 0 ] && grep -q "cannot tell whether 'synap' exists" "$S/rout" \
  && ! grep -q 'drop database if exists "synap"' "$FAKE/log" && ! grep -q 'drop database "synap"' "$FAKE/log" && [ "$(cat "$FAKE/dbs" 2>/dev/null || echo synap)" = synap ] \
  && ok "restore-read: a failed existence check stops the restore and never drops the live database" || { bad "restore-read: rc=$rc drops=$(grep -c 'drop database' "$FAKE/log")"; rshow; }

# A backup run holds the backup lock → the restore waits, then gives up untouched.
setup restorelock r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 run_update --release "$R2"; BK="$(last backup)"
LK="$DEPLOY/backups/postgres"; mkdir -p "$LK"; HOLD=""
if command -v flock >/dev/null 2>&1; then touch "$LK/.backup.flock"; flock "$LK/.backup.flock" sleep 60 & HOLD=$!; sleep 0.3; else mkdir "$LK/.backup.lock"; fi
restore_from yes SYNAP_RESTORE_LOCK_WAIT=2; rc=$?
[ -n "$HOLD" ] && kill "$HOLD" 2>/dev/null; rmdir "$LK/.backup.lock" 2>/dev/null
[ "$rc" != 0 ] && grep -q "a backup run still holds" "$S/rout" && ! grep -q 'rename to "synap__pre_restore"' "$FAKE/log" && [ "$(cat "$FAKE/dbs" 2>/dev/null || echo synap)" = synap ] \
  && ok "restore-lock: a held backup lock makes the restore wait, then refuse untouched" || { bad "restore-lock: rc=$rc"; rshow; }

# ── 3b'. the dump a rollback offers survives later updates' dump pruning ─────
# Both prunes (pgdata_backup: newest 5; _ue_prune_images: newest 2) skip the
# dump of the newest rolled-back update whose schema moved, read from
# state/events.jsonl — here the ONLY record still naming it: an aborted update
# has since replaced last-update.json, and the pod still runs R1.
setup dumpkeep r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 run_update --release "$R2"; BK="$(last backup)"
grep -q "kept until another failed update offers a newer one" "$S/out" \
  && ok "dumpkeep: the restore hint says how long the dump is kept" || { bad "dumpkeep: no retention in the hint"; show; }
R3="main-3333333"; publish "$R3" 0013_x.sql; jq '.minFrom = "0099_z.sql"' "$TMP/rel/$R3/release.json" > "$TMP/x" && mv "$TMP/x" "$TMP/rel/$R3/release.json"
run_update --release "$R3"
# Six newer dumps, then R4's own dump stamped newest of all (a fake `date`).
for i in 1 2 3 4 5 6; do mkdir -p "$DEPLOY/backups/postgres/2099010100000${i}Z-pre-update"; done
mkdir -p "$S/datebin"; printf '#!/usr/bin/env bash\ncase "$*" in *%%Y%%m%%dT%%H%%M%%SZ*) echo 20991231T000000Z ;; *) exec %s "$@" ;; esac\n' "$(command -v date)" > "$S/datebin/date"; chmod +x "$S/datebin/date"
R4="main-4444444"; publish "$R4" 0013_x.sql
PATH="$S/datebin:$PATH" FAKE_NEW_LEVEL="13|0013_x.sql" run_update --release "$R4"; rc=$?
P="$DEPLOY/backups/postgres"; kept="$(ls "$P" | grep -c -- '-pre-update$')"
[ "$rc" = 0 ] && [ "$(cur_id)" = "$R4" ] && [ -d "$BK" ] && [ -s "$BK/synap.dump" ] && [ "$kept" = 3 ] \
  && [ -d "$P/20991231T000000Z-pre-update" ] && [ -d "$P/20990101000006Z-pre-update" ] && [ ! -d "$P/20990101000005Z-pre-update" ] \
  && ok "dumpkeep: a later update prunes to the newest 2 dumps and keeps the one the rollback offered (named only by events.jsonl)" \
  || { bad "dumpkeep: rc=$rc cur=$(cur_id) BK=$BK kept=$kept: $(ls "$DEPLOY/backups/postgres" | tr '\n' ' ')"; show; }

# ── 3c. SIGHUP (ssh drop) mid-update → rolled back like INT/TERM ─────────────
# A shell started with SIGHUP ignored (under nohup) cannot trap it: the scenario
# then cannot run, and says so rather than reporting the engine broken.
if [ "$(bash -c 'trap "echo trapped" HUP; kill -HUP $$; :' 2>/dev/null)" != trapped ]; then
  echo "skip - hup: SIGHUP is ignored in this environment (nohup?), so no shell here can trap it"
else
setup hup r1; publish "$R2" 0012_new.sql
FAKE_HUP_AT_MIGRATE=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && [[ "$(last reason)" == "interrupted;"* ]] && [ "$(last dbRestored)" = false ] && [ "$(last schema)" = migrated ] \
  && [ "$(restores)" = 0 ] && [ "$(cat "$FAKE/level")" = "$NEW_LEVEL" ] && cmp -s "$DEPLOY/.env" "$S/env.orig" \
  && ok "hup: SIGHUP mid-migration rolls the images back, keeps the migrated data" || { bad "hup: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null) level=$(cat "$FAKE/level")"; show; }
fi

# ── 3d. the migration ledger is unreadable → refused before anything changes ─
setup ledgerfail r1; publish "$R2" 0012_new.sql bundle
cp "$DEPLOY/docker-compose.yml" "$S/compose.orig"
FAKE_LEDGER_FAIL=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = aborted ] && [ "$(last reason)" = "migration ledger unreadable" ] \
  && cmp -s "$DEPLOY/.env" "$S/env.orig" && cmp -s "$DEPLOY/docker-compose.yml" "$S/compose.orig" \
  && ! grep -qE "pg_dump|run --rm backend-migrate" "$FAKE/log" && [ "$(cur_id)" = "$R1" ] \
  && ok "ledgerfail: an unreadable ledger refuses the update (no dump, no migration, nothing changed)" || { bad "ledgerfail: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
# … readable before, unreadable after a failed migration → "unknown", never "moved"/"unchanged"
setup ledgerlost r1; publish "$R2" 0012_new.sql
FAKE_MIGRATE_FAIL=1 FAKE_LEDGER_FAIL=after-migrate run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && [ "$(last schema)" = unknown ] && [ "$(last dbRestored)" = false ] && [[ "$(last reason)" == *"whether the schema moved is unknown"* ]] \
  && [ "$(restores)" = 0 ] && grep -qF "synap restore $(last backup)" "$S/out" \
  && ok "ledgerlost: a ledger lost after the migration is recorded as schema:unknown, with the restore command" || { bad "ledgerlost: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
# … a database without a ledger table yet is level 0, not unreadable
setup noledger r1; publish "$R2" 0012_new.sql
FAKE_NO_LEDGER=1 run_update --release "$R2"; rc=$?
grep -q "Migration level: 0| →" "$S/out" && ! grep -q "ledger unreadable" "$S/out" \
  && ok "noledger: no _migrations table yet reads as level 0 (not as unreadable)" || { bad "noledger: rc=$rc"; show; }

# ── 3d'. TimescaleDB: a postgres image must load the extension the database runs
# A newer image ships every older library: the update goes on and the lag is a
# notice. An image without the database's version would leave postgres unable
# to start (and a rollback swaps images only): refused before anything changes.
# An unreadable extension version refuses too (never read as "no extension").
setup tsdbnewer r1; PG_DIGEST=b publish "$R2" 0012_new.sql bundle
FAKE_TSDB_EXT=2.26.4 FAKE_TSDB_LIBS_NEW="2.26.4 2.27.0 2.28.3" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && [ "$(cur_id)" = "$R2" ] && [[ "$(envpin SYNAP_IMAGE_POSTGRES)" == *"@sha256:$(D64 b)" ]] \
  && grep -q "database 'synap' runs 2.26.4; this postgres image ships up to 2.28.3" "$S/out" && ! grep -q "ALTER EXTENSION" "$FAKE/log" \
  && ok "tsdbnewer: a newer postgres image is taken; the extension lag is a notice, never an automatic ALTER EXTENSION" || { bad "tsdbnewer: rc=$rc"; show; }
setup tsdbolder r1; PG_DIGEST=b publish "$R2" 0012_new.sql bundle
cp "$DEPLOY/docker-compose.yml" "$S/compose.orig"
FAKE_TSDB_EXT=2.28.3 FAKE_TSDB_LIBS_NEW="2.25.0 2.26.4" run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = aborted ] && [ "$(last reason)" = "postgres image cannot load TimescaleDB 2.28.3 (database synap)" ] \
  && grep -q "ships TimescaleDB up to 2.26.4, but database 'synap' runs 2.28.3" "$S/out" \
  && cmp -s "$DEPLOY/.env" "$S/env.orig" && cmp -s "$DEPLOY/docker-compose.yml" "$S/compose.orig" \
  && ! grep -qE "pg_dump|run --rm backend-migrate" "$FAKE/log" && [ "$(cur_id)" = "$R1" ] \
  && ok "tsdbolder: an image that lacks the database's TimescaleDB is refused before anything changes" || { bad "tsdbolder: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
setup tsdbunread r1; PG_DIGEST=b publish "$R2" 0012_new.sql bundle
FAKE_TSDB_READ_FAIL=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last reason)" = "TimescaleDB extension versions unreadable" ] && cmp -s "$DEPLOY/.env" "$S/env.orig" && ! grep -q "run --rm backend-migrate" "$FAKE/log" \
  && ok "tsdbunread: an unreadable extension version refuses the image change (never read as 'no extension')" || { bad "tsdbunread: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
setup tsdbsame r1; publish "$R2" 0012_new.sql bundle
FAKE_TSDB_READ_FAIL=1 FAKE_TSDB_LIBS="2.25.0" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && [ "$(cur_id)" = "$R2" ] && ! grep -q "postgres image cannot load" "$S/out" \
  && ok "tsdbsame: a release that keeps the postgres image is not checked (nothing to load anew)" || { bad "tsdbsame: rc=$rc"; show; }

# ── 3e. minFrom compares the newest migration BY NAME, never the latest applied
# 0331 merged after 0336 was applied: it is the latest by time, 0336 the newest.
minfrom() { jq --arg m "$1" '.minFrom = $m' "$TMP/rel/$R2/release.json" > "$TMP/x" && mv "$TMP/x" "$TMP/rel/$R2/release.json"; }
setup minfromlate r1; publish "$R2" 0337_new.sql; minfrom 0335_x.sql
echo "13|0336_y.sql" > "$FAKE/level"; echo "13|0331_late.sql" > "$FAKE/level_by_time"
jq '.migrations.last = "0336_y.sql"' "$DEPLOY/state/current-release.json" > "$TMP/x" && mv "$TMP/x" "$DEPLOY/state/current-release.json"
FAKE_NEW_LEVEL="14|0337_new.sql" run_update --release "$R2"; rc=$?
[ "$(last status)" != aborted ] && grep -q "Migration level: 13|0336_y.sql →" "$S/out" \
  && ok "minfromlate: a late-merged migration does not make the pod look below minFrom" || { bad "minfromlate: record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
setup minfromlow r1; publish "$R2" 0012_new.sql; minfrom 0012_new.sql
run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = aborted ] && [ "$(last reason)" = "below minFrom 0012_new.sql" ] && ! grep -qE "pg_dump|run --rm backend-migrate" "$FAKE/log" \
  && ok "minfromlow: a pod below minFrom is refused before the dump and the migration" || { bad "minfromlow: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
# The refusal names the release to take first (minFromRelease, derived by make-manifest).
setup minfromrel r1; publish "$R2" 0012_new.sql; minfrom 0012_new.sql
jq '.minFromRelease = "v9.1.0"' "$TMP/rel/$R2/release.json" > "$TMP/x" && mv "$TMP/x" "$TMP/rel/$R2/release.json"
run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last reason)" = "below minFrom 0012_new.sql: update to v9.1.0 first" ] && grep -qF "Update to v9.1.0 first (synap update --release v9.1.0), then to $R2" "$S/out" \
  && ok "minfromrel: the refusal names the release to update to first" || { bad "minfromrel: rc=$rc reason=$(last reason)"; show; }
# The database reached minFrom only through an images-only rollback: the code it
# runs (R1, migrations up to 0011) is what a failed update would roll back to.
setup minfromrb r1; publish "$R2" 0013_c.sql; minfrom 0012_new.sql
echo "$NEW_LEVEL" > "$FAKE/level"   # 0012 applied by an update that was then rolled back
run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = aborted ] && [ "$(last reason)" = "below minFrom 0012_new.sql" ] && grep -q "runs $R1 (migrations up to 0011_old.sql)" "$S/out" \
  && ! grep -qE "pg_dump|run --rm backend-migrate" "$FAKE/log" \
  && ok "minfromrb: a database ahead of its running release (rolled back) is still below minFrom" || { bad "minfromrb: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
# Byte order, never the locale's: in C 'a' (0x61) sorts after 'Z' (0x5A); a
# glibc en_US collation puts a before Z, so `[[ < ]]` would refuse this pod.
COLL=""; for l in en_US.UTF-8 en_US.utf8 C.UTF-8; do LC_ALL=$l bash -c '[[ 0012_a.sql < 0012_Z.sql ]]' 2>/dev/null && { COLL=$l; break; }; done
if [ -z "$COLL" ]; then
  echo "skip - minfromcoll: no installed locale collates differently from byte order here"
else
setup minfromcoll r1; publish "$R2" 0013_c.sql; minfrom 0012_Z.sql
echo "12|0012_a.sql" > "$FAKE/level"; jq '.migrations.last = "0012_a.sql"' "$DEPLOY/state/current-release.json" > "$TMP/x" && mv "$TMP/x" "$DEPLOY/state/current-release.json"
LC_ALL=$COLL FAKE_NEW_LEVEL="13|0013_c.sql" run_update --release "$R2"; rc=$?
[ "$(last status)" != aborted ] && ok "minfromcoll: names compare in byte order (0012_a.sql ≥ 0012_Z.sql) under LC_ALL=$COLL" || { bad "minfromcoll: record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
fi

# ── 4. canary passes, production fails → rollback ────────────────────────────
setup prod r1; publish "$R2" 0012_new.sql
FAKE_PROD_BAD=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && ok "prod: failed update exits non-zero" || bad "prod: rc=0"
grep -q "compose --profile canary up -d backend-canary" "$FAKE/log" && ok "prod: the canary ran (and passed)" || bad "prod: no canary"
[ "$(cur_id)" = "$R1" ] && cmp -s "$DEPLOY/.env" "$S/env.orig" && [ "$(cat "$FAKE/backend_image")" != "ghcr.io/synap-core/backend@sha256:$NEW_DIGEST" ] \
  && ok "prod: back on $R1's digests" || bad "prod: current=$(cur_id) backend=$(cat "$FAKE/backend_image")"
[ "$(restores)" = 0 ] && [ "$(cat "$FAKE/level")" = "$NEW_LEVEL" ] && [ "$(last schema)" = migrated ] && ok "prod: level had moved → kept migrated, no restore" || bad "prod: restores=$(restores) schema=$(last schema)"
[ "$(last status)" = rolled_back ] && notified rolled_back && ok "prod: rollback recorded + notified" || { bad "prod: record=$(last status)"; show; }

# ── 4a. a rollback restores the kratos.yml that was running ──────────────────
# kratos.yml is generated by the update, not shipped in the bundle: a bad render
# once outlived the rollback and left Kratos crash-looping (perso, 2026-10-14).
setup kratosrb r1; publish "$R2" 0012_new.sql
mkdir -p "$REPO/kratos"; printf 'version: v1.3.1\n# running-config-sentinel\n' > "$REPO/kratos/kratos.yml"
cp "$REPO/kratos/kratos.yml" "$S/kratos.orig"
FAKE_PROD_BAD=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && cmp -s "$REPO/kratos/kratos.yml" "$S/kratos.orig" \
  && ok "kratos: rollback restores the running kratos.yml" \
  || { bad "kratos: rc=$rc status=$(last status) sentinel=$(grep -c running-config-sentinel "$REPO/kratos/kratos.yml" 2>/dev/null)"; show; }

# ── 4c. a valid pre-update kratos.yml is preferred over kratos.yml.good ──────
setup kprefer r1; publish "$R2" 0012_new.sql
mkdir -p "$REPO/kratos"; printf 'version: v1.3.1\n# running-config-sentinel\n' > "$REPO/kratos/kratos.yml"
printf 'version: v1.3.1\n# good-config-sentinel\n' > "$REPO/kratos/kratos.yml.good"
cp "$REPO/kratos/kratos.yml" "$S/kratos.orig"; cp "$REPO/kratos/kratos.yml.good" "$S/kratos.good"
FAKE_PROD_BAD=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && cmp -s "$REPO/kratos/kratos.yml" "$S/kratos.orig" && cmp -s "$REPO/kratos/kratos.yml.good" "$S/kratos.good" \
  && ok "kprefer: a valid pre-update kratos.yml wins over .good; .good untouched" || { bad "kprefer: rc=$rc kratos=$(tail -1 "$REPO/kratos/kratos.yml")"; show; }

# ── 4d. the pre-update kratos.yml is itself broken → kratos.yml.good (N5) ────
setup kgood r1; publish "$R2" 0012_new.sql
mkdir -p "$REPO/kratos"
printf 'version: v1.3.1\n{"level":30,"msg":"config loaded"}\n' > "$REPO/kratos/kratos.yml"
printf 'version: v1.3.1\n# good-config-sentinel\n' > "$REPO/kratos/kratos.yml.good"; cp "$REPO/kratos/kratos.yml.good" "$S/kratos.good"
FAKE_PROD_BAD=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && cmp -s "$REPO/kratos/kratos.yml" "$S/kratos.good" \
  && ok "kgood: a broken pre-update kratos.yml is replaced by the last verified kratos.yml.good" \
  || { bad "kgood: rc=$rc status=$(last status) kratos=$(head -2 "$REPO/kratos/kratos.yml" | tail -1)"; show; }
grep -q "pre-update kratos.yml is itself broken" "$S/out" && ok "kgood: the operator is told why" || bad "kgood: no warning"
[ -s "$REPO/kratos/kratos.yml.good" ] && ok "kgood: kratos.yml.good survives the run" || bad "kgood: kratos.yml.good was removed"

# ── 4e. rollback, but Kratos never becomes ready → rollback_failed (N1) ──────
setup kratosdown r1; publish "$R2" 0012_new.sql
FAKE_PROD_BAD=1 FAKE_KRATOS_DOWN=1 run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rollback_failed ] && notified rollback_failed \
  && [[ "$(last reason)" == *"Kratos (sign-in) is not ready"* ]] && grep -q "ROLLBACK INCOMPLETE" "$S/out" \
  && ok "kratosdown: Kratos not ready after the rollback records rollback_failed, with the reason" \
  || { bad "kratosdown: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
[ "$(grep -c 'compose exec -T kratos wget' "$FAKE/log")" = 2 ] && ok "kratosdown: readiness polled SYNAP_KRATOS_READY_TRIES times" || bad "kratosdown: polls=$(grep -c 'compose exec -T kratos wget' "$FAKE/log")"

# ── 4f. a service Docker marks unhealthy after the swap → rollback (N2) ──────
setup unhealthy r1; publish "$R2" 0011_old.sql
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_HEALTH="kratos=unhealthy" run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = rolled_back ] && [ "$(last reason)" = "post-update verification failed" ] \
  && grep -q "unhealthy: kratos" "$S/out" && [ "$(cur_id)" = "$R1" ] && cmp -s "$DEPLOY/.env" "$S/env.orig" \
  && ok "unhealthy: a service running but unhealthy after the swap rolls back" || { bad "unhealthy: rc=$rc record=$(last status)/$(last reason)"; show; }
setup starting r1; publish "$R2" 0011_old.sql
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_HEALTH="kratos=starting" run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && grep -q "still starting: kratos" "$S/out" && [ "$(last status)" = rolled_back ] \
  && ok "starting: never healthy within the wait (crash-loop shape) rolls back" || { bad "starting: rc=$rc"; show; }
setup slowstart r1; publish "$R2" 0011_old.sql
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_HEALTH="postgres-backup=starting:1800000000000" run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && [ "$(cur_id)" = "$R2" ] && grep -q "not judged healthy, not blocking the update: postgres-backup(starting)" "$S/out" \
  && ok "slowstart: a start_period longer than the wait (postgres-backup 30m) is warned, not rolled back" || { bad "slowstart: rc=$rc"; show; }
setup unhealthybefore r1; publish "$R2" 0011_old.sql
FAKE_NEW_LEVEL="$OLD_LEVEL" FAKE_HEALTH="postgres-backup=unhealthy" FAKE_HEALTH_ALWAYS=1 run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && [ "$(cur_id)" = "$R2" ] && grep -q "postgres-backup(unhealthy before the update)" "$S/out" \
  && ok "unhealthybefore: a service already unhealthy before the update is warned, not rolled back" || { bad "unhealthybefore: rc=$rc"; show; }

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
grep -qE "^builder prune -f --max-used-space 2gb" "$FAKE/log" && ok "source: build cache capped after the update (disk)" || bad "source: build cache never pruned — every from-source update grows it"
! grep -qE "^builder prune .*-a|^(system|volume) prune" "$FAKE/log" && ok "source: cache prune is capped, never -a / system / volume" || bad "source: an unbounded prune ran"
[ "$(envpin SYNAP_IMAGE_BACKEND)" = "synap-dev/backend:$tag12" ] && [ "$(cur_id)" = "local-$tag12" ] && [ "$(jq -r .source "$DEPLOY/state/current-release.json")" = true ] \
  && ok "source: recorded as release local-$tag12 (source:true)" || bad "source: env=$(envpin SYNAP_IMAGE_BACKEND) id=$(cur_id)"
[ "$(envpin SYNAP_IMAGE_MINIO)" = "$(grep '^SYNAP_IMAGE_MINIO=' "$S/env.orig" | cut -d= -f2-)" ] && ok "source: third-party pins carried over from the previous release" || bad "source: minio pin lost"
ls -d "$DEPLOY"/backups/postgres/*-pre-update >/dev/null 2>&1 && grep -q "canary" "$FAKE/log" && ok "source: same backup + canary path as a release" || bad "source: skipped backup/canary"

# ── 6b. --from-source, a FAILED build resets the BuildKit cache ───────────────
# The lock-out this guards (perso, 2026-10-06): a build that dies mid-layer
# leaves cache records whose containerd snapshots no longer exist, and every
# retry then fails at its FIRST RUN with "failed to stat active key during
# commit: snapshot ... does not exist". The post-update cap cannot clear that —
# it runs only after a SUCCESSFUL applied update — so without a reset the pod
# can never rebuild, however many times it is retried.
setup sourcefail r1
mkdir -p "$REPO/apps/pod-admin" "$REPO/packages/database/migrations"
cp "$HERE/deploy/Dockerfile" "$DEPLOY/Dockerfile"; echo "FROM scratch" > "$REPO/apps/pod-admin/Dockerfile"
: > "$REPO/packages/database/migrations/0011_old.sql"; : > "$REPO/packages/database/migrations/0012_new.sql"
( cd "$REPO" && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm fixture ) || bad "sourcefail: git fixture"
: > "$FAKE/log"
FAKE_BUILD_FAIL=1 SYNAP_SKIP_GIT_SYNC=1 run_update --from-source; rc=$?
[ "$rc" != 0 ] && ok "sourcefail: a failed build aborts the update" || { bad "sourcefail: rc=$rc (build failure ignored)"; show; }
grep -qE "^builder prune -af" "$FAKE/log" && ok "sourcefail: the (poisoned) BuildKit cache is reset after a failed build" || bad "sourcefail: cache not reset after a failed build — the pod self-locks, every retry re-fails"
[ "$(cur_id)" = "$R1" ] && ok "sourcefail: the release is unchanged after a failed build" || bad "sourcefail: current-release=$(cur_id)"

# ── 7. edge=traefik: caddy never touched, every other service comes up ───────
setup traefik r1; publish "$R2" 0012_new.sql
echo "SYNAP_EDGE=traefik" >> "$DEPLOY/.env"; cp "$DEPLOY/.env" "$S/env.orig"
FAKE_CADDY_FAIL=1 run_update --release "$R2"; rc=$?
[ "$rc" = 0 ] && ok "traefik: update completed" || { bad "traefik: rc=$rc"; show; }
grep -E " up .*caddy|caddy .* up" "$FAKE/log" && bad "traefik: caddy was brought up" || ok "traefik: caddy never touched"
swap=$(grep -n "force-recreate --remove-orphans backend realtime" "$FAKE/log" | head -1 | cut -d: -f1)
rest=$(grep -n "up -d --remove-orphans .*redis" "$FAKE/log" | tail -1 | cut -d: -f1)
[ -n "$swap" ] && [ -n "$rest" ] && [ "$rest" -gt "$swap" ] && ok "traefik: the other services come up after the swap" || bad "traefik: swap=$swap rest=$rest"
for svc in postgres redis minio typesense kratos pod-admin postgres-backup; do
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
[ "$(last status)" = aborted ] && [[ "$(last reason)" == *SYNAP_EDGE* ]] && ok "eve-unpinned: the refusal is recorded (aborted)" || bad "eve-unpinned: no outcome record: $(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"
( cd "$S"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_RELEASE_BASE_URL=https://rel.test SYNAP_SKIP_EDGE=1 \
  SYNAP_HEALTH_INTERVAL=0 SYNAP_UPDATE_HEALTH_TRIES=2 SYNAP_UPDATE_MIN_FREE_MB=1 bash "$REPO/synap" update --release "$R2" ) >"$S/out" 2>&1 </dev/null; rc=$?
[ "$rc" = 0 ] && [ "$(grep -c '^SYNAP_EDGE=traefik' "$DEPLOY/.env")" = 1 ] && ! grep -qE " up .*caddy" "$FAKE/log" \
  && ok "skip-edge: eve's SYNAP_SKIP_EDGE=1 pins SYNAP_EDGE=traefik once and skips caddy" || { bad "skip-edge: rc=$rc"; show; }

setup port80 r1; publish "$R2" 0012_new.sql
FAKE_PORT_HOLDER="eve-legs-traefik||" run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && grep -q "eve-legs-traefik" "$S/out" && cmp -s "$DEPLOY/.env" "$S/env.orig" && [ -z "$(grep -E '^pull|compose (run|up)' "$FAKE/log")" ] \
  && ok "port80: edge=caddy with :80 held elsewhere is refused before anything changes" || { bad "port80: rc=$rc"; show; }
[ "$(last status)" = aborted ] && [[ "$(last reason)" == *"80/443"* ]] && ok "port80: the refusal is recorded (aborted)" || bad "port80: no outcome record: $(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"

# ── 9. an invalid manifest is refused before anything changes ────────────────
setup invalid r1; publish "$R2" 0012_new.sql
jq '.images.SYNAP_IMAGE_REDIS = "redis:7-alpine"' "$TMP/rel/$R2/release.json" > "$TMP/x" && mv "$TMP/x" "$TMP/rel/$R2/release.json"
run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && grep -q "SYNAP_IMAGE_REDIS is not pinned by digest" "$S/out" && cmp -s "$DEPLOY/.env" "$S/env.orig" \
  && ok "invalid: an unpinned image refuses the manifest, nothing changed" || { bad "invalid: rc=$rc"; show; }

# ── 9b. every early exit records an outcome (B3) ─────────────────────────────
# A pod-agent order waits for the record carrying its request id; an exit
# without one is reported as UPDATE_NO_OUTCOME three hours later.
setup secrets r1; publish "$R2" 0012_new.sql
grep -v '^JWT_SECRET=' "$DEPLOY/.env" > "$S/x" && cp "$S/x" "$DEPLOY/.env"
run_update --release "$R2"; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = aborted ] && [[ "$(last reason)" == *"missing critical secrets: JWT_SECRET"* ]] \
  && ok "secrets: a .env missing critical secrets is refused AND recorded" || { bad "secrets: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
mkdir -p "$TMP/cosignok"; printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/cosignok/cosign"; chmod +x "$TMP/cosignok/cosign"
setup noopreq r1; publish "$R1" 0011_old.sql
echo '{"bundle":"fake"}' > "$TMP/rel/$R1/release.json.sigstore.json"
mkdir -p "$DEPLOY/state/requests"
printf '{"schema":1,"release":"%s","requestedBy":"pod-agent","requestedAt":"2026-10-19T00:00:00Z","id":"req-noop"}\n' "$R1" > "$DEPLOY/state/requests/update.json"
PATH="$TMP/cosignok:$PATH" run_update --unattended; rc=$?
[ "$rc" = 0 ] && [ "$(last status)" = noop ] && [ "$(last request)" = req-noop ] && [ "$(last to)" = "$R1" ] \
  && ok "noopreq: a request for the release the pod runs is recorded noop with its request id" || { bad "noopreq: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }
setup policy r1
mkdir -p "$DEPLOY/state"; echo '{"auto": true, "window": "25:00-26:00"}' > "$DEPLOY/state/update-policy.json"
run_update --unattended; rc=$?
[ "$rc" != 0 ] && [ "$(last status)" = aborted ] && [[ "$(last reason)" == *"is not HH:MM-HH:MM"* ]] \
  && ok "policy: a broken update policy is recorded, not only printed" || { bad "policy: rc=$rc record=$(cat "$DEPLOY/state/last-update.json" 2>/dev/null)"; show; }

# ── 10. channels resolve through channel-<name>/release.json ──────────────────
setup channel r1; publish "$R2" 0012_new.sql
mkdir -p "$TMP/rel/channel-fast"; cp "$TMP/rel/$R2/release.json" "$TMP/rel/channel-fast/release.json"
echo "SYNAP_UPDATE_CHANNEL=fast" >> "$DEPLOY/.env"
run_update; rc=$?
[ "$rc" = 0 ] && [ "$(cur_id)" = "$R2" ] && ok "channel: bare \`synap update\` follows SYNAP_UPDATE_CHANNEL=fast" || { bad "channel: rc=$rc current=$(cur_id)"; show; }

exit $fail
