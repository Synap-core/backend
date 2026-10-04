#!/usr/bin/env bash
# Tripwire: deploy/.env has ONE writer, and nobody runs an unpinned compose
# against the pod's deploy dir (update-door plan P4, 2026-10-04).
#
# Five .env writers once validated nothing (a `sed` set PUBLIC_URL to a dead
# domain); a bare `docker compose` in deploy/ runs under the directory's name
# ("deploy") — the stray-stack mechanism. The one writer is deploy/env-config.sh
# (`synap config set|unset`, configure-pod.sh, install.sh's _set_env_value).
#
# Part A — THIS repo: every *.sh, `synap` and install.sh (git-tracked or
#   untracked-not-ignored, minus tests and env-config.sh itself) is scanned for
#   a write whose DESTINATION is a .env file: `> .env`, `>> .env`, `sed -i … .env`,
#   `cp|mv … .env` (destination = last argument). Each hit must be in ALLOWLIST.
# Part B — sibling repos when present (../hestia-cli, ../synap-cli, or the
#   space-separated paths in ONE_ENV_WRITER_SIBLINGS): every *.ts/*.tsx/*.js/
#   *.mjs/*.cjs/*.sh is scanned for (1) a file write on an env path
#   (writeFileSync/writeFile/appendFile[Sync] on a line naming env, or
#   writeEnvVar) and (2) a compose invocation ('compose', '<arg>' argv or an
#   exec of a "docker compose …" string) with no `-p` / `--project-name` —
#   counted only when a Synap pod-dir MARKER sits on the hit's line or within
#   the WINDOW lines above it (other components' compose calls in the same
#   file are not the pod's). CI checks out only this repo, so there the
#   siblings are reported as skipped.
#
# What it does NOT see (measured, not implied):
#   • a shell write to a .env held in a variable (`>> "$env_file"`) — the
#     destination must name `.env` literally;
#   • line-granular: a call split across lines whose `-p` sits on another line
#     is flagged (allowlist it); a write whose env path is built on another
#     line from the write call is NOT seen;
#   • a sibling call that reaches the pod dir with no MARKER in the WINDOW
#     above it (e.g. a deployDir passed in from another function) — and,
#     conversely, a non-pod call that happens to sit near a MARKER is flagged;
#   • full-line comments and user-facing message lines (log/print/Error/…)
#     are skipped on purpose; test files are skipped in every repo.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="deploy/__tests__/one-env-writer.test.sh"
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# Destination-is-.env shell writes.
SH_WRITE='(>>?)[[:space:]]*"?[$A-Za-z0-9_{}/.-]*\.env"?([[:space:]]|$|;|\))|sed -i[^;&]*[[:space:]]"?[$A-Za-z0-9_{}/.-]*\.env"?([[:space:]]|$)|(^|[[:space:](])(cp|mv)( -[a-zA-Z]+)* [^|;&]*[[:space:]]"?[$A-Za-z0-9_{}/.-]*\.env"?[[:space:]]*(\|\||&&|;|\)|$)'
MARKERS='synap-backend/deploy|/opt/synap-backend|findPodDeployDir|findSynapDeployDir|SYNAP_DEPLOY_DIR|resolveSynapDelegate|resolveSynapDeployDir|synapPod\.deployDir|paths\.deployDir|synapDeployDir'
WINDOW=30   # a hit counts when a MARKER is on its line or within the WINDOW lines above it
TS_WRITE='((writeFileSync|writeFile|appendFileSync|appendFile)\(.*[eE]nv)|writeEnvVar\('
TS_COMPOSE="['\"]compose['\"],[[:space:]]*['\"]|(execSync|exec|execa|spawnSync|spawn)\([^)]*docker compose "
PINNED="['\"]-p['\"]| -p |--project-name"
MESSAGE='(log\.|print[A-Z]|console\.|Error\(|warn\(|info\(|dim\(|line:|label:|description|summary:|message:)'

