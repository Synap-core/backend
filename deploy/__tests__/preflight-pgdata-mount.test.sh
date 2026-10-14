#!/usr/bin/env bash
# The update preflight names the Postgres data volume it is about to operate on.
# It used to look for the stock /var/lib/postgresql/data mount, but the pod's
# timescaledb-ha image keeps its cluster under /home/postgres/pgdata (one source:
# PGDATA_MOUNT_TARGET in deploy/pgdata-safety.sh), so every update printed
# "Could not resolve postgres_data volume mount" (perso pod, 2026-10-14).
#
# Runs the REAL _preflight_compose_check (extracted from `synap`) against a fake
# docker that answers `inspect` ONLY for a template asking about the real mount
# destination — as real docker would return nothing for the wrong destination.
# Limit: the fake matches the destination in the template text; it does not run
# Go templates, so a broken template body would not be caught here.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

mkdir -p "$TMP/bin" "$TMP/deploy"
cp "$HERE/deploy/docker-compose.yml" "$TMP/deploy/"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
case "$*" in
  "compose ps -q postgres") echo pgc123 ;;
  inspect*'eq .Destination "/home/postgres/pgdata"'*pgc123) echo "synap-backend_postgres_data" ;;
  inspect*) : ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker"

extract() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {p=1} p{print} p&&/^}/{exit}' "$HERE/synap"; }
{
  echo 'RED=;YELLOW=;BLUE=;NC=;GREEN=;'
  echo '_resolve_compose_project_name(){ echo synap-backend; }'
  grep -E '^PGDATA_MOUNT_TARGET=' "$HERE/deploy/pgdata-safety.sh"
  extract _preflight_compose_check
} > "$TMP/lib.sh"
grep -q '^_preflight_compose_check()' "$TMP/lib.sh" || { bad "could not extract _preflight_compose_check"; exit 1; }
grep -q '^PGDATA_MOUNT_TARGET=' "$TMP/lib.sh" || { bad "PGDATA_MOUNT_TARGET not found in pgdata-safety.sh"; exit 1; }

out=$(cd "$TMP" && PATH="$TMP/bin:$PATH" COMPOSE_PROJECT_NAME=synap-backend bash -c '. ./lib.sh; _preflight_compose_check deploy' 2>&1)
printf '%s\n' "$out" | grep -q 'Mounted postgres_data volume: synap-backend_postgres_data' \
  && ok "preflight: names the volume mounted at PGDATA_MOUNT_TARGET" \
  || { bad "preflight: volume not resolved"; printf '%s\n' "$out" | tail -5; }
printf '%s\n' "$out" | grep -q 'Could not resolve postgres_data' && bad "preflight: still warns" || ok "preflight: no 'Could not resolve' warning"

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
