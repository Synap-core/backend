#!/bin/sh
# ============================================================================
# Host compose requests — the pod-agent side (POSIX sh, sourced)
# ============================================================================
# WHY: pod-agent runs in a container with the deploy dir at /deploy. A
# `docker compose up` run there resolves the compose file's RELATIVE binds
# (./Caddyfile, ../kratos, ./state, …) against /deploy, and the host's docker
# daemon mounts the HOST's /deploy, which does not exist: the CP's email-relay
# delivery recreated kratos with no config and sign-in died (2026-10-19).
#
# So an agent script never creates a container. It asks the host engine:
#
#   host_compose [--recreate] [--no-deps] [--profile <p>]... [--no-wait] [service...]
#
# writes state/requests/compose.json (the COMPOSE REQUEST CONTRACT above
# cmd_compose_request in `synap`), which the host's synap-compose.path runs
# with the real deploy dir. Then it waits for the outcome the host records in
# state/last-compose-request.json for THIS request id: 0 = succeeded, 1 =
# failed / refused / never picked up (the reason is printed). No service = every
# service (`up -d --remove-orphans`). --no-wait returns once the host has TAKEN
# the request (for a request that recreates pod-agent itself, which ends this
# process). `docker compose stop` / `exec` stay in the agent: they create nothing.
#
# Needs SYNAP_DEPLOY_DIR (the agent's /deploy). Timeouts:
# HOST_REQUEST_PICKUP_SECONDS (60), HOST_REQUEST_TIMEOUT_SECONDS (540: under pod-agent's 10-min command timeout).
# ============================================================================

_hr_field() { # <json-line> <key> — a top-level string field of a compact JSON record
    printf '%s\n' "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

host_compose() {
    _hr_recreate=false; _hr_nodeps=false; _hr_wait=1; _hr_profiles=""; _hr_services=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --recreate) _hr_recreate=true ;;
            --no-deps) _hr_nodeps=true ;;
            --no-wait) _hr_wait=0 ;;
            --profile) shift; _hr_profiles="$_hr_profiles $1" ;;
            *) _hr_services="$_hr_services $1" ;;
        esac
        shift
    done
    for _hr_n in $_hr_profiles $_hr_services; do
        case "$_hr_n" in
            *[!a-z0-9_-]*|[!a-z0-9]*|"") echo "host_compose: '$_hr_n' is not a service/profile name" >&2; return 1 ;;
        esac
    done
    _hr_id="agent-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    _hr_json() { # <words> → ["a","b"]
        _hr_a=""; for _hr_w in $1; do _hr_a="${_hr_a:+$_hr_a,}\"$_hr_w\""; done; printf '[%s]' "$_hr_a"
    }
    host_request compose "$_hr_id" \
        "$(printf '{"schema":1,"id":"%s","services":%s,"profiles":%s,"recreate":%s,"noDeps":%s,"requestedBy":"pod-agent","requestedAt":"%s"}' \
            "$_hr_id" "$(_hr_json "$_hr_services")" "$(_hr_json "$_hr_profiles")" "$_hr_recreate" "$_hr_nodeps" \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" \
        "bring up${_hr_services:- every service}" "$_hr_wait"
}

# The ONE agent-side door to a host request: write <body> (one JSON line) to
# state/requests/<name>.json (tmp + rename, 0600), then wait for the host's
# outcome for <id> in state/last-<name>-request.json (synap writes it; the
# unit's request-outcome.sh when the engine died). 0 = succeeded, 1 = failed /
# refused / never picked up (the reason is printed). The outcome record is left
# in HR_RECORD for the caller. <wait> 0 returns once the host TOOK it.
# Timeouts: HOST_REQUEST_PICKUP_SECONDS (60), HOST_REQUEST_TIMEOUT_SECONDS (540).
host_request() { # <name> <id> <body-json> <what, for messages> [wait 1|0]
    _hr_name="$1"; _hr_id="$2"; _hr_wait="${5:-1}"; HR_RECORD=""
    _hr_dir="${SYNAP_DEPLOY_DIR:?host_request needs SYNAP_DEPLOY_DIR}/state/requests"
    _hr_req="$_hr_dir/$_hr_name.json"
    _hr_out="${SYNAP_DEPLOY_DIR}/state/last-$_hr_name-request.json"
    mkdir -p "$_hr_dir" || return 1
    if [ -e "$_hr_req" ]; then
        echo "host_request: another $_hr_name request is still waiting for the host ($_hr_req)" >&2
        return 1
    fi
    _hr_tmp="$_hr_dir/.$_hr_name.$$.tmp"
    ( umask 077 && printf '%s\n' "$3" > "$_hr_tmp" ) && mv -f "$_hr_tmp" "$_hr_req" || { rm -f "$_hr_tmp"; return 1; }
    echo "host_request: asked the host to $4 (request $_hr_id)"

    _hr_t=0
    while :; do
        if [ ! -e "$_hr_req" ]; then
            [ "$_hr_wait" = 0 ] && { echo "host_request: the host took request $_hr_id"; return 0; }
            _hr_rec="$(cat "$_hr_out" 2>/dev/null)"
            if [ "$(_hr_field "$_hr_rec" request)" = "$_hr_id" ]; then
                HR_RECORD="$_hr_rec"
                _hr_st="$(_hr_field "$_hr_rec" status)"
                [ "$_hr_st" = succeeded ] && { echo "host_request: done (request $_hr_id)"; return 0; }
                echo "host_request: the host recorded ${_hr_st:-an unknown outcome} for request $_hr_id: $(_hr_field "$_hr_rec" reason)" >&2
                return 1
            fi
        elif [ "$_hr_t" -ge "${HOST_REQUEST_PICKUP_SECONDS:-60}" ]; then
            # Take it back, so a unit installed later cannot run a stale order.
            mv -f "$_hr_req" "$_hr_dir/$_hr_name.unclaimed.json" 2>/dev/null || continue
            echo "host_request: the host did not take request $_hr_id within ${HOST_REQUEST_PICKUP_SECONDS:-60}s — nothing was changed. On the pod host run: synap units install" >&2
            return 1
        fi
        if [ "$_hr_t" -ge "${HOST_REQUEST_TIMEOUT_SECONDS:-540}" ]; then
            echo "host_request: no outcome for request $_hr_id within ${HOST_REQUEST_TIMEOUT_SECONDS:-540}s — see state/events.jsonl on the pod host" >&2
            return 1
        fi
        sleep "${HOST_REQUEST_POLL_SECONDS:-2}"
        _hr_t=$((_hr_t + ${HOST_REQUEST_POLL_SECONDS:-2}))
    done
}
