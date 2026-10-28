#!/bin/sh
# ============================================================================
# Update lock — ONE pod-mutating operation at a time (POSIX sh, sourced)
# ============================================================================
# WHY: `synap update`, eve, the update unit and an operator could all
# run an install/update/rebuild/reset/restore against the same deploy dir at
# the same time — two migrations, two canary swaps, a reset racing an update.
# Nothing serialised them (update-door plan 2026-10-04, §1 contradiction 7).
#
# Sourced by `synap` (install/update/rebuild/reset/restore). The lock lives
# at <deploy_dir>/state/update.lock; a
# second invocation fails FAST with the holder's identity — it never waits,
# so an automation retry cannot queue a stale update behind a live one.
# The one exception waits a BOUNDED time: a compose request (pod-agent's
# `host_compose`) has already been taken from its queue and a person or the CP
# is waiting on its outcome, so failing it because an update is mid-way would
# only make them send it again (the pgdata_restore backup lock waits the same way).
#
#   synap_update_lock <deploy_dir> <operation> [wait-seconds]   # 0 = held, 1 = busy/failed
#
# Implementation: `flock -n` on fd 9 (util-linux; every pod host). The kernel
# releases it when the process — and every child holding fd 9 — exits, so it
# can never go stale. Hosts without flock (macOS dev installs) fall back to an
# atomic `mkdir` lock whose owner pid is checked for liveness.
# SYNAP_LOCK_IMPL=mkdir forces the fallback (tests exercise both on Linux).
# ============================================================================

_synap_lock_busy() { # <operation> <owner text> [mkdir lock dir] [flock file]
    # A flock is held by every process that inherited fd 9, not only the one
    # that took it: a `synap update` stopped mid-build leaves its `docker build`
    # holding the lock, and the owner text names a pid that is gone (27 Oct:
    # the person could not tell what to stop). When that pid is gone, name the
    # processes still holding the lock, with the command that stops them.
    _slb_pid="$(printf '%s' "${2:-}" | sed -n 's/.* pid=\([0-9][0-9]*\).*/\1/p')"
    if [ -n "${4:-}" ] && [ -n "$_slb_pid" ] && ! _synap_pid_alive "$_slb_pid"; then
        _slb_left="$(_synap_lock_holders "$4")"
        if [ -n "$_slb_left" ]; then
            echo "❌ The update lock is held by processes left over from a stopped operation." >&2
            echo "   The operation that took it (${2}) is gone; what it started still holds the lock:" >&2
            printf '%s\n' "$_slb_left" | sed 's/^/     /' >&2
            echo "   Stop them, then re-run '${1}':  kill $(printf '%s\n' "$_slb_left" | cut -d' ' -f1 | tr '\n' ' ')" >&2
            return 0
        fi
    fi
    echo "❌ Another Synap pod operation is already running against this deploy dir." >&2
    echo "   Holder: ${2:-unknown}" >&2
    echo "   Refusing to start '${1}' concurrently — wait for it to finish, then re-run." >&2
    [ -n "${3:-}" ] && echo "   If no synap / eve process is running, remove ${3} and re-run." >&2
    return 0
}

# 0 when <pid> runs. A zombie has exited (only its parent has not reaped it),
# so it does not count; kill -0 alone says it lives.
_synap_pid_alive() {
    if [ -r "/proc/$1/stat" ]; then
        [ "$(sed -n 's/^.*) \([A-Za-z]\) .*/\1/p' "/proc/$1/stat" 2>/dev/null)" != Z ]
        return
    fi
    [ -d /proc/self ] && return 1
    kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1
}

# The processes that hold <file> open (Linux /proc), one "pid command" line
# each. This shell and everything it forked are left out: they hold fd 9 too
# (the open that failed to lock), and the scan itself runs in subshells.
# Prints nothing where /proc has no fd links (macOS dev installs).
_synap_lock_holders() {
    [ -d /proc/self/fd ] || return 0
    _slh_target="$(readlink -f "$1" 2>/dev/null)" || return 0
    find /proc/[0-9]*/fd -maxdepth 1 -lname "$_slh_target" 2>/dev/null | cut -d/ -f3 | sort -n -u |
        while read -r _slh_pid; do
            _synap_pid_is_ours "$_slh_pid" && continue
            # Gone since the scan (the scan's own short-lived pipeline): skip.
            _slh_cmd="$( (tr '\0' ' ' < "/proc/$_slh_pid/cmdline") 2>/dev/null | cut -c1-160)"
            [ -n "$_slh_cmd" ] || continue
            printf '%s %s\n' "$_slh_pid" "$_slh_cmd"
        done
}