# ALLOWLIST — "<repo>|<path>|<expected count>|<exact trimmed line>". An entry
# whose count no longer matches FAILS too, so the list cannot rot or widen.
ALLOWLIST=(
  # The install generators: a FRESH .env with generated secrets, written only
  # when none exists (synap install / install.sh).
  "backend|synap|1|cat > .env <<EOF"
  "backend|install.sh|1|cat > \"\$INSTALL_DIR/.env\" << ENV_EOF"
  # The release block (managed by the engine; same atomic tmp+mv shape).
  "backend|install.sh|1|chmod 600 \"\$INSTALL_DIR/.env.tmp\" && mv -f \"\$INSTALL_DIR/.env.tmp\" \"\$INSTALL_DIR/.env\""
  # The update engine's rollback restores the .env it snapshotted itself.
  "backend|synap|1|cp -p state/update/env.before .env || status=rollback_failed"
  # `synap config edit`: replaces .env with the operator's draft only after it validated.
  "backend|synap|1|mv -f \"\$draft\" .env"
  # Fresh-host restore door: the snapshot's own .env (verified, previous one kept).
  "backend|deploy/pgdata-safety.sh|1|(umask 077 && cp \"\$stage\$_BK_CT_DEPLOY/.env\" \"\$deploy/.env\") || return 1"
  # synap.sh (`./synap.sh deploy --zeroclaw`) appends to the INTELLIGENCE
  # service's deploy/.env, not the pod's.
  "backend|synap.sh|1|echo \"\" >> \"\$INTELLIGENCE_DIR/deploy/.env\""
  "backend|synap.sh|1|echo \"# ZeroClaw Bridge\" >> \"\$INTELLIGENCE_DIR/deploy/.env\""
  "backend|synap.sh|1|echo \"ZEROCLAW_API_KEY=\$zckey\" >> \"\$INTELLIGENCE_DIR/deploy/.env\""
  # Legacy generator (scripts/setup-production.sh, a pre-`synap install`
  # one-shot). Follow-up: retire it; it is not a pod-update door.
  "backend|scripts/setup-production.sh|1|cat > \"\${DEPLOYMENT_ROOT}/.env\" <<EOF"
)

# ── self-check: the matchers still see what they hunt, and nothing benign ─────
shm() { grep -Eq -- "$SH_WRITE" <<<"$1"; }
for s in 'echo "X=1" >> .env' 'echo X >> "$DEPLOY/.env"' 'printf "%s" x > "$INSTALL_DIR/.env"' 'sed -i.bak "s|^K=.*|K=v|" .env' \
         'cp /tmp/x .env' 'mv -f "$tmp" "$INSTALL_DIR/.env"' '(umask 077 && cp a "$deploy/.env") || return 1'; do
  shm "$s" || bad "self-check: shell matcher misses: $s"
done
for s in 'cp -p .env state/update/env.before' 'grep "^K=" .env' 'cat .env > "$draft"' 'source .env' 'cp .env.example x'; do
  shm "$s" && bad "self-check: shell matcher flags benign: $s"
done
grep -Eq "$TS_WRITE" <<<"writeFileSync(envPath, merged, { mode: 0o600 });" || bad "self-check: TS write matcher misses writeFileSync(envPath…)"
grep -Eq "$TS_COMPOSE" <<<"await execa('docker', ['compose', 'up', '-d'], {" || bad "self-check: TS compose matcher misses an argv 'compose'"
grep -Eq "$PINNED" <<<"['compose', '-p', project, '-f', f, 'down']" || bad "self-check: pin matcher misses '-p'"
grep -Eq "$TS_COMPOSE" <<<"const x = 'composer';" && bad "self-check: TS compose matcher flags 'composer'"
grep -Eq "$TS_COMPOSE" <<<'if (dep.relation === "compose") return dep.slug;' && bad "self-check: TS compose matcher flags a \"compose\" comparison"
grep -Eq "$TS_COMPOSE" <<<"execSync('docker compose up -d', {" || bad "self-check: TS compose matcher misses execSync('docker compose …')"

# ── derive the scanned set ────────────────────────────────────────────────────
SCAN="$(mktemp)"; HITS="$(mktemp)"; trap 'rm -f "$SCAN" "$SCAN.f" "$HITS"' EXIT
add_files() { # <label> <root> <ERE on the relative path>
  local label="$1" root="$2" re="$3"
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$root" ls-files --cached --others --exclude-standard
  else
    (cd "$root" && find . \( -name node_modules -o -name .git \) -prune -o -type f -print | sed 's|^\./||')
  fi | grep -Ev '(^|/)(node_modules|dist|\.turbo|\.next)/' | grep -E -- "$re" \
     | while read -r f; do [ -f "$root/$f" ] && printf '%s|%s|%s\n' "$label" "$root" "$f"; done >> "$SCAN"
}
add_files backend "$HERE" '(\.sh$|^synap$)'
siblings="${ONE_ENV_WRITER_SIBLINGS:-$HERE/../hestia-cli $HERE/../synap-cli}"
for sib in $siblings; do
  if [ ! -d "$sib" ]; then echo "skip - sibling not present: $sib"; continue; fi
  label="$(basename "$(cd "$sib" && pwd)")"
  case "$label" in *eve*|*hestia*) label=hestia-cli ;; *cli*) label=synap-cli ;; esac
  before=$(wc -l < "$SCAN")
  add_files "$label" "$(cd "$sib" && pwd)" '\.(ts|tsx|js|mjs|cjs|sh)$'
  n=$(( $(wc -l < "$SCAN") - before ))
  [ "$n" -ge 10 ] && ok "sibling $label scanned ($n files)" || bad "sibling $label: only $n files scanned (scan broken?)"
