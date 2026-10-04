#!/bin/sh
# ============================================================================
# Update lock — ONE pod-mutating operation at a time (POSIX sh, sourced)
# ============================================================================
# WHY: `synap update`, eve, pod-agent (update-pod.sh) and an operator could all
# run an install/update/rebuild/reset/restore against the same deploy dir at
# the same time — two migrations, two canary swaps, a reset racing an update.
# Nothing serialised them (update-door plan 2026-10-04, §1 contradiction 7).
#
# Sourced by `synap` (install/update/rebuild/reset/restore) and
# deploy/update-pod.sh. The lock lives at <deploy_dir>/state/update.lock; a
# second invocation fails FAST with the holder's identity — it never waits,
# so an automation retry cannot queue a stale update behind a live one.
#
#   synap_update_lock <deploy_dir> <operation>   # 0 = held, 1 = busy/failed
#
# Implementation: `flock -n` on fd 9 (util-linux; every pod host). The kernel
# releases it when the process — and every child holding fd 9 — exits, so it
# can never go stale. Hosts without flock (macOS dev installs) fall back to an
# atomic `mkdir` lock whose owner pid is checked for liveness.
# SYNAP_LOCK_IMPL=mkdir forces the fallback (tests exercise both on Linux).
# ============================================================================

_synap_lock_busy() {
    echo "❌ Another Synap pod operation is already running against this deploy dir." >&2
    echo "   Holder: ${2:-unknown}" >&2
    echo "   Refusing to start '${1}' concurrently — wait for it to finish, then re-run." >&2
    [ -n "${3:-}" ] && echo "   If no synap / eve / update-pod process is running, remove ${3} and re-run." >&2
    return 0
}

synap_update_lock() {
    _sul_dir="$1"; _sul_op="${2:-operation}"
    [ -n "$_sul_dir" ] || return 0
    mkdir -p "$_sul_dir/state" || { echo "❌ cannot create $_sul_dir/state for the update lock" >&2; return 1; }
    _sul_file="$_sul_dir/state/update.lock"
    _sul_owner="$_sul_op pid=$$ since=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    if [ "${SYNAP_LOCK_IMPL:-}" != mkdir ] && command -v flock >/dev/null 2>&1; then
        exec 9>>"$_sul_file" || { echo "❌ cannot open $_sul_file" >&2; return 1; }
        if ! flock -n 9; then
            _synap_lock_busy "$_sul_op" "$(cat "$_sul_file" 2>/dev/null)"
            return 1
        fi
        printf '%s\n' "$_sul_owner" > "$_sul_file"
        return 0
    fi

    if [ "${SYNAP_LOCK_IMPL:-}" != mkdir ] && [ "$(uname -s 2>/dev/null)" = Linux ]; then
        echo "⚠️  flock not found — using a mkdir lock, which does NOT exclude a flock holder (install util-linux)." >&2
    fi
    _sul_d="$_sul_file.d"
    if ! mkdir "$_sul_d" 2>/dev/null; then
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
