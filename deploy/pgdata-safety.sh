#!/bin/bash
# ============================================================================
# Postgres data-placement safety for a Synap pod (fail-closed, non-destructive)
# ============================================================================
# WHY THIS EXISTS — 2026-10-02 incident: the compose file mounted the
# `postgres_data` volume at /var/lib/postgresql/data, but the
# `timescale/timescaledb-ha` image keeps its cluster at /home/postgres/pgdata/data.
# The volume stayed EMPTY for eight months while every user, entity, API key
# and Kratos identity lived in the container's writable layer. One routine
# container recreate (`eve update` + `docker system prune`) wiped a whole pod;
# every client key then reported `key_revoked`.
#
# Defence in depth — this file is layer 3 of 4:
#   1. compose: `PGDATA` is pinned and the volume is mounted at its parent.
#   2. compose: the postgres entrypoint REFUSES to start when that parent is
#      not a mount, and refuses to initdb a blank cluster over a pod that
#      already had data (marker in deploy/state/).
#   3. THIS FILE, run by every update/install door BEFORE compose touches
#      postgres: detects a cluster still living in a container layer
#      ("legacy" layout) and moves it into the volume — with a pre-move dump
#      and a `docker commit` rescue image — then verifies row counts match.
#   4. compose: the `postgres-backup` service runs `backup_loop` below: it
#      dumps every database hourly to deploy/backups/postgres on the HOST
#      (outside Docker's volume store, so `prune --volumes` / `down -v` cannot
#      reach it) and, once `synap backup init` ran, pushes an ENCRYPTED restic
#      snapshot off the host (see "Off-host backups" further down).
#
# SAFETY CONTRACT:
#   • Never drops a database, never deletes a volume, never runs `down`.
#     Before compose is allowed to recreate the legacy container (which removes
#     it), the cluster exists THREE times: a verified pg_dump in
#     backups/postgres, a `docker commit` rescue image, and the volume copy —
#     and the move only reports success once the row fingerprint matches.
#   • Never writes into a volume that already holds a cluster (PG_VERSION).
#   • Every step's postcondition is checked; any failure returns non-zero and
#     the caller must abort.
#
# Usage — sourced (functions) or executed:
#   deploy/pgdata-safety.sh layout        # ok | legacy | absent
#   deploy/pgdata-safety.sh guard         # migrate legacy if needed, mark, exit 0 when safe
#   deploy/pgdata-safety.sh backup [lbl]  # dump every database to backups/postgres/<ts>-<lbl>
#   deploy/pgdata-safety.sh restore <dir> # restore a backup dir produced by `backup`
#   deploy/pgdata-safety.sh init|run|loop|drill [snap]|status|restore-snapshot <snap>
#                                         # off-host backups — see that section
#
# Callers may set COMPOSE_CMD (default `docker compose`) and must run from, or
# set SYNAP_DEPLOY_DIR to, the deploy dir that holds docker-compose.yml.
# ============================================================================
: "${COMPOSE_CMD:=docker compose}"
: "${RED:=\033[0;31m}"
: "${GREEN:=\033[0;32m}"
: "${BLUE:=\033[0;34m}"
: "${YELLOW:=\033[1;33m}"
: "${NC:=\033[0m}"

# The ONE place the in-container layout is named. The compose file must agree;
# deploy/__tests__/pgdata-safety.test.sh fails the build when it does not.
PGDATA_MOUNT_TARGET="/home/postgres/pgdata"
PGDATA_CLUSTER_DIR="/home/postgres/pgdata/data"
# Services that write to postgres; stopped before the cluster is moved.
_PGS_WRITERS="backend backend-canary realtime pod-admin pod-agent kratos hydra openclaw"

_pgs_deploy_dir() { echo "${SYNAP_DEPLOY_DIR:-$(pwd)}"; }
# Where dumps and the init marker live. The host defaults are the deploy dir's
# backups/postgres and state/; the backup container sets SYNAP_BACKUPS_DIR /
# SYNAP_STATE_DIR / SYNAP_ENV_FILE to its mount points (docker-compose.yml).
_bk_backups_dir() { echo "${SYNAP_BACKUPS_DIR:-$(_pgs_deploy_dir)/backups/postgres}"; }
_bk_state_dir()   { echo "${SYNAP_STATE_DIR:-$(_pgs_deploy_dir)/state}"; }
_bk_env_file()    { echo "${SYNAP_ENV_FILE:-$(_pgs_deploy_dir)/.env}"; }
_pgs_log()  { printf "%b\n" "${BLUE}[pgdata] $*${NC}"; }
_pgs_warn() { printf "%b\n" "${YELLOW}[pgdata] ⚠️  $*${NC}" >&2; }
_pgs_err()  { printf "%b\n" "${RED}[pgdata] ❌ $*${NC}" >&2; }

# The project's postgres container id (running OR stopped), empty when none.
# Inside the backup container (SYNAP_PG_DIRECT=1) there is no docker: the
# client tools talk to postgres over the network (PGHOST) and the "container"
# is the literal `direct`.
_pgs_container() {
    if [ "${SYNAP_PG_DIRECT:-}" = 1 ]; then echo direct; return 0; fi
    (cd "$(_pgs_deploy_dir)" && $COMPOSE_CMD ps -a -q postgres 2>/dev/null | head -1)
}

# Run a postgres client tool against container $1 (or directly when `direct`).
# _pgs_xi also forwards stdin (pg_restore reading a dump).
_pgs_x()  { _pgs_c="$1"; shift; if [ "$_pgs_c" = direct ]; then "$@"; else docker exec "$_pgs_c" "$@"; fi; }
_pgs_xi() { _pgs_c="$1"; shift; if [ "$_pgs_c" = direct ]; then "$@"; else docker exec -i "$_pgs_c" "$@"; fi; }

_pgs_psql() {
    local c="$1" db="$2" sql="$3"
    _pgs_x "$c" psql -U synap -d "$db" -v ON_ERROR_STOP=1 -Atc "$sql"
}

# "users|entities|api_keys" of the synap db — the fingerprint compared across a move.
_pgs_fingerprint() {
    _pgs_psql "$1" synap "select (select count(*) from users)||'|'||(select count(*) from entities)||'|'||(select count(*) from api_keys)" 2>/dev/null
}

_pgs_wait_ready() {
    local c="$1" i
    for i in $(seq 1 60); do
        docker exec "$c" pg_isready -U synap -q 2>/dev/null && return 0
        sleep 2
    done
    return 1
}

