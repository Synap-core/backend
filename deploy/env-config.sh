#!/bin/sh
# ============================================================================
# deploy/env-config.sh — the ONE writer of deploy/.env (POSIX sh, sourced)
# ============================================================================
# WHY: five independent .env writers (synap sed, eve rewriteEnvDomain /
# reconcileEveEnv / restorePodSecrets, configure-pod.sh, synap-cli pod.ts,
# hand sed) and none validated anything — a `sed` once set PUBLIC_URL to a
# dead domain and every Control Plane token was then rejected (update-door
# plan §1.4, 2026-10-04). Now every write goes through here:
#
#   • a key must be in deploy/env.schema or referenced as ${KEY} by the compose
#     file (or its override) — PATH, NODE_VERSION and typos are refused;
#   • the value must match the key's type (deploy/env.schema);
#   • `managed` keys (the release block) belong to `synap update`; a `pin`
#     (COMPOSE_PROJECT_NAME) is never changed; an `immutable` secret that
#     already has a value needs --force (it indexes data on disk);
#   • POD_AGENT_AUDIENCE must stay equal to PUBLIC_URL (pod-agent trust);
#   • the write is atomic (temp file in the same dir + mv) and a user-facing
#     change first copies .env to .env.bak.<UTC ts> (0600, newest 10 kept);
#   • secret values are never printed — only masked.
#
# Sourced by `synap` (config / apply / doctor and its internal writers) and by
# deploy/configure-pod.sh, which runs INSIDE the pod-agent container (busybox
# sh, no bash) — hence POSIX sh. Prove changes by SOURCING it under dash
# (deploy/__tests__/config-door.test.sh does); `dash -n` alone is not enough.
#
# Callers set SYNAP_DEPLOY_DIR (default: cwd) or SYNAP_ENV_FILE / SYNAP_ENV_SCHEMA.
#
#   envcfg_set [--force] [--stdin] KEY=VALUE... | KEY VALUE     0 ok · 1 refused · 2 usage
#   envcfg_unset [--force] KEY...
#   envcfg_get KEY [--reveal]                                   masked unless --reveal
#   envcfg_validate [env-file]       one finding per line: error|KEY|message / warn|KEY|message
#   envcfg_diff [from-file] [to-file]                           masked; default newest .env.bak.* → .env
#   envcfg_services_for KEY...       compose services whose config reads one of KEYs
#   envcfg_write_raw S|U|C|R KEY [VALUE]  internal writers (no schema, no backup)
# ============================================================================

_ec_dir()     { echo "${SYNAP_DEPLOY_DIR:-$(pwd)}"; }
_ec_env()     { echo "${SYNAP_ENV_FILE:-$(_ec_dir)/.env}"; }
_ec_schema()  { echo "${SYNAP_ENV_SCHEMA:-$(_ec_dir)/env.schema}"; }
_ec_compose() {
    _ec_d="$(_ec_dir)"
    [ -f "$_ec_d/docker-compose.yml" ] && echo "$_ec_d/docker-compose.yml"
    [ -f "$_ec_d/docker-compose.override.yml" ] && echo "$_ec_d/docker-compose.override.yml"
    return 0
}
_ec_err()  { printf '%s\n' "config: $*" >&2; }
ENVCFG_BAK_KEEP="${ENVCFG_BAK_KEEP:-10}"

# ── schema ────────────────────────────────────────────────────────────────────
# <key> → "<type> <flags>" from env.schema (exact entry first, then a PREFIX*
# entry); empty when the schema does not list it.
envcfg_lookup() {
    [ -f "$(_ec_schema)" ] || return 0
    awk -v k="$1" '
        /^[ \t]*(#|$)/ { next }
        $1 == k { print $2, ($3 == "" ? "-" : $3); found = 1; exit }
        $1 ~ /\*$/ && g == "" { p = substr($1, 1, length($1) - 1); if (index(k, p) == 1) g = $2 " " ($3 == "" ? "-" : $3) }
        END { if (!found && g != "") print g }' "$(_ec_schema)"
}

# Every ${KEY} the compose file (and its override) interpolates.
envcfg_compose_keys() {
    _ec_files="$(_ec_compose)"
    [ -n "$_ec_files" ] || return 0
    # shellcheck disable=SC2086
    grep -ohE '\$\{[A-Z_][A-Z0-9_]*' $_ec_files 2>/dev/null | sed 's/^\${//' | sort -u
}

# <key> → "<type> <flags>", "str -" for a compose-only key, empty = UNKNOWN.
envcfg_meta() {
    _ec_m="$(envcfg_lookup "$1")"
    if [ -z "$_ec_m" ] && envcfg_compose_keys | grep -qx "$1"; then _ec_m="str -"; fi
    echo "$_ec_m"
}

_ec_has_flag() { # <flags> <flag>
    case ",$1," in *",$2,"*) return 0 ;; esac
    return 1
}

