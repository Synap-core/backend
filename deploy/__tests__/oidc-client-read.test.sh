#!/usr/bin/env bash
# The installer's read of the CP-pushed OIDC client for the Kratos render.
#
# Runs the REAL lines from `synap` (sliced between the "# 2. Read the pushed
# client" comment and the `case … senc:` guard) against a fake `docker`:
#   1. the backend's field-crypto CLI answers        → its line is used
#   2. older image, no CLI → psql fallback (plaintext) → the psql line is used
#   3. psql returns a ciphertext (`senc:`)            → nothing is rendered
#   4. the CLI answers                                → psql is never called
#   5. the CLI prints JSON log lines BEFORE the row   → the row is used, not a log
#      line (the backend's config logger writes to stdout; `head -1` once
#      rendered a log line into kratos.yml and Kratos crash-looped, 2026-10-14)
#   6. the CLI prints only log lines (no client)      → psql fallback
#   7. nothing row-shaped anywhere                    → empty (sign-in stays disabled)
# Does NOT cover: the cut -d'|' parsing after it, or the CLI itself (that is
# packages/api/src/scripts/field-crypto-cli.ts, covered by its own tests).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="${OIDC_TEST_INSTALLER:-$SCRIPT_DIR/../../synap}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Slice the block; fail loudly if the anchors moved (non-vacuity).
awk '/# 2\. Read the pushed client/{on=1} on{print} on&&/never render a ciphertext into Kratos/{exit}' \
  "$INSTALLER" > "$TMP/block.sh"
grep -q 'field-crypto.js federation-oidc-client' "$TMP/block.sh" || { echo "FAIL: slice lost the CLI read"; exit 1; }
grep -q 'psql' "$TMP/block.sh" || { echo "FAIL: slice lost the psql fallback"; exit 1; }
grep -q "senc:" "$TMP/block.sh" || { echo "FAIL: slice lost the ciphertext guard"; exit 1; }
grep -q '_oidc_line' "$TMP/block.sh" || { echo "FAIL: slice lost the row-shape filter"; exit 1; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
# fake: `docker compose exec -T <svc> …`; behaviour from $FAKE_CLI / $FAKE_PSQL
echo "$4" >> "$FAKE_LOG"
case "$4" in
  backend)  [ "$FAKE_CLI" = "absent" ] && exit 1; printf '%b\n' "$FAKE_CLI" ;;
  postgres) printf '%b\n' "$FAKE_PSQL" ;;
esac
SH
chmod +x "$TMP/bin/docker"

# The block runs inside a function, as in the installer (it declares `local`s).
{ echo "f() {"; echo "_row=''"; cat "$TMP/block.sh"; echo; echo 'printf "%s" "$_row"'; echo "}"; echo f; } > "$TMP/run.sh"
run() { # $1 cli  $2 psql → prints _row
  FAKE_CLI="$1" FAKE_PSQL="$2" FAKE_LOG="$TMP/log" PATH="$TMP/bin:$PATH" bash "$TMP/run.sh"
}
fail=0
check() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1: got [$2] want [$3]"; fail=1; fi; }

: > "$TMP/log"
check "CLI line is used"            "$(run 'cid|plain-secret|https://iss' 'x|psql|y')" 'cid|plain-secret|https://iss'
check "the CLI was asked (non-vacuity)"       "$(grep -c backend "$TMP/log" || true)" "1"
check "psql not called when the CLI answers" "$(grep -c postgres "$TMP/log" || true)" "0"
check "older image falls back to psql" "$(run absent 'cid|plain-secret|https://iss')" 'cid|plain-secret|https://iss'
check "a ciphertext is never rendered" "$(run absent 'cid|senc:1:k1:abc|https://iss')" ''
LOG='{"level":"info","msg":"Configuration loaded","server":{"port":4000}}'
check "log lines before the row: the row is used" "$(run "$LOG\\n$LOG\\ncid|plain-secret|https://iss" 'x|psql|https://y')" 'cid|plain-secret|https://iss'
check "only log lines from the CLI: psql fallback" "$(run "$LOG" 'cid|plain-secret|https://iss')" 'cid|plain-secret|https://iss'
check "nothing row-shaped: empty, sign-in stays off" "$(run "$LOG" "$LOG")" ''

[ "$fail" = 0 ] && echo "oidc-client-read: ok" || { echo "oidc-client-read: FAIL"; exit 1; }