# Prints the layout of the CURRENT postgres container:
#   absent — no postgres container exists for this project
#   ok     — its PGDATA lives on a mount (volume or bind)
#   legacy — its PGDATA lives in the container's writable layer (data loss on recreate)
pgdata_layout() {
    # POSIX only: deploy/update-pod.sh (#!/bin/sh — busybox ash in the
    # pod-agent image) sources this file; a bash-only `< <(...)` here was a
    # syntax error that killed every update-pod.sh run at source time.
    local c pgdata dest
    c="$(_pgs_container)"
    if [ -z "$c" ]; then echo absent; return 0; fi
    pgdata="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | sed -n 's/^PGDATA=//p' | head -1)"
    [ -z "$pgdata" ] && pgdata="/var/lib/postgresql/data"
    while IFS= read -r dest; do
        [ -z "$dest" ] && continue
        if [ "$pgdata" = "$dest" ] || [ "${pgdata#"$dest"/}" != "$pgdata" ]; then
            echo ok; return 0
        fi
    done <<EOF
$(docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$c")
EOF
    echo legacy
}

# Record that this pod owns a real database. The postgres entrypoint refuses to
# initdb a blank cluster while this marker exists (compose layer 2).
pgdata_mark_initialized() {
    local c="$1" users
    users="$(_pgs_psql "$c" synap "select count(*) from users" 2>/dev/null || echo 0)"
    if [ "${users:-0}" -gt 0 ] 2>/dev/null; then
        mkdir -p "$(_bk_state_dir)"
        date -u +%Y-%m-%dT%H:%M:%SZ > "$(_bk_state_dir)/postgres-initialized"
    fi
}

_pgs_running() {
    if [ "$1" = direct ]; then pg_isready -q 2>/dev/null; return; fi
    [ -n "$1" ] && [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

# Dump every non-template database of $1 into dir $2 as <db>.dump, read each
# dump's table of contents back (an unreadable dump is a failure), and record
# the users|entities|api_keys fingerprint in $2/fingerprint — the number a
# drill or a restore later compares against. Non-zero on any failure; the
# caller removes $2.
_pgs_dump_into() {
    local c="$1" tmp="$2" db dbs
    mkdir -p "$tmp" || return 1
    dbs="$(_pgs_psql "$c" postgres "select datname from pg_database where not datistemplate and datname <> 'postgres' order by 1")" || {
        _pgs_err "cannot list databases"; return 1; }
    [ -n "$dbs" ] || { _pgs_err "no databases to dump"; return 1; }
    for db in $dbs; do
        if ! _pgs_x "$c" pg_dump -U synap -Fc "$db" > "$tmp/$db.dump"; then
            _pgs_err "pg_dump failed for '$db'"; return 1
        fi
        if ! _pgs_xi "$c" pg_restore -l < "$tmp/$db.dump" > /dev/null; then
            _pgs_err "dump of '$db' is unreadable"; return 1
        fi
    done
    _pgs_fingerprint "$c" > "$tmp/fingerprint"
}

# Dump every non-template database into backups/postgres/<ts>-<label>/<db>.dump.
# Each dump's table of contents is read back; an unreadable dump is a failure.
pgdata_backup() {
    local label="${1:-manual}" c dir tmp ts
    c="$(_pgs_container)"
    if ! _pgs_running "$c"; then
        _pgs_err "postgres is not running — cannot take a backup"
        return 1
    fi
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    dir="$(_bk_backups_dir)/${ts}-${label}"
    tmp="${dir}.partial"
    _pgs_dump_into "$c" "$tmp" || { rm -rf "$tmp"; return 1; }
    mv "$tmp" "$dir" || return 1
    _pgs_log "backup written: $dir ($(du -sh "$dir" | cut -f1))" >&2
    # Keep the newest 5 pre-update/manual dumps; the scheduled ones are pruned
    # by backup_run.
    ls -1d "$(_bk_backups_dir)/"*-"$label" 2>/dev/null | sort | head -n -5 | xargs -r rm -rf
    echo "$dir"
}

# Restore a directory written by pgdata_backup (or the postgres-backup service).
# Stops writers, restores each <db>.dump with --clean, restarts nothing: the
# caller (operator) brings the stack back with `synap start`.
pgdata_restore() {
    local dir="$1" c f db
    if [ ! -d "$dir" ] || ! ls "$dir"/*.dump >/dev/null 2>&1; then
        _pgs_err "no *.dump files in '$dir'"; return 1
    fi
    c="$(_pgs_container)"
    [ -z "$c" ] && { _pgs_err "no postgres container"; return 1; }
    (cd "$(_pgs_deploy_dir)" && $COMPOSE_CMD stop $_PGS_WRITERS 2>/dev/null)
    for f in "$dir"/*.dump; do
        db="$(basename "$f" .dump)"
        _pgs_psql "$c" postgres "select 1 from pg_database where datname='$db'" | grep -q 1 \
            || _pgs_psql "$c" postgres "create database \"$db\"" || return 1
        _pgs_log "restoring $db ..."
        docker exec -i "$c" pg_restore -U synap -d "$db" --clean --if-exists --no-owner < "$f" \
            || _pgs_warn "pg_restore reported errors for '$db' (often harmless TimescaleDB catalog notices) — verify below"
    done
    _pgs_log "restored fingerprint (users|entities|api_keys): $(_pgs_fingerprint "$c")"
    pgdata_mark_initialized "$c"
}

# Move a cluster out of a legacy container layer into the project's
# postgres_data volume, then bring postgres up on the volume and prove the data
# came across. A rescue image of the legacy container is committed first.
pgdata_migrate_legacy() {
    local c project volume image pgdata before after running rescue ts
    c="$(_pgs_container)"
    [ -z "$c" ] && { _pgs_err "no postgres container to migrate"; return 1; }
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c")"
    image="$(docker inspect -f '{{.Config.Image}}' "$c")"
    pgdata="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | sed -n 's/^PGDATA=//p' | head -1)"
    [ -z "$pgdata" ] && pgdata="/var/lib/postgresql/data"
    volume="${project}_postgres_data"
    ts="$(date -u +%Y%m%d%H%M%S)"

    _pgs_warn "postgres cluster at ${pgdata} lives in the container layer of $(printf %.12s "$c") — moving it into volume '${volume}'"

    running="$(docker inspect -f '{{.State.Running}}' "$c")"
    if [ "$running" != "true" ]; then
        docker start "$c" >/dev/null && _pgs_wait_ready "$c" || { _pgs_err "cannot start legacy postgres to dump it"; return 1; }
    fi
    before="$(_pgs_fingerprint "$c")"
    _pgs_log "fingerprint before move (users|entities|api_keys): ${before:-<none>}"
    pgdata_backup "pre-pgdata-move" >/dev/null || { _pgs_err "pre-move backup failed — not moving anything"; return 1; }

    (cd "$(_pgs_deploy_dir)" && $COMPOSE_CMD stop $_PGS_WRITERS 2>/dev/null)
    docker stop -t 120 "$c" >/dev/null || { _pgs_err "cannot stop postgres cleanly"; return 1; }

    rescue="pgdata-rescue/${project}-postgres:${ts}"
    docker commit "$c" "$rescue" >/dev/null || { _pgs_err "docker commit of the legacy container failed"; return 1; }
    _pgs_log "rescue image: ${rescue} (delete it once you are satisfied)"

    docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create \
        --label com.docker.compose.project="$project" \
        --label com.docker.compose.volume=postgres_data "$volume" >/dev/null || return 1
    if docker run --rm --user 0 --entrypoint sh -v "$volume":/v "$image" -c 'test -s /v/data/PG_VERSION'; then
        _pgs_err "volume '${volume}' already holds a cluster — refusing to overwrite it. Inspect both by hand."
        return 1
    fi
    if ! docker cp "$c:$pgdata/." - | docker run --rm -i --user 0 --entrypoint sh -v "$volume":/v "$image" -c \
        'mkdir -p /v/data && tar -x -p --numeric-owner -f - -C /v/data && chown -R postgres:postgres /v && chmod 700 /v/data && test -s /v/data/PG_VERSION'; then
        _pgs_err "copying the cluster into '${volume}' failed — legacy container $(printf %.12s "$c") is untouched"
        return 1
    fi

    # Bring postgres up on the volume (the new compose mounts it at
    # PGDATA_MOUNT_TARGET) and prove the same data is there.
    (cd "$(_pgs_deploy_dir)" && $COMPOSE_CMD up -d --no-deps postgres) || return 1
    c="$(_pgs_container)"
    _pgs_wait_ready "$c" || { _pgs_err "postgres did not come up on the volume — restore with: docker run ${rescue}"; return 1; }
    after="$(_pgs_fingerprint "$c")"
    if [ "$(pgdata_layout)" != "ok" ] || [ "$after" != "$before" ]; then
        _pgs_err "post-move check failed: layout=$(pgdata_layout) before=${before} after=${after}. Data is safe in ${rescue} and backups/postgres."
        return 1
    fi
    _pgs_log "✓ cluster moved; fingerprint matches (${after})"
    pgdata_mark_initialized "$c"
}

# The ONE call every door makes before compose may recreate postgres.
pgdata_guard() {
    local layout c
    layout="$(pgdata_layout)"
    case "$layout" in
        absent) return 0 ;;
        legacy) pgdata_migrate_legacy || return 1 ;;
        ok) ;;
        *) _pgs_err "unknown layout '$layout'"; return 1 ;;
    esac
    c="$(_pgs_container)"
    if [ -n "$c" ] && [ "$(docker inspect -f '{{.State.Running}}' "$c")" = "true" ]; then
        pgdata_mark_initialized "$c"
    fi
    return 0
}

# ============================================================================
# Off-host backups — the ONE backup door (docs: backups-dr plan, Option B)
# ============================================================================
# A pod's backup is a restic snapshot of {every database dump, the MinIO
# objects, .env, state/}, encrypted ON THE POD with a password generated here
# (`synap backup init`) that only the owner holds (recovery kit) — the storage
# target and the control plane never can read it.
#
# The target is configured by .env only, storage-agnostic (restic URL syntax):
#   BACKUP_REPOSITORY=rest:https://host:8000/pod  |  s3:https://…/bucket/pod
#                     b2:bucket:pod               |  /mnt/backups/pod (tests)
#   credentials, mapped to restic's own names by stripping BACKUP_:
#   BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY BACKUP_AWS_DEFAULT_REGION
#   BACKUP_B2_ACCOUNT_ID BACKUP_B2_ACCOUNT_KEY
#   BACKUP_RESTIC_REST_USERNAME BACKUP_RESTIC_REST_PASSWORD
#   BACKUP_HEARTBEAT_URL   optional dead-man URL, pinged after a successful push
#
# Doors (the `synap` CLI and the compose `postgres-backup` service call these;
# nothing else implements a backup):
#   backup_init               create the repo, password → state/backup (0600),
#                             print the recovery kit ONCE
#   backup_run                dump → fingerprint gate → publish/rotate → push
#   backup_loop               backup_run every BACKUP_INTERVAL_SECONDS (+ drill)
#   backup_drill [snap]       restore a snapshot into a THROWAWAY postgres and
#                             compare the fingerprint recorded at backup time
#   backup_status             what is configured, last runs, alarms
#   backup_restore_snapshot   fresh-host restore: secrets → DBs → MinIO → compare
#
# APPEND-ONLY BY CONSTRUCTION: this file never runs `restic forget` or `prune`.
# Retention is the TARGET's job (rest-server --append-only + a prune job on the
# storage host, or B2/S3 lifecycle + Object Lock) so that a compromised pod —
# or a confused agent — can add snapshots but never delete history. Suggested
# policy, run where the delete-capable credentials live:
#   restic forget --keep-hourly 24 --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
# deploy/__tests__/backup-offhost.test.sh fails if forget/prune ever appear.
#
# Every run writes a metadata-only row into the `backup_runs` table (time,
# ok/failed/suspect, size, snapshot id, fingerprint, drill result) — never a
# secret. GET /status/backup reads it.
# ============================================================================
RESTIC_VERSION="0.19.1"
# sha256 of restic_${RESTIC_VERSION}_linux_<arch>.bz2 from the release's
# SHA256SUMS. A download that does not match is refused.
RESTIC_SHA256_AMD64="f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c"
RESTIC_SHA256_ARM64="a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465"
# The backup container's mount points. A snapshot always stores these paths
# (push runs in that container), so a restore knows where to find each part.
# docker-compose.yml must agree; backup-loop.test.sh checks it.
_BK_CT_BACKUPS="/backups"
_BK_CT_STATE="/synap-state"
_BK_CT_DEPLOY="/synap-deploy"
# The one restic host name, so `latest` is stable across container recreates.
_BK_HOST="synap-pod"

_bk_password_file() { echo "$(_bk_state_dir)/backup/restic-password"; }

# A config value: the process environment wins, else the pod's .env. Only the
# fixed keys this file names are ever read.
_bk_cfg() {
    local k="$1" v=""
    eval "v=\${$k:-}"
    if [ -z "$v" ] && [ -r "$(_bk_env_file)" ]; then
        v="$(sed -n "s/^$k=//p" "$(_bk_env_file)" | tail -n 1)"
        v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    fi
    printf '%s' "$v"
}

# The repository URL with any user:password@ removed, for display.
_bk_repo_display() { _bk_cfg BACKUP_REPOSITORY | sed 's#://[^/@]*@#://***@#'; }

_bk_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

_bk_bin() {  # restic|mc — the pinned copy in state/bin first, else PATH
    if [ -x "$(_bk_state_dir)/bin/$1" ]; then echo "$(_bk_state_dir)/bin/$1"
    else command -v "$1" 2>/dev/null || true; fi
}

# restic against the configured repository. Runs in a subshell so the
# credentials never leak into the caller's environment.
_bk_restic() {
    local bin
    bin="$(_bk_bin restic)"
    [ -n "$bin" ] || { _pgs_err "restic is not installed — run: synap backup init"; return 127; }
    (
        RESTIC_REPOSITORY="$(_bk_cfg BACKUP_REPOSITORY)"
        RESTIC_PASSWORD_FILE="${BACKUP_PASSWORD_FILE:-$(_bk_password_file)}"
        RESTIC_CACHE_DIR="$(_bk_backups_dir)/.restic-cache"
        export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE RESTIC_CACHE_DIR
        for _bk_v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION \
                     B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REST_USERNAME RESTIC_REST_PASSWORD; do
            _bk_x="$(_bk_cfg "BACKUP_$_bk_v")"
            [ -n "$_bk_x" ] && export "$_bk_v=$_bk_x"
        done
        exec "$bin" "$@"
    )
}

# Fetch the pinned restic into state/bin (shared with the backup container
# through the ./state mount), verified against the pinned checksum.
_bk_ensure_restic() {
    local dest arch sum url tmp
    dest="$(_bk_state_dir)/bin/restic"
    [ -x "$dest" ] && return 0
    case "$(uname -m)" in
        x86_64|amd64) arch=amd64; sum="$RESTIC_SHA256_AMD64" ;;
        aarch64|arm64) arch=arm64; sum="$RESTIC_SHA256_ARM64" ;;
        *) _pgs_err "no pinned restic build for $(uname -m)"; return 1 ;;
    esac
    url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${arch}.bz2"
    mkdir -p "$(dirname "$dest")" || return 1
    tmp="$dest.download"
    _pgs_log "fetching restic ${RESTIC_VERSION} (${arch})"
    if ! curl -fsSL --retry 3 -o "$tmp.bz2" "$url"; then
        _pgs_err "could not download $url"; rm -f "$tmp.bz2"; return 1
    fi
    if [ "$(_bk_sha256 "$tmp.bz2")" != "$sum" ]; then
        _pgs_err "checksum mismatch for $url — refusing to install it"; rm -f "$tmp.bz2"; return 1
    fi
    if command -v bunzip2 >/dev/null 2>&1; then bunzip2 -c "$tmp.bz2" > "$tmp"
    else python3 -c 'import bz2,sys; sys.stdout.buffer.write(bz2.decompress(open(sys.argv[1],"rb").read()))' "$tmp.bz2" > "$tmp"
    fi || { _pgs_err "could not decompress restic"; rm -f "$tmp" "$tmp.bz2"; return 1; }
    rm -f "$tmp.bz2"
    chmod 755 "$tmp" && mv "$tmp" "$dest"
}

# The MinIO client, copied out of the running minio container (its image ships
# /usr/bin/mc; nothing is pulled), into state/bin for the backup container.
_bk_ensure_mc() {
    local dest c
    dest="$(_bk_state_dir)/bin/mc"
    [ -x "$dest" ] && return 0
    c="$(cd "$(_pgs_deploy_dir)" && $COMPOSE_CMD ps -q minio 2>/dev/null | head -1)"
    [ -n "$c" ] || { _pgs_err "minio is not running — cannot copy its mc client"; return 1; }
    mkdir -p "$(dirname "$dest")" || return 1
    docker cp "$c:/usr/bin/mc" "$dest.tmp" && chmod 755 "$dest.tmp" && mv "$dest.tmp" "$dest" \
        || { _pgs_err "could not copy mc out of the minio container"; rm -f "$dest.tmp"; return 1; }
}

# mc with a throwaway config dir and the pod's MinIO as alias `synapbk`.
_bk_mc_setup() {
    local bin user pass i
    bin="$(_bk_bin mc)"
    [ -n "$bin" ] || { _pgs_err "mc is not installed — run: synap backup init"; return 1; }
    user="$(_bk_cfg MINIO_ACCESS_KEY)"; pass="$(_bk_cfg MINIO_SECRET_KEY)"
    _BK_MC_CFG="$(mktemp -d "${TMPDIR:-/tmp}/synap-mc.XXXXXX")" || return 1
    _BK_MC="$bin"
    for i in 1 2 3 4 5 6 7 8 9 10; do
        "$bin" --config-dir "$_BK_MC_CFG" alias set synapbk "${BACKUP_MINIO_URL:-http://minio:9000}" "$user" "$pass" >/dev/null 2>&1 \
            && "$bin" --config-dir "$_BK_MC_CFG" ls synapbk >/dev/null 2>&1 && return 0
        sleep 3
    done
    _pgs_err "cannot reach MinIO at ${BACKUP_MINIO_URL:-http://minio:9000}"
    rm -rf "$_BK_MC_CFG"; return 1
}
_bk_mc() { "$_BK_MC" --config-dir "$_BK_MC_CFG" "$@"; }

# Consistent export of every bucket into $1/<bucket> through the S3 API (never
# a copy of MinIO's live on-disk format). Incremental: unchanged objects are
# not re-copied, deleted ones are removed from the export.
_bk_minio_export() {
    local stage="$1" b
    _bk_mc_setup || return 1
    mkdir -p "$stage" || return 1
    for b in $(_bk_mc ls synapbk | awk '{print $NF}' | sed 's#/$##'); do
        _bk_mc mirror --overwrite --remove --quiet "synapbk/$b" "$stage/$b" >/dev/null \
            || { _pgs_err "mc mirror of bucket '$b' failed"; rm -rf "$_BK_MC_CFG"; return 1; }
    done
    rm -rf "$_BK_MC_CFG"
}

# The reverse, for a restore: every $1/<bucket> back into MinIO.
_bk_minio_import() {
    local stage="$1" d b
    [ -d "$stage" ] || { _pgs_err "no MinIO export at $stage"; return 1; }
    _bk_mc_setup || return 1
    for d in "$stage"/*/; do
        [ -d "$d" ] || continue
        b="$(basename "$d")"
        _bk_mc mb --ignore-existing "synapbk/$b" >/dev/null \
            && _bk_mc mirror --overwrite --quiet "$d" "synapbk/$b" >/dev/null \
            || { _pgs_err "restoring bucket '$b' failed"; rm -rf "$_BK_MC_CFG"; return 1; }
        _pgs_log "restored bucket $b"
    done
    rm -rf "$_BK_MC_CFG"
}

# One run at a time (the hourly loop vs. a manual `synap backup push|drill`,
# which runs in its own `compose run` container on the same /backups mount).
# flock(1) on fd 8 (util-linux, Essential in the Ubuntu-based timescaledb-ha
# image and on every pod host): the kernel drops it when the holder dies, so a
# crashed run never leaves it behind. Without flock (SYNAP_LOCK_IMPL=mkdir or a
# macOS dev host): an atomic mkdir lock — stale after 6 h, and cleared by
# backup_loop at startup (a restarted service holds nothing). A refusal is a
# `failed` row in backup_runs, never a silent skip. <kind: backup|drill>
_bk_lock_flock() { [ "${SYNAP_LOCK_IMPL:-}" != mkdir ] && command -v flock >/dev/null 2>&1; }
_bk_lock() {
    local b l
    b="$(_bk_backups_dir)"
    mkdir -p "$b"
    if _bk_lock_flock; then
        l="$b/.backup.flock"
        # `exec` with a failing redirection exits a POSIX shell: prove it opens first.
        if touch "$l" 2>/dev/null; then
            exec 8>>"$l"
            flock -n 8 && return 0
            exec 8>&-
        fi
    else
        l="$b/.backup.lock"
        mkdir "$l" 2>/dev/null && return 0
        if [ -n "$(find "$l" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
            rm -rf "$l"; mkdir "$l" 2>/dev/null && return 0
        fi
    fi
    _pgs_err "another backup run holds $l — this ${1:-backup} run is skipped"
    _bk_record "$(_pgs_container)" "${1:-backup}" failed "$(_bk_now)" "" "" "" "" "skipped: another backup or drill run held the lock"
    return 1
}
_bk_unlock() {
    if _bk_lock_flock; then exec 8>&-
    else rmdir "$(_bk_backups_dir)/.backup.lock" 2>/dev/null || true; fi
}

_bk_sql_str() {
    if [ -z "$1" ]; then echo NULL; else printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; fi
}
# Metadata row in backup_runs: kind status started_at size snapshot fp drill_fp detail.
# A failed insert is reported (the run's outcome is still on stderr and in the
# markers), never silently dropped.
_bk_record() {
    local c="$1" size="$5"
    case "$size" in ''|*[!0-9]*) size=NULL ;; esac
    _pgs_psql "$c" synap "insert into backup_runs (kind, status, started_at, finished_at, size_bytes, snapshot_id, fingerprint, drill_fingerprint, detail) values ($(_bk_sql_str "$2"), $(_bk_sql_str "$3"), $(_bk_sql_str "$4")::timestamptz, now(), $size, $(_bk_sql_str "$6"), $(_bk_sql_str "$7"), $(_bk_sql_str "$8"), $(_bk_sql_str "$9"))" >/dev/null 2>&1 \
        || _pgs_warn "could not record this $2 run ($3) in backup_runs — is migration 0295 applied?"
}

_bk_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Scheduled dumps, oldest first. `-daily` is the pre-2026-10-04 name; those
# rotate out with the rest.
_bk_good_dumps() { ls -1d "$(_bk_backups_dir)"/*-auto "$(_bk_backups_dir)"/*-daily 2>/dev/null | sort; }

# Local retention of the scheduled dumps: the newest BACKUP_KEEP (hourly
# buffer) PLUS the newest dump of each of the last BACKUP_KEEP_DAILY days, so
# going hourly did not shrink the local history from a week to hours. Disk on
# a 2026-10 pod: ~95 MB a set, so 6 + 7 ≈ 1.2 GB. The off-host repository is
# the long history. Never called for a SUSPECT run.
_bk_prune_good() {
    local all keep d
    all="$(_bk_good_dumps)"
    [ -n "$all" ] || return 0
    keep="$( { printf '%s\n' "$all" | tail -n "${BACKUP_KEEP:-6}"
               printf '%s\n' "$all" | awk -F/ '{ last[substr($NF, 1, 8)] = $0 } END { for (k in last) print last[k] }' \
                   | sort | tail -n "${BACKUP_KEEP_DAILY:-7}"; } | sort -u)"
    for d in $all; do
        printf '%s\n' "$keep" | grep -qxF "$d" || rm -rf "$d"
    done
}

# One backup cycle: dump every database, gate it on the fingerprint, publish
# and rotate, then push it off-host when a repository is configured.
# Exit: 0 ok · 1 failed · 3 SUSPECT (data drop: kept aside, nothing pruned,
# nothing pushed, .alarm raised — a dump of an emptied pod must never rotate
# good copies out locally NOR become the newest off-host snapshot).
# Intentional wipe? remove state/postgres-initialized and backups/postgres/.alarm.
backup_run() {
    local c b ts tmp d fp users rest ents last prev suspect started rc
    c="$(_pgs_container)"; b="$(_bk_backups_dir)"
    _bk_lock backup || return 1
    started="$(_bk_now)"; ts="$(date -u +%Y%m%dT%H%M%SZ)"; tmp="$b/$ts.partial"
    if ! _pgs_running "$c" || ! _pgs_dump_into "$c" "$tmp"; then
        rm -rf "$tmp"
        _pgs_err "[backup] FAILED — database dump failed; previous dumps kept"
        _bk_record "$c" backup failed "$started" "" "" "" "" "database dump failed"
        _bk_unlock; return 1
    fi
    fp="$(cat "$tmp/fingerprint")"
    users="${fp%%|*}"; rest="${fp#*|}"; ents="${rest%%|*}"
    [ "$rest" = "$fp" ] && ents=""
    last="$(_bk_good_dumps | tail -n 1)"
    prev="$(cut -d'|' -f2 "$last/fingerprint" 2>/dev/null || true)"
    suspect=""
    if [ -e "$(_bk_state_dir)/postgres-initialized" ]; then
        [ "${users:-0}" -eq 0 ] 2>/dev/null && suspect="0 users"
        [ -z "$users" ] && suspect="no fingerprint (users unreadable)"
        [ -n "$prev" ] && [ "$prev" -gt 0 ] 2>/dev/null && [ $(( ${ents:-0} * 2 )) -lt "$prev" ] && suspect="entities $prev -> ${ents:-0}"
    fi
    if [ -n "$suspect" ]; then
        mv "$tmp" "$b/$ts-SUSPECT"
        echo "$suspect" > "$b/.alarm"
        _pgs_err "[backup] ALARM: $suspect — kept as SUSPECT, previous dumps NOT pruned, NOTHING pushed"
        ls -1d "$b"/*-SUSPECT 2>/dev/null | sort | head -n -3 | xargs -r rm -rf
        _bk_record "$c" backup suspect "$started" "" "" "$fp" "" "$suspect"
        _bk_unlock; return 3
    fi
    d="$b/$ts-auto"
    mv "$tmp" "$d" || { _bk_unlock; return 1; }
    _pgs_log "[backup] ok $d ($(du -sh "$d" | cut -f1), users|entities|api_keys $fp)"
    [ "${users:-0}" -gt 0 ] 2>/dev/null && { mkdir -p "$(_bk_state_dir)"; _bk_now > "$(_bk_state_dir)/postgres-initialized"; }
    rm -f "$b/.alarm"
    _bk_prune_good
    if [ -z "$(_bk_cfg BACKUP_REPOSITORY)" ]; then
        _bk_record "$c" backup ok "$started" "$(( $(du -sk "$d" | cut -f1) * 1024 ))" "" "$fp" "" "local only — no off-host repository configured"
        _bk_unlock; return 0
    fi
    _bk_push "$c" "$d" "$fp" "$started"; rc=$?
    _bk_unlock; return $rc
}

# Snapshot {dump dir, MinIO export, .env, state/} into the repository. Only
# ever called by backup_run with a dump that passed the fingerprint gate.
_bk_push() {
    local c="$1" d="$2" fp="$3" started="$4" b stage out sid size url
    b="$(_bk_backups_dir)"
    case "$d" in *-SUSPECT|*.partial) _pgs_err "refusing to push $d"; return 1 ;; esac
    if [ ! -s "${BACKUP_PASSWORD_FILE:-$(_bk_password_file)}" ]; then
        _bk_push_failed "$c" "$started" "$fp" "repository not initialised — run: synap backup init"; return 1
    fi
    stage="$b/.minio-mirror"
    set -- "$d" "$(_bk_env_file)" "$(_bk_state_dir)"
    if [ -n "$(_bk_cfg MINIO_ACCESS_KEY)" ]; then
        _bk_minio_export "$stage" || { _bk_push_failed "$c" "$started" "$fp" "MinIO export failed"; return 1; }
        set -- "$@" "$stage"
    fi
    out="$(_bk_restic backup --json --host "$_BK_HOST" --tag synap --tag "fp:$fp" --tag "dump:$(basename "$d")" \
        --exclude "$(_bk_state_dir)/bin" --exclude "$(_bk_state_dir)/backup" --exclude "$(_bk_state_dir)/update.lock" \
        "$@")" || { _bk_push_failed "$c" "$started" "$fp" "restic backup failed"; return 1; }
    sid="$(printf '%s\n' "$out" | sed -n 's/.*"message_type": *"summary".*"snapshot_id": *"\([0-9a-f]*\)".*/\1/p' | tail -n 1)"
    size="$(printf '%s\n' "$out" | sed -n 's/.*"message_type": *"summary".*"total_bytes_processed": *\([0-9]*\).*/\1/p' | tail -n 1)"
    [ -n "$sid" ] || { _bk_push_failed "$c" "$started" "$fp" "restic reported no snapshot id"; return 1; }
    rm -f "$b/.push-failed"
    _pgs_log "[backup] pushed snapshot $sid ($(_bk_repo_display))"
    _bk_record "$c" backup ok "$started" "$size" "$sid" "$fp" "" ""
    url="$(_bk_cfg BACKUP_HEARTBEAT_URL)"
    if [ -n "$url" ]; then
        curl -fsS -m 10 --retry 2 -o /dev/null "$url" || _pgs_warn "heartbeat ping failed"
    fi
    return 0
}
_bk_push_failed() {
    _pgs_err "[backup] PUSH FAILED: $4 (the local dump is kept)"
    echo "$4" > "$(_bk_backups_dir)/.push-failed"
    _bk_record "$1" backup failed "$2" "" "" "$3" "" "$4"
}

# Run a command as the postgres OS user (postgres refuses to run as root; the
# backup container is root and ships python3 but no su/runuser/gosu).
_bk_as_pg() {
    if [ "$(id -u)" = 0 ]; then
        python3 -c 'import os,pwd,sys; p=pwd.getpwnam("postgres"); os.setgroups([]); os.setgid(p.pw_gid); os.setuid(p.pw_uid); os.execvp(sys.argv[1], sys.argv[1:])' "$@"
    else "$@"; fi
}

# Restore snapshot $1 (default latest) into a THROWAWAY cluster — a scratch
# data dir in a temp path with its own socket and port, never the live
# postgres — and compare its users|entities|api_keys with the fingerprint
# recorded in the snapshot when it was taken. RED (exit 1) on: snapshot
# unreadable, restore failure (a corrupt pack fails restic's hash check), no
# dump or fingerprint inside, scratch postgres not starting, or a mismatch.
backup_drill() {
    local snap="${1:-latest}" c started work meta sid dname d expected got detail pgbin f db port=55432
    c="$(_pgs_container)"; started="$(_bk_now)"
    work="$(mktemp -d "${TMPDIR:-/tmp}/synap-drill.XXXXXX")" || return 1
    detail=""; expected=""; got=""; sid=""
    meta="$(_bk_restic snapshots --json "$snap" 2>/dev/null)"
    sid="$(printf '%s\n' "$meta" | sed -n 's/^\[\{0,1\}{.*"id": *"\([0-9a-f]*\)".*/\1/p' | head -n 1)"
    # The dump this snapshot carries is named in its `dump:` tag (set by
    # _bk_push) — located by name, so the check does not depend on paths.
    dname="$(printf '%s\n' "$meta" | sed -n 's/.*"dump:\([^"]*\)".*/\1/p' | head -n 1)"
    if [ -z "$sid" ]; then
        detail="snapshot '$snap' not found or repository unreadable"
    elif ! _bk_restic restore "$sid" --target "$work/r" --exclude .minio-mirror >/dev/null; then
        detail="restore of $sid failed (corrupt or missing data)"
    else
        d="$( [ -n "$dname" ] && find "$work/r" -type d -name "$dname" 2>/dev/null | head -n 1)"
        expected="$(cat "$d/fingerprint" 2>/dev/null || true)"
        if [ -z "$d" ] || [ -z "$expected" ] || ! ls "$d"/*.dump >/dev/null 2>&1; then
            detail="snapshot $sid holds no dump with a recorded fingerprint"
        else
            pgbin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -n 1)"
            [ -n "$pgbin" ] && PATH="$pgbin:$PATH"
            mkdir -p "$work/pg" "$work/sock"
            [ "$(id -u)" = 0 ] && chown postgres:postgres "$work" "$work/pg" "$work/sock"
            # 8>&-: the scratch postgres daemon must not inherit the backup flock.
            if ! _bk_as_pg initdb -D "$work/pg" -U synap --auth=trust -E UTF8 >/dev/null 2>&1 \
               || ! _bk_as_pg pg_ctl -D "$work/pg" -w -t 120 -l "$work/pg.log" \
                    -o "-p $port -k $work/sock -c listen_addresses='' -c shared_preload_libraries=timescaledb" start >/dev/null 8>&-; then
                detail="the throwaway postgres did not start"
            else
                for f in "$d"/*.dump; do
                    db="$(basename "$f" .dump)"
                    PGHOST="$work/sock" PGPORT=$port psql -U synap -d postgres -v ON_ERROR_STOP=1 -qAtc "create database \"$db\"" >/dev/null 2>&1
                    PGHOST="$work/sock" PGPORT=$port pg_restore -U synap -d "$db" --no-owner < "$f" >/dev/null 2>&1 || true
                done
                got="$(PGHOST="$work/sock"; PGPORT=$port; export PGHOST PGPORT; _pgs_fingerprint direct)"
                [ "$got" = "$expected" ] || detail="fingerprint mismatch: recorded $expected, restored ${got:-<unreadable>}"
                _bk_as_pg pg_ctl -D "$work/pg" -m immediate stop >/dev/null 2>&1 || true
            fi
        fi
    fi
    rm -rf "$work"
    _bk_now > "$(_bk_backups_dir)/.last-drill" 2>/dev/null || true
    if [ -n "$detail" ]; then
        _pgs_err "[drill] RED: $detail"
        echo "$detail" > "$(_bk_backups_dir)/.drill-failed"
        _bk_record "$c" drill failed "$started" "" "$sid" "$expected" "$got" "$detail"
        return 1
    fi
    rm -f "$(_bk_backups_dir)/.drill-failed"
    _pgs_log "[drill] GREEN: snapshot $sid restores to $got (as recorded)"
    _bk_record "$c" drill ok "$started" "" "$sid" "$expected" "$got" ""
    return 0
}

_bk_drill_due() {
    local f
    f="$(_bk_backups_dir)/.last-drill"
    [ ! -e "$f" ] || [ -n "$(find "$f" -mmin +$(( ${BACKUP_DRILL_INTERVAL_SECONDS:-604800} / 60 )) 2>/dev/null)" ]
}

# The compose `postgres-backup` service runs this.
backup_loop() {
    mkdir -p "$(_bk_backups_dir)" "$(_bk_state_dir)"
    # A mkdir lock left by this service's previous life (killed mid-run) is
    # not held by anyone now; flock needs no such cleanup.
    _bk_lock_flock || rm -rf "$(_bk_backups_dir)/.backup.lock"
    while :; do
        if backup_run && [ -n "$(_bk_cfg BACKUP_REPOSITORY)" ] && _bk_drill_due; then
            _bk_lock drill && { backup_drill latest; _bk_unlock; }
        fi
        sleep "${BACKUP_INTERVAL_SECONDS:-3600}"
    done
}

# Create the repository and its password, then print the recovery kit ONCE.
backup_init() {
    local repo pw dir v kv
    repo="$(_bk_cfg BACKUP_REPOSITORY)"
    if [ -z "$repo" ]; then
        _pgs_err "set BACKUP_REPOSITORY in $(_bk_env_file) first (rest:https://…, s3:…, b2:…, or a path), plus its credentials (BACKUP_AWS_* / BACKUP_B2_* / BACKUP_RESTIC_REST_*)"
        return 2
    fi
    pw="$(_bk_password_file)"
    if [ -e "$pw" ]; then
        _pgs_err "already initialised: $pw exists. The recovery kit is shown only once; that root-only file holds the password."
        return 1
    fi
    if [ ! -t 1 ] && [ "${SYNAP_BACKUP_KIT_STDOUT:-}" != 1 ]; then
        _pgs_err "the recovery kit is printed once, to a terminal — run this interactively (or set SYNAP_BACKUP_KIT_STDOUT=1 if stdout is somewhere private)"
        return 1
    fi
    _bk_ensure_restic || return 1
    if [ -n "$(_bk_cfg MINIO_ACCESS_KEY)" ]; then _bk_ensure_mc || return 1; fi
    dir="$(dirname "$pw")"
    (umask 077 && mkdir -p "$dir" && chmod 700 "$dir" \
        && od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$pw.new" && chmod 600 "$pw.new") \
        || { _pgs_err "cannot write $pw"; rm -f "$pw.new"; return 1; }
    if ! BACKUP_PASSWORD_FILE="$pw.new" _bk_restic init >/dev/null; then
        rm -f "$pw.new"
        _pgs_err "restic init failed (see above). Nothing was kept. An existing repository needs its own password: restore with --password-file, not init."
        return 1
    fi
    mv "$pw.new" "$pw" || return 1
    printf '\n%s\n' "════════════════ SYNAP BACKUP RECOVERY KIT — shown ONCE ════════════════"
    printf '%s\n' "Repository : $repo"
    printf '%s\n' "Password   : $(cat "$pw")"
    for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REST_USERNAME RESTIC_REST_PASSWORD; do
        kv="$(_bk_cfg "BACKUP_$v")"; [ -n "$kv" ] && printf '%s\n' "BACKUP_$v=$kv"
    done
    printf '%s\n' "Restore on a fresh host (synap-backend checked out, nothing running):"
    printf '%s\n' "  1. put the password above in a file:  umask 077; cat > /root/synap-kit-password"
    printf '%s\n' "  2. BACKUP_REPOSITORY='$repo' [BACKUP_* credentials above] \\"
    printf '%s\n' "     ./synap restore --from-snapshot latest --password-file /root/synap-kit-password"
    printf '%s\n' "SAVE THIS IN TWO PLACES YOU CONTROL (e.g. your password manager AND a second"
    printf '%s\n' "device or a printed copy). Synap does not keep it: not in the snapshots, not at"
    printf '%s\n' "the control plane, not in any log. Without it the backups cannot be read."
    printf '%s\n\n' "═════════════════════════════════════════════════════════════════════════"
    _pgs_log "repository initialised; the hourly backup service pushes from its next run (or: synap backup push)" >&2
}

backup_status() {
    local b repo last m c runs
    b="$(_bk_backups_dir)"; repo="$(_bk_cfg BACKUP_REPOSITORY)"
    if [ -n "$repo" ]; then printf '%s\n' "Off-host repository : $(_bk_repo_display)"
    else printf '%s\n' "Off-host repository : not configured (set BACKUP_REPOSITORY in .env)"; fi
    if [ -s "$(_bk_password_file)" ]; then printf '%s\n' "Initialised         : yes (password in $(_bk_password_file))"
    else printf '%s\n' "Initialised         : no — run: synap backup init"; fi
    printf '%s\n' "Tools               : restic ${RESTIC_VERSION} $([ -n "$(_bk_bin restic)" ] && echo present || echo missing), mc $([ -n "$(_bk_bin mc)" ] && echo present || echo missing)"
    last="$(_bk_good_dumps | tail -n 1)"
    if [ -n "$last" ]; then printf '%s\n' "Latest local dump   : $(basename "$last") ($(cat "$last/fingerprint" 2>/dev/null))"
    else printf '%s\n' "Latest local dump   : none"; fi
    for m in alarm push-failed drill-failed; do
        [ -e "$b/.$m" ] && printf '%s\n' "ALERT $m : $(cat "$b/.$m")"
    done
    c="$(_pgs_container)"
    printf '%s\n' "Recent runs (backup_runs):"
    if [ -n "$c" ] && runs="$(_pgs_psql "$c" synap "select kind, status, to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z', coalesce(snapshot_id, '-'), coalesce(fingerprint, '-'), coalesce(detail, '') from backup_runs order by finished_at desc limit 8" 2>/dev/null)"; then
        printf '%s\n' "${runs:-(none yet)}" | sed 's/^/  /; s/|/  /g'
    else
        printf '%s\n' "  could not read backup_runs (postgres down, or migration 0295 not applied)"
    fi
}

# Fresh-host restore: secrets → databases → MinIO → fingerprint compare.
# Host side (needs docker). The stack is NOT started on a mismatch.
backup_restore_snapshot() {
    local snap="$1" deploy b ts pwf stage d pin c expected got pgpw f
    deploy="$(_pgs_deploy_dir)"; b="$(_bk_backups_dir)"; ts="$(date -u +%Y%m%dT%H%M%SZ)"
    [ -n "$snap" ] || { _pgs_err "usage: restore-snapshot <snapshot-id|latest>"; return 2; }
    [ -n "$(_bk_cfg BACKUP_REPOSITORY)" ] || { _pgs_err "BACKUP_REPOSITORY is not set (environment or .env)"; return 2; }
    pwf="${BACKUP_PASSWORD_FILE:-$(_bk_password_file)}"
    [ -s "$pwf" ] || { _pgs_err "no repository password — pass the one from your recovery kit (--password-file)"; return 2; }
    _bk_ensure_restic || return 1
    stage="$b/.restore-$ts"
    mkdir -p "$stage" || return 1
    _pgs_log "1/5 fetching snapshot $snap from $(_bk_repo_display)"
    BACKUP_PASSWORD_FILE="$pwf" _bk_restic restore "$snap" --target "$stage" >/dev/null \
        || { _pgs_err "restic restore failed — nothing on this host was changed"; rm -rf "$stage"; return 1; }
    f="$(find "$stage$_BK_CT_BACKUPS" -mindepth 2 -maxdepth 2 -type f -name fingerprint 2>/dev/null | head -n 1)"
    d="$(dirname "${f:-/nonexistent/x}")"
    expected="$(cat "$f" 2>/dev/null || true)"
    if [ ! -f "$stage$_BK_CT_DEPLOY/.env" ] || [ -z "$expected" ]; then
        _pgs_err "snapshot $snap is missing its .env or its database dump — nothing on this host was changed (staging: $stage)"
        return 1
    fi

    _pgs_log "2/5 secrets: .env and state/"
    if [ -f "$deploy/.env" ] && ! cmp -s "$deploy/.env" "$stage$_BK_CT_DEPLOY/.env"; then
        (umask 077 && cp "$deploy/.env" "$deploy/.env.pre-restore-$ts")
        _pgs_log "   previous .env kept as .env.pre-restore-$ts"
    fi
    (umask 077 && cp "$stage$_BK_CT_DEPLOY/.env" "$deploy/.env") || return 1
    mkdir -p "$(_bk_state_dir)"
    if [ -d "$stage$_BK_CT_STATE" ]; then
        for f in "$stage$_BK_CT_STATE"/* "$stage$_BK_CT_STATE"/.[!.]*; do
            [ -e "$f" ] || continue
            # The init marker is written by pgdata_restore once the data is
            # back — writing it first would make postgres refuse to initdb.
            [ "$(basename "$f")" = postgres-initialized ] && continue
            cp -Rp "$f" "$(_bk_state_dir)/" || return 1
        done
    fi
    # The restored .env may pin a compose project; use it from here on.
    pin="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$deploy/.env" | tail -n 1 | tr -d "\"'")"
    if [ -n "$pin" ]; then COMPOSE_PROJECT_NAME="$pin"; export COMPOSE_PROJECT_NAME; fi

    _pgs_log "3/5 databases"
    (cd "$deploy" && $COMPOSE_CMD up -d postgres) || { _pgs_err "postgres did not start"; return 1; }
    c="$(_pgs_container)"
    _pgs_wait_ready "$c" || { _pgs_err "postgres is not ready"; return 1; }
    pgdata_restore "$d" || return 1
    # Roles are cluster-level, not in pg_dump: align the synap role with the
    # restored POSTGRES_PASSWORD in case this volume was initialised with another.
    pgpw="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$deploy/.env" | tail -n 1)"
    pgpw="${pgpw#\"}"; pgpw="${pgpw%\"}"; pgpw="${pgpw#\'}"; pgpw="${pgpw%\'}"
    if [ -n "$pgpw" ]; then
        printf "alter role synap with password %s;\n" "$(_bk_sql_str "$pgpw")" \
            | docker exec -i "$c" psql -U synap -d postgres -v ON_ERROR_STOP=1 -q >/dev/null \
            || _pgs_warn "could not align the synap role password with the restored .env"
    fi

    _pgs_log "4/5 files (MinIO)"
    if [ -d "$stage$_BK_CT_BACKUPS/.minio-mirror" ]; then
        (cd "$deploy" && $COMPOSE_CMD up -d minio) || { _pgs_err "minio did not start"; return 1; }
        _bk_ensure_mc || return 1
        (cd "$deploy" && $COMPOSE_CMD run --rm --no-deps -T --entrypoint sh postgres-backup \
            "$_BK_CT_DEPLOY/pgdata-safety.sh" minio-import "$_BK_CT_BACKUPS/.restore-$ts$_BK_CT_BACKUPS/.minio-mirror") \
            || { _pgs_err "restoring MinIO objects failed (staging kept: $stage)"; return 1; }
    else
        _pgs_log "   snapshot holds no MinIO export (pod had none)"
    fi

    _pgs_log "5/5 fingerprint"
    got="$(_pgs_fingerprint "$c")"
    if [ "$got" != "$expected" ]; then
        _pgs_err "MISMATCH: the snapshot recorded users|entities|api_keys=$expected, this pod now has ${got:-<unreadable>}. The stack was NOT started; staging kept at $stage."
        return 1
    fi
    if [ "$pwf" != "$(_bk_password_file)" ]; then
        (umask 077 && mkdir -p "$(dirname "$(_bk_password_file)")" && cp "$pwf" "$(_bk_password_file)" && chmod 600 "$(_bk_password_file)")
    fi
    rm -rf "$stage"
    _pgs_log "✓ restored snapshot $snap — fingerprint matches ($got)"
}

# Executed directly (not sourced)? POSIX: no BASH_SOURCE in dash, so match $0 —
# when sourced by `synap` / update-pod.sh, $0 is THEIR name.
case "${0##*/}" in pgdata-safety.sh) _pgs_main=1 ;; *) _pgs_main= ;; esac
if [ -n "$_pgs_main" ]; then
    set -u
    (set -o pipefail) 2>/dev/null && set -o pipefail
    case "${1:-}" in
        layout)  pgdata_layout ;;
        guard)   pgdata_guard ;;
        backup)  pgdata_backup "${2:-manual}" ;;
        restore) pgdata_restore "${2:?usage: pgdata-safety.sh restore <dir>}" ;;
        init)    backup_init ;;
        run|push) backup_run ;;
        loop)    backup_loop ;;
        drill)   _bk_lock drill || exit 1; backup_drill "${2:-latest}"; _r=$?; _bk_unlock; exit $_r ;;
        status)  backup_status ;;
        minio-import) _bk_minio_import "${2:?usage: pgdata-safety.sh minio-import <dir>}" ;;
        restore-snapshot) backup_restore_snapshot "${2:-}" ;;
        *) echo "usage: $0 layout|guard|backup [label]|restore <dir>|init|run|loop|drill [snap]|status|restore-snapshot <snap>" >&2; exit 2 ;;
    esac
fi