# Masking: a schema `secret`, or — for keys the schema does not type — a name
# that looks like one. Never prints any part of the value.
envcfg_is_secret() {
    _ec_s="$(envcfg_lookup "$1")"
    if [ -n "$_ec_s" ]; then _ec_has_flag "${_ec_s#* }" secret && return 0; return 1; fi
    case "$1" in *SECRET*|*PASSWORD*|*TOKEN*|*_KEY|*_KEYS|*CIPHER*|*COOKIE*|*CREDENTIAL*) return 0 ;; esac
    return 1
}
envcfg_mask() { # <key> <value>
    if [ -z "$2" ]; then printf '%s' "(empty)"
    elif envcfg_is_secret "$1"; then printf '%s' "********"
    else printf '%s' "$2"; fi
}

# ── value checks ──────────────────────────────────────────────────────────────
_ec_re() { printf '%s\n' "$2" | grep -Eq "$1"; }
_ec_local_host() { # host part is localhost / *.localhost / IPv4
    case "$1" in localhost|*.localhost) return 0 ;; esac
    _ec_re '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' "$1"
}

# <type> <value> → prints the reason and returns 1 when invalid. Empty is valid
# for every type (unset); `required` is judged by validate, not here.
envcfg_type_error() {
    _ec_t="$1"; _ec_v="$2"
    [ -n "$_ec_v" ] || return 0
    case "$_ec_t" in
        str|"") return 0 ;;
        token)
            case "$_ec_v" in *[[:space:]\'\"\$\`\\\#]*) echo "must not contain whitespace, quotes, \$, \`, \\ or #"; return 1 ;; esac ;;
        int)   _ec_re '^[0-9]+$' "$_ec_v" || { echo "must be a whole number"; return 1; } ;;
        bool)  case "$_ec_v" in true|false|1|0) ;; *) echo "must be true, false, 1 or 0"; return 1 ;; esac ;;
        host)  _ec_re '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$' "$_ec_v" \
                   || { echo "must be a bare hostname (no scheme, port or path) — got '$_ec_v'"; return 1; } ;;
        email) _ec_re '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' "$_ec_v" || { echo "must be an email address"; return 1; } ;;
        origin)
            _ec_re '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$' "$_ec_v" \
                || { echo "must be http(s)://host[:port] with no path or trailing slash — got '$_ec_v'"; return 1; }
            case "$_ec_v" in
                http://*)
                    _ec_h="${_ec_v#http://}"; _ec_h="${_ec_h%%:*}"
                    _ec_local_host "$_ec_h" || { echo "must use https:// (http is only for localhost or an IP) — got '$_ec_v'"; return 1; } ;;
            esac ;;
        httpsurl)
            _ec_re '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^?#@[:space:]]*[^/?#@[:space:]])?$' "$_ec_v" \
                || { echo "must be a canonical https:// URL (no trailing slash, query, fragment or credentials) — got '$_ec_v'"; return 1; } ;;
        url)   _ec_re '^https?://[A-Za-z0-9._~%-]+(:[0-9]+)?([/?#][^[:space:]]*)?$' "$_ec_v" \
                   || { echo "must be an http(s):// URL"; return 1; } ;;
        list)  case "$_ec_v" in *[[:space:]]*) echo "must be comma-separated with no whitespace"; return 1 ;; esac ;;
        name)  _ec_re '^[a-z0-9][a-z0-9_-]*$' "$_ec_v" || { echo "must match [a-z0-9][a-z0-9_-]*"; return 1; } ;;
        size)  _ec_re '^[0-9]+[A-Za-z]*$' "$_ec_v" || { echo "must be a number with an optional unit (100MB)"; return 1; } ;;
        image) case "$_ec_v" in *[[:space:]]*) echo "must be an image reference"; return 1 ;; esac ;;
        enum:*)
            _ec_ok=1; _ec_rest="${_ec_t#enum:}|"
            while [ -n "$_ec_rest" ]; do
                [ "${_ec_rest%%|*}" = "$_ec_v" ] && { _ec_ok=0; break; }
                _ec_rest="${_ec_rest#*|}"
            done
            [ "$_ec_ok" = 0 ] || { echo "must be one of: $(echo "${_ec_t#enum:}" | sed 's/|/, /g')"; return 1; } ;;
        *) echo "schema type '$_ec_t' is unknown to env-config.sh"; return 1 ;;
    esac
    return 0
}

