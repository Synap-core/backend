#!/usr/bin/env bash
# Tripwire: `synap users reset-password|add-admin` must pass the secret on STDIN
# only. Runs the real cmd_users against a fake `docker` that records its argv
# and stdin. A password with quotes/spaces/$ proves no shell interpolation.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

mkdir -p "$TMP/bin" "$TMP/deploy"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_ARGV"
cat > "$FAKE_STDIN"
D
chmod +x "$TMP/bin/docker"
export FAKE_ARGV="$TMP/argv" FAKE_STDIN="$TMP/stdin"

# Extract only the helper + cmd_users from the CLI and run them in isolation.
extract() { awk '/^synap_users_secret\(\) \{/{p=1} p{print} p&&/^}/&&++n==2{exit}' "$HERE/synap"; }
{
  echo 'RED=;YELLOW=;BLUE=;NC=;GREEN=;'
  echo 'synap_assume_yes(){ return 1; }'
  echo "get_deploy_dir(){ echo '$TMP/deploy'; }"
  extract
} > "$TMP/lib.sh"
grep -q 'cmd_users()' "$TMP/lib.sh" || { bad "could not extract cmd_users (extraction broken)"; exit 1; }

PW="S3cret pa'ss\"w\$x;rm -rf"
run() { ( cd "$TMP/deploy"; PATH="$TMP/bin:$PATH"; . "$TMP/lib.sh"; cmd_users "$@" ) 2>"$TMP/err" >/dev/null; }

# cmd_users does a cd/guard on the deploy dir; stub what it needs if present.
if run reset-password owner@example.com --password-stdin <<<"$PW"; then
  [ "$(cat "$TMP/stdin")" = "$PW" ] && ok "stdin carries the exact password" || bad "stdin mismatch"
  if grep -qF "$PW" "$TMP/argv" || grep -q "S3cret" "$TMP/argv"; then bad "password leaked into docker argv"; else ok "password absent from docker argv"; fi
  grep -qx 'sh' "$TMP/argv" && bad "sh -c interpolation still used" || ok "no sh -c"
  grep -qx 'USER_EMAIL=owner@example.com' "$TMP/argv" && ok "email passed as its own argv element" || bad "email argv"
else
  bad "reset-password --password-stdin exited non-zero: $(head -3 "$TMP/err")"
fi

# legacy positional: still works, warns
if run reset-password owner@example.com "$PW"; then
  [ "$(cat "$TMP/stdin")" = "$PW" ] && ok "legacy positional delivered via stdin" || bad "legacy stdin mismatch"
  grep -qi 'shell history' "$TMP/err" && ok "legacy positional warns" || bad "no warning"
else bad "legacy positional failed"; fi

# no tty + no flag: refuse, call docker never
rm -f "$TMP/argv"
if run reset-password owner@example.com </dev/null; then bad "ran without any password source"; else ok "no password source aborts"; fi
[ ! -e "$TMP/argv" ] && ok "docker not invoked on abort" || bad "docker invoked on abort"
exit $fail
