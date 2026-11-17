#!/usr/bin/env bash
# 130e849d / 265d616e: `synap` runs under `set -e`; a bare `read -p` with no
# terminal on stdin hit EOF and exited 1 with no message. One guard now:
#   1. every prompt read in synap goes through _synap_prompt_read (derived: no
#      other `read ... -p` exists)
#   2. the guard, run with stdin not a TTY, exits non-zero AND says what to do
#   3. `install` with no TTY and no flag switches itself to --non-interactive
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# 1. no bare prompt read outside the guard's own body
# (a prompt ending `|| true` already treats EOF as "no": a safe decline, left as is)
bare="$(grep -E '^[[:space:]]*read( -[rs])* -p ' "$HERE/synap" | grep -v '|| true$' || true)"
[ -z "$bare" ] && ok "no bare 'read -p' in synap" || bad "bare prompt read(s): $bare"
n="$(grep -cE '_synap_prompt_read( -[rs])* -p ' "$HERE/synap")"
[ "$n" -ge 20 ] && ok "prompts go through _synap_prompt_read ($n)" || bad "only $n guarded prompts"

# 2. the guard itself, with stdin from /dev/null (not a TTY)
sed -n '/^_synap_prompt_read() {/,/^}/p' "$HERE/synap" > "$TMP/guard.sh"
[ -s "$TMP/guard.sh" ] || bad "guard function not found"
RED=""; NC=""
out="$(RED="" NC="" bash -c 'set -e; . "$1"; _synap_prompt_read -p "Q? " ANSWER; echo reached' _ "$TMP/guard.sh" </dev/null 2>&1)"; rc=$?
[ "$rc" != 0 ] && grep -q 'No answer on stdin' <<<"$out" && grep -q -- '--non-interactive' <<<"$out" && ! grep -q reached <<<"$out" \
  && ok "no TTY: the guard exits non-zero with a hint naming --non-interactive" || { bad "guard rc=$rc out=$out"; }

# 2b. a piped answer is still an answer (restore/clean/cancel confirm through a pipe)
out="$(bash -c 'set -e; . "$1"; _synap_prompt_read -r -p "Q? " ANSWER; echo "reached=$ANSWER"' _ "$TMP/guard.sh" <<<"yes" 2>&1)"; rc=$?
[ "$rc" = 0 ] && grep -q 'reached=yes' <<<"$out" && ok "piped answer: read and returned" || bad "piped answer rc=$rc out=$out"
out="$(printf 'example.org' | bash -c 'set -e; . "$1"; _synap_prompt_read -r -p "Q? " ANSWER; echo "reached=$ANSWER"' _ "$TMP/guard.sh" 2>&1)"; rc=$?
[ "$rc" = 0 ] && grep -q 'reached=example.org' <<<"$out" && ok "piped answer without a newline: read and returned" || bad "unterminated answer rc=$rc out=$out"

# 3. install switches itself when stdin is not a TTY and no flag was given
grep -q 'if \[ "\$INTERACTIVE" = true \] && \[ ! -t 0 \]; then' "$HERE/synap" \
  && ok "install: no TTY and no flag → --non-interactive" || bad "install has no no-TTY switch"
ln="$(grep -n 'if \[ "\$INTERACTIVE" = true \] && \[ ! -t 0 \]; then' "$HERE/synap" | head -n1 | cut -d: -f1)"
first_prompt="$(grep -nE '^[[:space:]]+_synap_prompt_read( -[rs])* -p ' "$HERE/synap" | head -n1 | cut -d: -f1)"
[ -n "$ln" ] && [ "$ln" -lt "$first_prompt" ] && ok "the switch comes before the first prompt" || bad "switch at $ln, first prompt at $first_prompt"

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