# Control characters (newline, tab, CR, ESC...) break the line format.
_ec_has_ctrl() {
    [ "$(printf '%s' "$1" | wc -c)" != "$(printf '%s' "$1" | tr -d '\001-\037\177' | wc -c)" ]
}

# The .env line for <key> <value>: bare when every character is safe for
# compose and the CLI's `cut -d= -f2-` readers, single-quoted otherwise
# (compose reads '…' literally — no $ interpolation). A value that needs
# quoting AND contains ' cannot be stored safely: the caller refused it.
_ec_render() {
    case "$2" in
        *[!A-Za-z0-9_./:@,+=%~^*!?-]*) printf "%s='%s'\n" "$1" "$2" ;;
        *) printf '%s=%s\n' "$1" "$2" ;;
    esac
}
_ec_needs_quote() { case "$1" in *[!A-Za-z0-9_./:@,+=%~^*!?-]*) return 0 ;; esac; return 1; }

# ── reading ───────────────────────────────────────────────────────────────────
# <key> [file] — LAST assignment wins (as compose reads it), one pair of
# surrounding quotes removed. Leading whitespace before the key is tolerated.
envcfg_value() {
    _ec_f="${2:-$(_ec_env)}"
    [ -f "$_ec_f" ] || return 0
    awk -v k="$1" -v q="'" '
        { l = $0; sub(/^[ \t]+/, "", l) }
        index(l, k "=") == 1 { v = substr(l, length(k) + 2); have = 1 }
        END {
            if (!have) exit
            f = substr(v, 1, 1)
            if (length(v) >= 2 && (f == "\"" || f == q) && substr(v, length(v), 1) == f) v = substr(v, 2, length(v) - 2)
            print v
        }' "$_ec_f"
}
envcfg_has_key() { # <key> [file]
    [ -f "${2:-$(_ec_env)}" ] || return 1
    sed 's/^[ \t]*//' "${2:-$(_ec_env)}" | grep -q "^$1="
}
# The KEY of every assignment line, in file order (duplicates repeated).
envcfg_file_keys() {
    [ -f "${1:-$(_ec_env)}" ] || return 0
    sed -n 's/^[ \t]*\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "${1:-$(_ec_env)}"
}

envcfg_get() { # <key> [--reveal]
    [ -n "${1:-}" ] || { _ec_err "usage: config get <KEY> [--reveal]"; return 2; }
    envcfg_has_key "$1" || { _ec_err "$1 is not set in $(_ec_env)"; return 1; }
    _ec_v="$(envcfg_value "$1")"
    if [ "${2:-}" = --reveal ]; then printf '%s\n' "$_ec_v"; else envcfg_mask "$1" "$_ec_v"; echo; fi
}

# ── writing ───────────────────────────────────────────────────────────────────
_ec_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null || echo 600; }

# Copy .env to .env.bak.<UTC ts> (0600) and keep the newest ENVCFG_BAK_KEEP.
envcfg_backup() {
    _ec_e="$(_ec_env)"
    [ -f "$_ec_e" ] || return 0
    _ec_b="$_ec_e.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    [ -e "$_ec_b" ] && _ec_b="$_ec_b.$$"
    (umask 077 && cat "$_ec_e" > "$_ec_b") || { _ec_err "cannot write the backup $_ec_b — nothing was changed"; return 1; }
    chmod 600 "$_ec_b"
    ls -1 "$_ec_e".bak.* 2>/dev/null | sort -r | awk -v keep="$ENVCFG_BAK_KEEP" 'NR > keep' | while IFS= read -r _ec_old; do rm -f "$_ec_old"; done
    ENVCFG_LAST_BACKUP="$_ec_b"
}

