#!/usr/bin/env bash
# Tripwire: no command that destroys Docker volumes next to the update doors.
#
# 2026-10-02 a pod's database was wiped during an update episode that ended in
# `docker system prune -a --volumes`. A stopped stack's postgres/minio/kratos
# volumes are "unused" to Docker, so any volume prune — and any `down -v` —
# within reach of an update is one keystroke from that again (update-door plan
# P0, 2026-10-04). This scans for:
#   prune ... --volumes   |   volume prune ('volume', 'prune')   |   down ... --volumes / -v
# and fails unless the line is in the ALLOWLIST below.
#
# Scanned set is DERIVED, never hand-listed:
#   • this repo: every *.sh (any depth) + the `synap` CLI — git-tracked or
#     untracked-not-ignored files, minus node_modules/dist
#   • sibling checkouts when present (../hestia-cli, ../synap-cli, or the
#     space-separated paths in NO_VOLUME_PRUNE_SIBLINGS): every *.ts/*.tsx/*.js/
#     *.mjs/*.cjs/*.sh under them (same git-aware listing, so gitignored
#     bundles such as hestia's .release/ are skipped), minus tests. CI checks out
#     only this repo, so there the siblings are reported as skipped.
#
# What it does NOT see (measured, not implied):
#   • a command split across lines (`'down',\n '--volumes'`) — line-granular;
#   • full-line comments (# // * /*) are skipped on purpose (they document the ban);
#   • test files (*.test.*, test/, __tests__/) in every repo — they assert on these strings;
#   • a volume removal spelled another way (`docker volume rm`, an API call).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="deploy/__tests__/no-volume-prune.test.sh"
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

PATTERN="prune[^|;&]*--volumes|volume['\", ]+prune|(^|[^a-z])down([^a-z|;&][^|;&]*)?(--volumes|[[:space:]'\"]-v([[:space:]'\",]|\$))"

# ALLOWLIST — "<repo>|<path>|<expected count>|<exact trimmed line>". Each entry is
# a deliberate, confirmed data-deletion door; an entry that no longer matches
# its count FAILS too, so the list cannot rot or silently widen.
ALLOWLIST=(
  # The ONE Synap wipe door: typed pod domain + verified pgdata backup first, this
  # compose project's volumes only (never a global prune).
  "backend|synap|1|docker compose down --volumes --remove-orphans # volume-destroy-allowlisted: synap reset --full --delete-data"
  # Local dev stack reset (scripts/debug.sh reset, typed 'yes'); project-scoped.
  "backend|scripts/debug.sh|1|docker compose down -v"
  # `eve purge`: the documented "delete everything Eve installed" door, typed
  # 'purge'. NB no backup first — follow-up, out of P0 scope.
  "hestia-cli|packages/eve-cli/src/commands/manage/purge.ts|1|await execa('docker', ['compose', '-p', project, 'down', '--volumes', '--remove-orphans'], {"
  # `eve remove <component>` for NON-Synap components (traefik, openwebui,
  # openwebui-pipelines); Synap keeps its volumes (removeSynap / keepVolumes).
  "hestia-cli|packages/eve-cli/src/commands/remove.ts|3|await execa('docker', ['compose', 'down', '--volumes'], {"
  "hestia-cli|packages/@eve/lifecycle/src/index.ts|1|keepVolumes ? [\"compose\", \"down\"] : [\"compose\", \"down\", \"--volumes\"],"
)

matches() { grep -Eq -- "$PATTERN" <<<"$1"; }

# ── self-check: the matcher still sees what it hunts, and nothing benign ──────
for s in "docker system prune -a -f --volumes" "docker volume prune -f" "docker compose down --volumes --remove-orphans" \
         "docker compose down -v" "\$COMPOSE down -v --remove-orphans" "await execa('docker', ['system', 'prune', '-a', '-f', '--volumes'])" \
         "execa('docker', ['volume', 'prune', '-f'])" "['compose', 'down', '--volumes']" "['compose', 'down', '-v']"; do
  matches "$s" || bad "self-check: pattern misses: $s"
done
for s in "docker image prune -a -f" "docker compose down --remove-orphans" "docker system prune -a -f" "docker builder prune -f" \
         "shutdown -v" "echo countdown" "docker compose run --rm -v ./x:/x backend" \
         "grep -E 'compose down|docker rm' f | grep -v '^#'" "docker system prune -a -f; docker run --volumes-from x img"; do
  matches "$s" && bad "self-check: pattern flags benign: $s"
done