done
awk -F'|' '$3 !~ /(\.test\.|\.spec\.|(^|\/)test\/|__tests__\/)/ && $3 != "deploy/env-config.sh"' "$SCAN" > "$SCAN.f" && mv "$SCAN.f" "$SCAN"

backend_n=$(grep -c '^backend|' "$SCAN")
[ "$backend_n" -ge 30 ] && ok "scanned $backend_n backend files" || bad "only $backend_n backend files scanned (expected >= 30)"
for must in synap install.sh deploy/configure-pod.sh deploy/update-agent.sh deploy/pgdata-safety.sh; do
  grep -qxF "backend|$HERE|$must" "$SCAN" && ok "scan includes $must" || bad "scan is missing $must"
done

# ── scan ──────────────────────────────────────────────────────────────────────
trimmed() { sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$1"; }
while IFS='|' read -r label root f; do
  [ "$f" = "$SELF" ] && [ "$label" = backend ] && continue
  if [ "$label" = backend ]; then
    grep -nE -- "$SH_WRITE" "$root/$f" 2>/dev/null | while IFS= read -r hit; do
      t="$(trimmed "${hit#*:}")"
      case "$t" in '#'*) continue ;; esac
      printf '%s|%s|%s|env-write|%s\n' "$label" "$f" "${hit%%:*}" "$t"
    done
    continue
  fi
  grep -qE -- "$MARKERS" "$root/$f" 2>/dev/null || continue
  marker_lines=" $(grep -nE -- "$MARKERS" "$root/$f" | cut -d: -f1 | tr '\n' ' ')"
  grep -nE -- "$TS_WRITE|$TS_COMPOSE" "$root/$f" 2>/dev/null | while IFS= read -r hit; do
    ln="${hit%%:*}"; near=0
    for m in $marker_lines; do [ "$m" -le "$ln" ] && [ "$m" -ge $((ln - WINDOW)) ] && { near=1; break; }; done
    [ "$near" = 1 ] || continue
    t="$(trimmed "${hit#*:}")"
    case "$t" in '#'*|'//'*|'*'*|'/*'*) continue ;; esac
    if grep -Eq -- "$TS_WRITE" <<<"$t"; then
      printf '%s|%s|%s|env-write|%s\n' "$label" "$f" "${hit%%:*}" "$t"
    elif ! grep -Eq -- "$PINNED" <<<"$t" && ! grep -Eq -- "$MESSAGE" <<<"$t"; then
      printf '%s|%s|%s|unpinned-compose|%s\n' "$label" "$f" "${hit%%:*}" "$t"
    fi
  done
done < "$SCAN" > "$HITS"

seen_labels="$(cut -d'|' -f1 "$SCAN" | sort -u)"
for entry in "${ALLOWLIST[@]}"; do
  IFS='|' read -r a_label a_path a_count a_line <<<"$entry"
  grep -qx "$a_label" <<<"$seen_labels" || { echo "skip - allowlist entry for absent $a_label: $a_path"; continue; }
  got=0
  while IFS='|' read -r h_label h_path _ _ h_line; do
    [ "$h_label" = "$a_label" ] && [ "$h_path" = "$a_path" ] && [ "$h_line" = "$a_line" ] && got=$((got + 1))
  done < "$HITS"
  [ "$got" = "$a_count" ] && ok "allowlisted ($a_count) $a_label:$a_path" \
    || bad "allowlist entry $a_label:$a_path expected $a_count match(es), found $got — update the entry deliberately"
done

unexpected=0
while IFS='|' read -r label f lineno kind rest; do
  allowed=0
  for entry in "${ALLOWLIST[@]}"; do
    IFS='|' read -r a_label a_path _ a_line <<<"$entry"
    [ "$label" = "$a_label" ] && [ "$f" = "$a_path" ] && [ "$rest" = "$a_line" ] && { allowed=1; break; }
  done
  if [ "$allowed" = 0 ]; then
    bad "$kind outside the config door: $label:$f:$lineno: $rest"
    unexpected=$((unexpected + 1))
  fi
done < "$HITS"
[ "$unexpected" = 0 ] && ok "no .env write or unpinned compose outside the door ($(wc -l < "$HITS" | tr -d ' ') allowlisted hit(s))"
exit $fail