# <edits-file> — tab-separated lines: S<TAB>KEY<TAB>LINE (set: the first
# assignment is replaced in place, later duplicates dropped, appended when
# absent) · U<TAB>KEY (unset every assignment) · C<TAB>KEY<TAB>REASON (comment
# out) · R<TAB>KEY (unset + drop "# KEY=… disabled on" markers).
# Atomic: temp file in the same directory, existing mode kept, then mv.
# Returns 0 when written, 3 when the content was already identical.
_ec_apply_edits() {
    _ec_e="$(_ec_env)"; _ec_edits="$1"
    if [ ! -f "$_ec_e" ]; then (umask 077 && : > "$_ec_e") || return 1; fi
    _ec_tmp="$(umask 077 && mktemp "$_ec_e.XXXXXX")" || { _ec_err "cannot create a temp file next to $_ec_e"; return 1; }
    ENVCFG_TODAY="$(date -u +%Y-%m-%d)" awk -F'\t' '
        NR == FNR { op[$2] = $1; arg[$2] = $3; if ($1 == "S") order[++n] = $2; next }
        {
            l = $0; sub(/^[ \t]+/, "", l); k = l; sub(/=.*/, "", k)
            if (l != k && (k in op)) {
                if (op[k] == "S") { if (!(k in done)) print arg[k]; done[k] = 1; next }
                if (op[k] == "C") { print "# " l "  # " arg[k] " on " ENVIRON["ENVCFG_TODAY"]; next }
                next
            }
            if (l ~ /^#[ \t]*[A-Za-z_][A-Za-z0-9_]*=.* disabled on /) {
                c = l; sub(/^#[ \t]*/, "", c); sub(/=.*/, "", c)
                if ((c in op) && op[c] == "R") next
            }
            print
        }
        END { for (i = 1; i <= n; i++) if (!(order[i] in done)) print arg[order[i]] }
    ' "$_ec_edits" "$_ec_e" > "$_ec_tmp" || { rm -f "$_ec_tmp"; _ec_err "rewriting $_ec_e failed — nothing was changed"; return 1; }
    if cmp -s "$_ec_tmp" "$_ec_e"; then rm -f "$_ec_tmp"; return 3; fi
    chmod "$(_ec_mode "$_ec_e")" "$_ec_tmp" 2>/dev/null || chmod 600 "$_ec_tmp"
    mv -f "$_ec_tmp" "$_ec_e" || { rm -f "$_ec_tmp"; _ec_err "could not replace $_ec_e — nothing was changed"; return 1; }
    return 0
}

# Internal writers (the synap CLI's own helpers: install backfills, federation,
# tunnel, the compose-project pin). They write keys the CLI owns, so there is
# no schema check and no backup — but the write is still atomic, leaves no
# stray .env.bak, and keeps the file mode.
envcfg_write_raw() { # S KEY VALUE | U KEY | C KEY REASON | R KEY
    _ec_ed="$(umask 077 && mktemp)" || return 1
    case "$1" in
        S) printf 'S\t%s\t%s\n' "$2" "$(_ec_render "$2" "${3:-}")" > "$_ec_ed" ;;
        C) printf 'C\t%s\t%s\n' "$2" "${3:-disabled}" > "$_ec_ed" ;;
        U|R) printf '%s\t%s\n' "$1" "$2" > "$_ec_ed" ;;
        *) rm -f "$_ec_ed"; return 2 ;;
    esac
    _ec_rc=0; _ec_apply_edits "$_ec_ed" || _ec_rc=$?
    rm -f "$_ec_ed"
    [ "$_ec_rc" = 3 ] && return 0
    return "$_ec_rc"
}

