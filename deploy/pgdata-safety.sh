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
#   4. compose: the `postgres-backup` service dumps every database daily to
#      deploy/backups/postgres on the HOST (outside Docker's volume store, so
#      `prune --volumes` / `down -v` cannot reach it).
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
_pgs_log()  { echo -e "${BLUE}[pgdata] $*${NC}"; }
_pgs_warn() { echo -e "${YELLOW}[pgdata] ⚠️  $*${NC}" >&2; }
_pgs_err()  { echo -e "${RED}[pgdata] ❌ $*${NC}" >&2; }

# The project's postgres container id (running OR stopped), empty when none.
_pgs_container() {
    (cd "$(_pgs_deploy_dir)" && $COMPOSE_CMD ps -a -q postgres 2>/dev/null | head -1)
}

_pgs_psql() {
    local c="$1" db="$2" sql="$3"
    docker exec "$c" psql -U synap -d "$db" -v ON_ERROR_STOP=1 -Atc "$sql"
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
    done < <(docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$c")
    echo legacy
}

# Record that this pod owns a real database. The postgres entrypoint refuses to
# initdb a blank cluster while this marker exists (compose layer 2).
pgdata_mark_initialized() {
    local c="$1" users
    users="$(_pgs_psql "$c" synap "select count(*) from users" 2>/dev/null || echo 0)"
    if [ "${users:-0}" -gt 0 ] 2>/dev/null; then
        mkdir -p "$(_pgs_deploy_dir)/state"
        date -u +%Y-%m-%dT%H:%M:%SZ > "$(_pgs_deploy_dir)/state/postgres-initialized"
    fi
}

# Dump every non-template database into backups/postgres/<ts>-<label>/<db>.dump.
# Each dump's table of contents is read back; an unreadable dump is a failure.
pgdata_backup() {
    local label="${1:-manual}" c dir tmp db dbs ts
    c="$(_pgs_container)"
    if [ -z "$c" ] || [ "$(docker inspect -f '{{.State.Running}}' "$c")" != "true" ]; then
        _pgs_err "postgres is not running — cannot take a backup"
        return 1
    fi
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    dir="$(_pgs_deploy_dir)/backups/postgres/${ts}-${label}"
    tmp="${dir}.partial"
    mkdir -p "$tmp" || return 1
    dbs="$(_pgs_psql "$c" postgres "select datname from pg_database where not datistemplate and datname <> 'postgres' order by 1")" || {
        _pgs_err "cannot list databases"; rm -rf "$tmp"; return 1; }
    for db in $dbs; do
        if ! docker exec "$c" pg_dump -U synap -Fc "$db" > "$tmp/$db.dump"; then
            _pgs_err "pg_dump failed for '$db'"; rm -rf "$tmp"; return 1
        fi
        if ! docker exec -i "$c" pg_restore -l < "$tmp/$db.dump" > /dev/null; then
            _pgs_err "dump of '$db' is unreadable"; rm -rf "$tmp"; return 1
        fi
    done
    mv "$tmp" "$dir" || return 1
    _pgs_log "backup written: $dir ($(du -sh "$dir" | cut -f1))" >&2
    # Keep the newest 5 pre-update/manual dumps; the daily ones are pruned by
    # the postgres-backup service.
    ls -1d "$(_pgs_deploy_dir)/backups/postgres/"*-"$label" 2>/dev/null | sort | head -n -5 | xargs -r rm -rf
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

    _pgs_warn "postgres cluster at ${pgdata} lives in the container layer of ${c:0:12} — moving it into volume '${volume}'"

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
        _pgs_err "copying the cluster into '${volume}' failed — legacy container ${c:0:12} is untouched"
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

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -uo pipefail
    case "${1:-}" in
        layout)  pgdata_layout ;;
        guard)   pgdata_guard ;;
        backup)  pgdata_backup "${2:-manual}" ;;
        restore) pgdata_restore "${2:?usage: pgdata-safety.sh restore <dir>}" ;;
        *) echo "usage: $0 layout|guard|backup [label]|restore <dir>" >&2; exit 2 ;;
    esac
fi