# 0 when <pid> is this shell or one of its descendants (a few levels up).
_synap_pid_is_ours() {
    _spo_p="$1"; _spo_i=0
    while [ -n "$_spo_p" ] && [ "$_spo_p" -gt 1 ] && [ "$_spo_i" -lt 8 ]; do
        [ "$_spo_p" = "$$" ] && return 0
        _spo_p="$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$_spo_p/status" 2>/dev/null)"
        _spo_i=$((_spo_i + 1))
    done
    return 1
}

synap_update_lock() {
    _sul_dir="$1"; _sul_op="${2:-operation}"; _sul_wait="${3:-0}"
    [ -n "$_sul_dir" ] || return 0
    mkdir -p "$_sul_dir/state" || { echo "❌ cannot create $_sul_dir/state for the update lock" >&2; return 1; }
    _sul_file="$_sul_dir/state/update.lock"
    _sul_owner="$_sul_op pid=$$ since=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    # `synap update --from-source` re-execs itself after syncing the checkout:
    # same pid, and it already holds the lock (the flock fd is inherited; the
    # mkdir lock's owner is this pid). Re-arm the mkdir cleanup the exec dropped.
    if [ -n "${SYNAP_LOCK_HELD_BY:-}" ] && [ "$SYNAP_LOCK_HELD_BY" = "$$" ]; then
        if [ -d "$_sul_file.d" ]; then
            _SYNAP_LOCK_DIR="$_sul_file.d"
            trap 'rm -rf "$_SYNAP_LOCK_DIR"' EXIT
        fi
        return 0
    fi

    if [ "${SYNAP_LOCK_IMPL:-}" != mkdir ] && command -v flock >/dev/null 2>&1; then
        exec 9>>"$_sul_file" || { echo "❌ cannot open $_sul_file" >&2; return 1; }
        if [ "$_sul_wait" -gt 0 ]; then flock -w "$_sul_wait" 9; else flock -n 9; fi || {
            _synap_lock_busy "$_sul_op" "$(cat "$_sul_file" 2>/dev/null)" "" "$_sul_file"
            return 1
        }
        printf '%s\n' "$_sul_owner" > "$_sul_file"
        return 0
    fi

    if [ "${SYNAP_LOCK_IMPL:-}" != mkdir ] && [ "$(uname -s 2>/dev/null)" = Linux ]; then
        echo "⚠️  flock not found — using a mkdir lock, which does NOT exclude a flock holder (install util-linux)." >&2
    fi
    _sul_d="$_sul_file.d"
    _sul_held=0; _sul_i=0
    while :; do
        mkdir "$_sul_d" 2>/dev/null && { _sul_held=1; break; }
        [ "$_sul_i" -lt "$_sul_wait" ] || break
        _sul_pid="$(sed -n 's/.* pid=\([0-9][0-9]*\).*/\1/p' "$_sul_d/owner" 2>/dev/null)"
        [ -n "$_sul_pid" ] && ! kill -0 "$_sul_pid" 2>/dev/null && ! ps -p "$_sul_pid" >/dev/null 2>&1 && break
        sleep 1; _sul_i=$((_sul_i + 1))
    done
    if [ "$_sul_held" = 0 ]; then
        _sul_pid="$(sed -n 's/.* pid=\([0-9][0-9]*\).*/\1/p' "$_sul_d/owner" 2>/dev/null)"
        # No owner yet = the holder is between mkdir and its write: busy, not stale.
        # kill -0 first (busybox ps has no -p); ps -p covers another user's pid.
        if [ -z "$_sul_pid" ] || kill -0 "$_sul_pid" 2>/dev/null || ps -p "$_sul_pid" >/dev/null 2>&1; then
            _synap_lock_busy "$_sul_op" "$(cat "$_sul_d/owner" 2>/dev/null)" "$_sul_d"
            return 1
        fi
        echo "⚠️  Removing a stale update lock (holder pid $_sul_pid is gone)." >&2
        rm -rf "$_sul_d"
        mkdir "$_sul_d" 2>/dev/null || { _synap_lock_busy "$_sul_op" "(raced)" "$_sul_d"; return 1; }
    fi
    printf '%s\n' "$_sul_owner" > "$_sul_d/owner"
    _SYNAP_LOCK_DIR="$_sul_d"
    trap 'rm -rf "$_SYNAP_LOCK_DIR"' EXIT
    return 0
}

# Release the lock this process holds — for an agent script that hands the
# rest of its work to the host engine (host-request.sh), which takes the lock
# itself. flock: closing fd 9 drops it (no child keeps fd 9 open past here);
# mkdir: remove the dir and its EXIT trap.
synap_update_unlock() {
    if [ -n "${_SYNAP_LOCK_DIR:-}" ]; then
        rm -rf "$_SYNAP_LOCK_DIR"; _SYNAP_LOCK_DIR=""; trap - EXIT
    else
        exec 9>&- 2>/dev/null || true
    fi
    return 0
}