# Checks one proposed KEY=VALUE against the schema and the current file;
# prints the reason and returns 1 when refused.
_ec_check_pair() { # <key> <value> <force 0|1>
    _ec_k="$1"; _ec_v="$2"; _ec_force="$3"
    printf '%s\n' "$_ec_k" | grep -Eq '^[A-Z_][A-Z0-9_]*$' || { echo "$_ec_k: not a valid key name (A-Z, 0-9, _)"; return 1; }
    _ec_meta="$(envcfg_meta "$_ec_k")"
    if [ -z "$_ec_meta" ]; then
        echo "$_ec_k: unknown key — not in deploy/env.schema and not read by docker-compose.yml. Nothing in the pod would see it."
        return 1
    fi
    _ec_type="${_ec_meta%% *}"; _ec_flags="${_ec_meta#* }"
    if _ec_has_flag "$_ec_flags" managed; then
        echo "$_ec_k: managed by \`synap update\` (the release block) — apply a release instead"
        return 1
    fi
    _ec_cur="$(envcfg_value "$_ec_k")"
    if _ec_has_flag "$_ec_flags" pin && [ -n "$_ec_cur" ] && [ "$_ec_cur" != "$_ec_v" ]; then
        echo "$_ec_k: pinned to '$_ec_cur' — changing it points every command at a different (empty) stack. Edit .env by hand only after inspecting both projects."
        return 1
    fi
    if _ec_has_flag "$_ec_flags" immutable && [ -n "$_ec_cur" ] && [ "$_ec_cur" != "$_ec_v" ] && [ "$_ec_force" != 1 ]; then
        echo "$_ec_k: already set, and existing data is encrypted/authenticated with it — changing it is one-way data loss. Pass --force only if you are rotating it everywhere it is used."
        return 1
    fi
    if _ec_has_ctrl "$_ec_v"; then echo "$_ec_k: value contains a newline or control character"; return 1; fi
    if _ec_needs_quote "$_ec_v"; then
        case "$_ec_v" in *\'*) echo "$_ec_k: a value with spaces or special characters cannot also contain '"; return 1 ;; esac
    fi
    _ec_why="$(envcfg_type_error "$_ec_type" "$_ec_v")" || { echo "$_ec_k: $_ec_why"; return 1; }
    return 0
}

# envcfg_set [--force] [--stdin] KEY=VALUE... | KEY VALUE
# Validates EVERY pair before writing ANY (all-or-nothing), backs up, writes
# atomically, and prints what changed (masked) plus the services that must be
# recreated to see it (`synap apply`). ENVCFG_CHANGED_KEYS is left set.
envcfg_set() {
    _ec_force=0; _ec_stdin=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --force) _ec_force=1; shift ;;
            --stdin|--from-file)
                _ec_stdin=1
                if [ "$1" = --from-file ]; then
                    [ -n "${2:-}" ] || { _ec_err "--from-file needs a path ('-' = stdin)"; return 2; }
                    [ "$2" = - ] || exec 8<"$2" || return 2
                    [ "$2" = - ] && exec 8<&0
                    shift
                else
                    exec 8<&0
                fi
                shift ;;
            *) break ;;
        esac
    done
    _ec_pairs="$(umask 077 && mktemp)" || return 1
    if [ "$_ec_stdin" = 1 ]; then
        while IFS= read -r _ec_line <&8 || [ -n "$_ec_line" ]; do
            case "$_ec_line" in ''|'#'*) continue ;; esac
            case "$_ec_line" in *=*) ;; *) _ec_err "not KEY=VALUE: ${_ec_line%%=*}"; rm -f "$_ec_pairs"; return 2 ;; esac
            _ec_k="${_ec_line%%=*}"; _ec_v="${_ec_line#*=}"
            case "$_ec_v" in \"*\") _ec_v="${_ec_v#\"}"; _ec_v="${_ec_v%\"}" ;; \'*\') _ec_v="${_ec_v#\'}"; _ec_v="${_ec_v%\'}" ;; esac
            printf '%s\t%s\n' "$_ec_k" "$_ec_v" >> "$_ec_pairs"
        done
        exec 8<&-
    elif [ $# -eq 2 ] && case "$1" in *=*) false ;; *) true ;; esac; then
        printf '%s\t%s\n' "$1" "$2" >> "$_ec_pairs"                 # legacy: set KEY VALUE
    else
        [ $# -gt 0 ] || { _ec_err "usage: config set [--force] KEY=VALUE... | KEY VALUE | --stdin"; rm -f "$_ec_pairs"; return 2; }
        for _ec_a in "$@"; do
            case "$_ec_a" in *=*) ;; *) _ec_err "not KEY=VALUE: $_ec_a"; rm -f "$_ec_pairs"; return 2 ;; esac
            printf '%s\t%s\n' "${_ec_a%%=*}" "${_ec_a#*=}" >> "$_ec_pairs"
        done
    fi
    [ -s "$_ec_pairs" ] || { _ec_err "nothing to set"; rm -f "$_ec_pairs"; return 2; }

    # 1. every pair, every reason — nothing is written unless all pass
    _ec_bad=""
    while IFS="$(printf '\t')" read -r _ec_k _ec_v; do
        _ec_r="$(_ec_check_pair "$_ec_k" "$_ec_v" "$_ec_force")" || _ec_bad="${_ec_bad}${_ec_r}
"
    done < "$_ec_pairs"
    # 2. cross-key: the pod-agent trust anchor follows PUBLIC_URL (CP tokens carry it as aud)
    _ec_after() { _ec_x="$(awk -F'\t' -v k="$1" '$1 == k { v = $2; f = 1 } END { if (f) print v; else exit 1 }' "$_ec_pairs")" && { echo "$_ec_x"; return; }; envcfg_value "$1"; }
    _ec_pu="$(_ec_after PUBLIC_URL)"; _ec_aud="$(_ec_after POD_AGENT_AUDIENCE)"
    if [ -n "$_ec_pu" ] && [ -n "$_ec_aud" ] && [ "$_ec_pu" != "$_ec_aud" ] && [ "$_ec_force" != 1 ]; then
        _ec_bad="${_ec_bad}POD_AGENT_AUDIENCE ($_ec_aud) would differ from PUBLIC_URL ($_ec_pu): the pod-agent would reject every Control Plane command. Set both together.
"
    fi
    if [ -n "$_ec_bad" ]; then
        printf '%s' "$_ec_bad" | sed '/^$/d; s/^/config: refused — /' >&2
        _ec_err "nothing was changed."
        rm -f "$_ec_pairs"; return 1
    fi

    # 3. write
    _ec_ed="$(umask 077 && mktemp)" || { rm -f "$_ec_pairs"; return 1; }
    ENVCFG_CHANGED_KEYS=""
    while IFS="$(printf '\t')" read -r _ec_k _ec_v; do
        printf 'S\t%s\t%s\n' "$_ec_k" "$(_ec_render "$_ec_k" "$_ec_v")" >> "$_ec_ed"
        if [ "$(envcfg_value "$_ec_k")" != "$_ec_v" ] || ! envcfg_has_key "$_ec_k"; then
            ENVCFG_CHANGED_KEYS="$ENVCFG_CHANGED_KEYS $_ec_k"
            printf '%s\n' "config: set $_ec_k=$(envcfg_mask "$_ec_k" "$_ec_v")"
        fi
    done < "$_ec_pairs"
    rm -f "$_ec_pairs"
    if [ -z "$ENVCFG_CHANGED_KEYS" ]; then rm -f "$_ec_ed"; echo "config: unchanged"; return 0; fi
    envcfg_backup || { rm -f "$_ec_ed"; return 1; }
    _ec_rc=0; _ec_apply_edits "$_ec_ed" || _ec_rc=$?; rm -f "$_ec_ed"
    [ "$_ec_rc" = 3 ] && _ec_rc=0
    [ "$_ec_rc" = 0 ] || return "$_ec_rc"
    echo "config: previous .env kept as $ENVCFG_LAST_BACKUP"
    _ec_report_recreate $ENVCFG_CHANGED_KEYS
    return 0
}