# ── derive the scanned set ────────────────────────────────────────────────────
SCAN="$(mktemp)"; HITS="$(mktemp)"; trap 'rm -f "$SCAN" "$HITS"' EXIT
add_files() { # <label> <root> <ERE on the relative path>
  local label="$1" root="$2" re="$3"
  # Tracked + untracked-but-not-ignored files (so a gitignored build/release
  # bundle like hestia's .release/ is not scanned); plain find outside git.
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$root" ls-files --cached --others --exclude-standard
  else
    (cd "$root" && find . \( -name node_modules -o -name .git \) -prune -o -type f -print | sed 's|^\./||')
  fi | grep -Ev '(^|/)(node_modules|dist|\.turbo|\.next)/' | grep -E -- "$re" \
     | while read -r f; do [ -f "$root/$f" ] && printf '%s|%s|%s\n' "$label" "$root" "$f"; done >> "$SCAN"
}
add_files backend "$HERE" '(\.sh$|^synap$)'

siblings="${NO_VOLUME_PRUNE_SIBLINGS:-$HERE/../hestia-cli $HERE/../synap-cli}"
for sib in $siblings; do
  if [ ! -d "$sib" ]; then echo "skip - sibling not present: $sib"; continue; fi
  label="$(basename "$(cd "$sib" && pwd)")"
  case "$label" in *eve*|*hestia*) label=hestia-cli ;; *cli*) label=synap-cli ;; esac
  before=$(wc -l < "$SCAN")
  add_files "$label" "$(cd "$sib" && pwd)" '\.(ts|tsx|js|mjs|cjs|sh)$'
  n=$(( $(wc -l < "$SCAN") - before ))
  [ "$n" -ge 10 ] && ok "sibling $label scanned ($n files)" || bad "sibling $label: only $n files scanned (scan broken?)"
done

# Tests assert presence/absence of these commands by design (fake-docker
# fixtures, expected argv) — they never run against a pod. Dropped for every repo.
awk -F'|' '$3 !~ /(\.test\.|\.spec\.|(^|\/)test\/|__tests__\/)/' "$SCAN" > "$SCAN.f" && mv "$SCAN.f" "$SCAN"

# ── non-vacuity: the set must contain the doors this exists for ───────────────
backend_n=$(grep -c '^backend|' "$SCAN")
[ "$backend_n" -ge 30 ] && ok "scanned $backend_n backend files" || bad "only $backend_n backend files scanned (expected >= 30)"
for must in "backend|$HERE|synap" "backend|$HERE|deploy/update-pod.sh" "backend|$HERE|deploy/pgdata-safety.sh"; do
  grep -qxF "$must" "$SCAN" && ok "scan includes ${must##*|}" || bad "scan is missing ${must##*|}"
done

# ── scan ──────────────────────────────────────────────────────────────────────
while IFS='|' read -r label root f; do
  [ "$f" = "$SELF" ] && [ "$label" = backend ] && continue
  grep -nE -- "$PATTERN" "$root/$f" 2>/dev/null | while IFS= read -r hit; do
    lineno="${hit%%:*}"; text="${hit#*:}"
    trimmed="$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$text")"
    case "$trimmed" in '#'*|'//'*|'*'*|'/*'*) continue ;; esac
    printf '%s|%s|%s|%s\n' "$label" "$f" "$lineno" "$trimmed"
  done
done < "$SCAN" > "$HITS"

seen_labels="$(cut -d'|' -f1 "$SCAN" | sort -u)"
for entry in "${ALLOWLIST[@]}"; do
  IFS='|' read -r a_label a_path a_count a_line <<<"$entry"
  grep -qx "$a_label" <<<"$seen_labels" || { echo "skip - allowlist entry for absent $a_label: $a_path"; continue; }
  got=0
  while IFS='|' read -r h_label h_path _ h_line; do
    [ "$h_label" = "$a_label" ] && [ "$h_path" = "$a_path" ] && [ "$h_line" = "$a_line" ] && got=$((got + 1))
  done < "$HITS"
  [ "$got" = "$a_count" ] && ok "allowlisted ($a_count) $a_label:$a_path" \
    || bad "allowlist entry $a_label:$a_path expected $a_count match(es), found $got — update the entry deliberately"
done

unexpected=0
while IFS='|' read -r label f lineno rest; do
  allowed=0
  for entry in "${ALLOWLIST[@]}"; do
    IFS='|' read -r a_label a_path _ a_line <<<"$entry"
    [ "$label" = "$a_label" ] && [ "$f" = "$a_path" ] && [ "$rest" = "$a_line" ] && { allowed=1; break; }
  done
  if [ "$allowed" = 0 ]; then
    bad "volume-destroying command: $label:$f:$lineno: $rest"
    unexpected=$((unexpected + 1))
  fi
done < "$HITS"
[ "$unexpected" = 0 ] && ok "no volume-destroying command outside the allowlist ($(wc -l < "$HITS" | tr -d ' ') allowlisted hit(s))"
exit $fail