envcfg_unset() { # [--force] KEY...
    _ec_force=0
    [ "${1:-}" = --force ] && { _ec_force=1; shift; }
    [ $# -gt 0 ] || { _ec_err "usage: config unset [--force] KEY..."; return 2; }
    _ec_bad=""; ENVCFG_CHANGED_KEYS=""
    for _ec_k in "$@"; do
        envcfg_has_key "$_ec_k" || continue
        _ec_meta="$(envcfg_lookup "$_ec_k")"; _ec_flags="${_ec_meta#* }"
        if _ec_has_flag "$_ec_flags" managed || _ec_has_flag "$_ec_flags" pin; then
            _ec_bad="${_ec_bad}$_ec_k is $(_ec_has_flag "$_ec_flags" pin && echo pinned || echo 'managed by synap update') — not removable here
"
        elif _ec_has_flag "$_ec_flags" immutable && [ -n "$(envcfg_value "$_ec_k")" ] && [ "$_ec_force" != 1 ]; then
            _ec_bad="${_ec_bad}$_ec_k indexes existing data — removing it is one-way data loss (--force to override)
"
        else
            ENVCFG_CHANGED_KEYS="$ENVCFG_CHANGED_KEYS $_ec_k"
        fi
    done
    if [ -n "$_ec_bad" ]; then printf '%s' "$_ec_bad" | sed '/^$/d; s/^/config: refused — /' >&2; _ec_err "nothing was changed."; return 1; fi
    [ -n "$ENVCFG_CHANGED_KEYS" ] || { echo "config: unchanged"; return 0; }
    _ec_ed="$(umask 077 && mktemp)" || return 1
    for _ec_k in $ENVCFG_CHANGED_KEYS; do printf 'U\t%s\n' "$_ec_k" >> "$_ec_ed"; echo "config: unset $_ec_k"; done
    envcfg_backup || { rm -f "$_ec_ed"; return 1; }
    _ec_rc=0; _ec_apply_edits "$_ec_ed" || _ec_rc=$?; rm -f "$_ec_ed"
    [ "$_ec_rc" = 3 ] && _ec_rc=0
    [ "$_ec_rc" = 0 ] || return "$_ec_rc"
    echo "config: previous .env kept as $ENVCFG_LAST_BACKUP"
    _ec_report_recreate $ENVCFG_CHANGED_KEYS
}

# ── recreate derivation ───────────────────────────────────────────────────────
# Compose services whose definition interpolates one of KEYs — directly, or via
# a top-level `x-…: &anchor` block merged with `<<: *anchor`. Derived from the
# compose file, never a hand list: a new service reading a key joins by existing.
envcfg_services_for() {
    _ec_files="$(_ec_compose)"
    [ -n "$_ec_files" ] && [ $# -gt 0 ] || return 0
    # shellcheck disable=SC2086
    awk -v keys=" $* " '
        /^[^ \t#]/ {
            top = $0; sub(/:.*/, "", top); inserv = (top == "services"); svc = ""; anchor = ""
            if (match($0, /&[A-Za-z0-9_-]+/)) anchor = substr($0, RSTART + 1, RLENGTH - 1)
            next
        }
        inserv && /^  [A-Za-z0-9_.-]+:[ \t]*$/ { svc = $1; sub(/:$/, "", svc); next }
        inserv && svc != "" && /<<:[ \t]*\*/ { a = $0; sub(/.*\*/, "", a); sub(/[^A-Za-z0-9_-].*/, "", a); uses[svc, a] = 1; users[svc] = 1 }
        {
            l = $0
            while (match(l, /\$\{[A-Z_][A-Z0-9_]*/)) {
                k = substr(l, RSTART + 2, RLENGTH - 2); l = substr(l, RSTART + RLENGTH)
                if (index(keys, " " k " ") == 0) continue
                if (svc != "" && inserv) hit[svc] = 1
                else if (anchor != "") ahit[anchor] = 1
            }
        }
        END {
            for (s in users) for (a in ahit) if ((s, a) in uses) hit[s] = 1
            for (s in hit) print s
        }' $_ec_files | sort -u
}

_ec_report_recreate() {
    _ec_svcs="$(envcfg_services_for "$@" | tr '\n' ' ' | sed 's/ $//')"
    if [ -n "$_ec_svcs" ]; then
        echo "config: these services read the changed keys and keep the OLD values until recreated: ${_ec_svcs}"
        echo "config: apply with: synap apply   (guarded recreate of the running services; no prune, no volume change)"
        ENVCFG_RECREATE="$_ec_svcs"
    else
        echo "config: no running container reads these keys — nothing to recreate"
        ENVCFG_RECREATE=""
    fi
}

# ── validate / diff ───────────────────────────────────────────────────────────
# One finding per line: error|KEY|message  or  warn|KEY|message. Returns 1 when
# any error was found.
envcfg_validate() {
    _ec_f="${1:-$(_ec_env)}"
    [ -f "$_ec_f" ] || { echo "error|.env|$_ec_f does not exist"; return 1; }
    _ec_out="$(umask 077 && mktemp)" || return 1
    # malformed lines (not blank, not a comment, not KEY=VALUE)
    awk '{ l = $0; sub(/^[ \t]+/, "", l) } l == "" || l ~ /^#/ { next } l !~ /^[A-Za-z_][A-Za-z0-9_]*=/ { printf "error|line %d|not KEY=VALUE: %s\n", NR, substr(l, 1, 40) }' "$_ec_f" >> "$_ec_out"
    envcfg_file_keys "$_ec_f" | sort | uniq -d | while IFS= read -r _ec_k; do
        echo "error|$_ec_k|assigned more than once (compose uses the last one; the CLI's readers may use the first)"
    done >> "$_ec_out"
    envcfg_file_keys "$_ec_f" | sort -u | while IFS= read -r _ec_k; do
        _ec_meta="$(envcfg_meta "$_ec_k")"
        if [ -z "$_ec_meta" ]; then
            echo "error|$_ec_k|unknown key: not in deploy/env.schema and not read by docker-compose.yml"
            continue
        fi
        _ec_v="$(envcfg_value "$_ec_k" "$_ec_f")"
        _ec_why="$(envcfg_type_error "${_ec_meta%% *}" "$_ec_v")" || echo "error|$_ec_k|$_ec_why"
    done >> "$_ec_out"
    awk '/^[ \t]*(#|$)/ { next } $1 !~ /\*$/ && $3 ~ /(^|,)required(,|$)/ { print $1 }' "$(_ec_schema)" 2>/dev/null | while IFS= read -r _ec_k; do
        [ -n "$(envcfg_value "$_ec_k" "$_ec_f")" ] || echo "error|$_ec_k|required but missing or empty"
    done >> "$_ec_out"
    _ec_pu="$(envcfg_value PUBLIC_URL "$_ec_f")"; _ec_dom="$(envcfg_value DOMAIN "$_ec_f")"; _ec_aud="$(envcfg_value POD_AGENT_AUDIENCE "$_ec_f")"
    if [ -n "$_ec_pu" ] && [ -n "$_ec_aud" ] && [ "$_ec_pu" != "$_ec_aud" ]; then
        echo "error|POD_AGENT_AUDIENCE|differs from PUBLIC_URL ($_ec_pu): the pod-agent rejects every Control Plane command" >> "$_ec_out"
    fi
    if [ -n "$_ec_pu" ] && [ -n "$_ec_dom" ]; then
        _ec_h="${_ec_pu#*://}"; _ec_h="${_ec_h%%[:/]*}"
        [ "$_ec_h" = "$_ec_dom" ] || echo "warn|PUBLIC_URL|host '$_ec_h' is not DOMAIN '$_ec_dom' (Kratos URLs and Caddy routing follow DOMAIN)" >> "$_ec_out"
    fi
    cat "$_ec_out"
    _ec_rc=0; grep -q '^error|' "$_ec_out" || _ec_rc=1
    rm -f "$_ec_out"
    [ "$_ec_rc" = 1 ] && return 0
    return 1
}

envcfg_diff() { # [from-file] [to-file]
    _ec_to="${2:-$(_ec_env)}"
    _ec_from="${1:-$(ls -1 "$(_ec_env)".bak.* 2>/dev/null | sort | tail -n 1)}"
    [ -n "$_ec_from" ] && [ -f "$_ec_from" ] || { _ec_err "nothing to compare with (no .env.bak.* yet) — usage: config diff [from-file] [to-file]"; return 2; }
    [ -f "$_ec_to" ] || { _ec_err "$_ec_to does not exist"; return 2; }
    echo "--- $_ec_from"
    echo "+++ $_ec_to"
    _ec_n=0
    for _ec_k in $( (envcfg_file_keys "$_ec_from"; envcfg_file_keys "$_ec_to") | sort -u); do
        _ec_a="$(envcfg_value "$_ec_k" "$_ec_from")"; _ec_b="$(envcfg_value "$_ec_k" "$_ec_to")"
        if ! envcfg_has_key "$_ec_k" "$_ec_from"; then echo "+ $_ec_k=$(envcfg_mask "$_ec_k" "$_ec_b")"; _ec_n=$((_ec_n + 1))
        elif ! envcfg_has_key "$_ec_k" "$_ec_to"; then echo "- $_ec_k"; _ec_n=$((_ec_n + 1))
        elif [ "$_ec_a" != "$_ec_b" ]; then
            if envcfg_is_secret "$_ec_k"; then echo "~ $_ec_k (secret changed)"
            else echo "~ $_ec_k: $(envcfg_mask "$_ec_k" "$_ec_a") -> $(envcfg_mask "$_ec_k" "$_ec_b")"; fi
            _ec_n=$((_ec_n + 1))
        fi
    done
    [ "$_ec_n" = 0 ] && echo "(no differences)"
    return 0
}

# Executed (not sourced): sh deploy/env-config.sh <get|set|unset|validate|diff|services> ...
case "${0##*/}" in
    env-config.sh)
        _ec_cmd="${1:-}"; [ $# -gt 0 ] && shift
        case "$_ec_cmd" in
            get) envcfg_get "$@" ;;
            set) envcfg_set "$@" ;;
            unset) envcfg_unset "$@" ;;
            validate) envcfg_validate "$@" ;;
            diff) envcfg_diff "$@" ;;
            services) envcfg_services_for "$@" ;;
            *) echo "usage: env-config.sh get|set|unset|validate|diff|services ..." >&2; exit 2 ;;
        esac
        exit $?
        ;;
esac
