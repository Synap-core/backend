#!/usr/bin/env bash
# The ONE .env writer: `synap config` over deploy/env-config.sh + deploy/env.schema
# (update-door plan P3, 2026-10-04).
#
# Part A — the schema is CROSS-CHECKED, never trusted on its own. Every key of
#   • deploy/.env.example (active and commented-out assignments),
#   • ${KEY} in deploy/docker-compose.yml,
#   • the .env `synap install` generates (generate_and_create_env heredoc),
#   • every key the synap CLI writes itself (envcfg_write_raw S / update_env_value),
#   • @eve/dna POD_SECRET_FIELDS — when a hestia-cli checkout sits beside this
#     repo (or ENV_SCHEMA_HESTIA points at one); CI checks out only this repo,
#     so there it is reported as skipped,
# must be in env.schema — and every schema key must still be USED by one of
# them or named in synap / deploy/*.sh / pod-agent. POD_SECRET_FIELDS keys must
# be secret+immutable; the update's critical keys must be `required`.
#
# Part B — behaviour, daemon-free: the REAL `synap` with a fake `docker`, and
# env-config.sh SOURCED under dash (the pod-agent container is busybox sh;
# `dash -n` alone once missed a bash-only construct that killed every update).
#
# Not covered (measured): a key the backend reads from process.env without the
# compose file passing it is invisible to the container anyway, so it is out of
# scope; key extraction is line-regex based (a ${KEY} split across lines is not
# seen — none exists today).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
SCHEMA="$HERE/deploy/env.schema"

# ═══ Part A: the schema against every source ═════════════════════════════════
schema_keys() { awk '/^[ \t]*(#|$)/ {next} {print $1}' "$SCHEMA"; }
in_schema() { # <key> — exact entry, or a PREFIX* entry
  schema_keys | awk -v k="$1" '$0 == k {f=1} /\*$/ {p=substr($0,1,length($0)-1); if (index(k,p)==1) f=1} END {exit !f}'
}
flags_of() { awk -v k="$1" '$1 == k {print $3}' "$SCHEMA"; }

example_keys="$(sed -nE 's/^[[:space:]]*#?[[:space:]]*([A-Z][A-Z0-9_]*)=.*/\1/p' "$HERE/deploy/.env.example" | sort -u)"
compose_keys="$(grep -oE '\$\{[A-Z_][A-Z0-9_]*' "$HERE/deploy/docker-compose.yml" | sed 's/^\${//' | sort -u)"
install_keys="$(awk '/cat > \.env <<EOF/{p=1;next} p&&/^EOF/{exit} p' "$HERE/synap" | sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' | sort -u)"
cli_written="$( (grep -oE 'envcfg_write_raw S "?[A-Z_][A-Z0-9_]*' "$HERE/synap" | awk '{print $3}'; grep -oE 'update_env_value "?[A-Z_][A-Z0-9_]*' "$HERE/synap" | awk '{print $2}') | tr -d '"' | sort -u)"

n() { echo "$1" | grep -c .; }
[ "$(n "$example_keys")" -ge 40 ] && ok "scanned $(n "$example_keys") .env.example keys" || bad ".env.example keys: only $(n "$example_keys") (scan broken?)"
[ "$(n "$compose_keys")" -ge 70 ] && ok "scanned $(n "$compose_keys") compose \${KEY}s" || bad "compose keys: only $(n "$compose_keys")"
[ "$(n "$install_keys")" -ge 20 ] && ok "scanned $(n "$install_keys") keys synap install generates" || bad "install keys: only $(n "$install_keys") (heredoc moved?)"
[ "$(n "$cli_written")" -ge 10 ] && ok "scanned $(n "$cli_written") keys the CLI writes itself" || bad "CLI-written keys: only $(n "$cli_written")"
# self-check of the matcher: it must see a literal sample of each source
echo "$example_keys" | grep -qx BACKUP_REPOSITORY && echo "$example_keys" | grep -qx PG_BACKUP_KEEP && echo "$example_keys" | grep -qx CONTROL_PLANE_URL \
  && ok "self-check: active, commented and indented .env.example keys are seen" || bad "self-check: .env.example matcher misses keys"
echo "$compose_keys" | grep -qx POSTGRES_PASSWORD && echo "$cli_written" | grep -qx SYNAP_EDGE && echo "$install_keys" | grep -qx ORY_HYDRA_SECRETS_SYSTEM \
  && ok "self-check: compose / CLI-written / install matchers see known keys" || bad "self-check: a key matcher went blind"

for src in example compose install cli; do
  case "$src" in example) keys="$example_keys";; compose) keys="$compose_keys";; install) keys="$install_keys";; cli) keys="$cli_written";; esac
  missing=""
  for k in $keys; do in_schema "$k" || missing="$missing $k"; done
  [ -z "$missing" ] && ok "every $src key is in env.schema" || bad "$src keys missing from env.schema:$missing"
done

# POD_SECRET_FIELDS (eve's mirror of the data-indexing secrets)
hestia="${ENV_SCHEMA_HESTIA:-$HERE/../hestia-cli}"
contract="$hestia/packages/@eve/dna/src/secrets-contract.ts"
if [ -f "$contract" ]; then
  podsec="$(awk '/^const POD_SECRET_FIELDS = \{/{p=1;next} p&&/^\};/{exit} p' "$contract" | sed -nE 's/^[[:space:]]*([A-Z][A-Z0-9_]*):.*/\1/p')"
  [ "$(n "$podsec")" -ge 10 ] && ok "read $(n "$podsec") POD_SECRET_FIELDS from $contract" || bad "POD_SECRET_FIELDS: only $(n "$podsec") keys parsed"
  for k in $podsec; do
    f="$(flags_of "$k")"
    case ",$f," in *,secret,*) ;; *) bad "POD_SECRET_FIELDS $k is not flagged secret in env.schema ('$f')"; continue ;; esac
    case ",$f," in *,immutable,*) ;; *) bad "POD_SECRET_FIELDS $k is not flagged immutable in env.schema ('$f')"; continue ;; esac
  done
  ok "POD_SECRET_FIELDS checked against secret+immutable"
else
  echo "skip - hestia-cli not present at $hestia (POD_SECRET_FIELDS cross-check)"
fi

# The update refuses a .env missing these — they must be `required` here too.
crit="$(grep -oE 'for key in [A-Z_ ]+; do' "$HERE/synap" | head -1 | sed 's/for key in //; s/; do//')"
[ -n "$crit" ] || bad "could not find cmd_update's critical-secret list"
for k in $crit; do case ",$(flags_of "$k")," in *,required,*) ;; *) bad "critical key $k is not 'required' in env.schema";; esac; done
[ -n "$crit" ] && ok "cmd_update's critical keys ($crit) are required"

# No orphan: every schema key is still used somewhere.
used_text="$(cat "$HERE/deploy/.env.example" "$HERE/deploy/docker-compose.yml" "$HERE/synap" "$HERE"/deploy/*.sh "$HERE"/deploy/pod-agent/*.js 2>/dev/null)"
orphans=""
for k in $(schema_keys); do
  case "$k" in *\*) p="${k%\*}"; grep -q "$p" <<<"$used_text" || orphans="$orphans $k"; continue ;; esac
  grep -qw "$k" <<<"$used_text" || orphans="$orphans $k"
done
[ -z "$orphans" ] && ok "every env.schema key is still used by the compose file, .env.example or the CLI" || bad "orphan schema keys (nothing uses them):$orphans"

# Every type in the schema is one env-config.sh understands.
types="$(awk '/^[ \t]*(#|$)/ {next} {print $2}' "$SCHEMA" | sort -u)"
for t in $types; do
  why="$(dash -c '. "$1"; envcfg_type_error "$2" "x"' _ "$HERE/deploy/env-config.sh" "$t" 2>&1)"
  case "$why" in *"is unknown"*) bad "schema type '$t' unknown to env-config.sh" ;; esac
done
ok "all $(n "$types") schema types are implemented"

# ═══ Part B: behaviour ═══════════════════════════════════════════════════════
REPO="$TMP/repo"; DEPLOY="$REPO/deploy"
mkdir -p "$TMP/bin" "$DEPLOY"
cp "$HERE/synap" "$REPO/synap"
cp "$HERE/deploy/ensure-ory-databases.sh" "$HERE/deploy/pgdata-safety.sh" "$HERE/deploy/update-lock.sh" \
   "$HERE/deploy/env-config.sh" "$HERE/deploy/env.schema" "$HERE/deploy/docker-compose.yml" "$DEPLOY/"
BASE_ENV='DOMAIN=pod.example.com
PUBLIC_URL=https://pod.example.com
POD_AGENT_ISSUER_URL=https://api.synap.live
POD_AGENT_AUDIENCE=https://pod.example.com
COMPOSE_PROJECT_NAME=synap-backend
POSTGRES_PASSWORD=pgpass
JWT_SECRET=jwtsecret
KRATOS_SECRETS_COOKIE=cookie
# >>> synap release — managed by `synap update`; do not edit by hand >>>
SYNAP_RELEASE_ID=main-1111111
# <<< synap release <<<'
reset_env() { printf '%s\n' "$BASE_ENV" > "$DEPLOY/.env"; chmod 640 "$DEPLOY/.env"; rm -f "$DEPLOY"/.env.bak.*; }

cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "compose ps --status running --services") printf 'backend\nkratos\npostgres\nbackend-migrate\n' ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker"
export FAKE_LOG="$TMP/log"
synap() { : > "$FAKE_LOG"; ( cd "$TMP"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" bash "$REPO/synap" "$@" ) >"$TMP/out" 2>&1; }
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
baks() { ls "$DEPLOY"/.env.bak.* 2>/dev/null | wc -l | tr -d ' '; }
envval() { grep "^$1=" "$DEPLOY/.env" | tail -1 | cut -d= -f2-; }

# 1. unknown keys are refused, nothing written
reset_env; before="$(cat "$DEPLOY/.env")"
synap config set PATH=/usr/bin NODE_VERSION=20; rc=$?
[ "$rc" != 0 ] && [ "$(cat "$DEPLOY/.env")" = "$before" ] && [ "$(baks)" = 0 ] && grep -q "PATH: unknown key" "$TMP/out" && grep -q "NODE_VERSION: unknown key" "$TMP/out" \
  && ok "PATH / NODE_VERSION refused, .env untouched, no backup" || bad "unknown keys (rc=$rc): $(cat "$TMP/out")"

# 2. a valid set: written, 0600 backup, file mode kept, recreate advice derived from compose
synap config set PUBLIC_URL=https://pod2.example.com POD_AGENT_AUDIENCE=https://pod2.example.com DOMAIN=pod2.example.com; rc=$?
[ "$rc" = 0 ] && [ "$(envval PUBLIC_URL)" = https://pod2.example.com ] && [ "$(envval DOMAIN)" = pod2.example.com ] && ok "valid batch written" || bad "valid set (rc=$rc): $(cat "$TMP/out")"
b="$(ls "$DEPLOY"/.env.bak.* 2>/dev/null | head -1)"
[ "$(baks)" = 1 ] && [ "$(mode "$b")" = 600 ] && grep -q "^PUBLIC_URL=https://pod.example.com$" "$b" && ok ".env.bak.<ts> holds the previous file, mode 0600" || bad "backup: $(ls -l "$DEPLOY"/.env.bak.* 2>&1)"
[[ "$b" =~ \.env\.bak\.[0-9]{8}T[0-9]{6}Z$ ]] && ok "backup is named .env.bak.<UTC ts>" || bad "backup name: $b"
[ "$(mode "$DEPLOY/.env")" = 640 ] && ok ".env mode kept (640)" || bad ".env mode changed to $(mode "$DEPLOY/.env")"
grep -q "keep the OLD values until recreated:.*backend" "$TMP/out" && grep -q "kratos" "$TMP/out" && grep -q "synap apply" "$TMP/out" \
  && ok "recreate advice lists the services reading the keys (derived from compose) + synap apply" || bad "recreate advice: $(cat "$TMP/out")"
grep -q "SYNAP_RELEASE_ID=main-1111111" "$DEPLOY/.env" && grep -q "^# >>> synap release" "$DEPLOY/.env" && ok "the release block and comments survive a set" || bad "release block damaged"
synap config set SYNAP_UPDATE_CHANNEL=fast
grep -q "nothing to recreate" "$TMP/out" && ok "a CLI-only key needs no recreate" || bad "CLI-only key advice: $(cat "$TMP/out")"

# 3. type checks
reset_env
for bad_pair in "PUBLIC_URL=https://pod.example.com/" "PUBLIC_URL=http://pod.example.com" "DOMAIN=https://pod.example.com" \
                "ADMIN_EMAIL=nope" "SYNAP_EDGE=nginx" "DB_POOL_SIZE=ten" "OPENAI_API_KEY=a b"; do
  synap config set "$bad_pair"; rc=$?
  [ "$rc" != 0 ] && [ "$(baks)" = 0 ] || bad "accepted invalid $bad_pair"
done
ok "invalid values refused (trailing slash, http on a public host, scheme in DOMAIN, email, enum, int, token)"
synap config set PUBLIC_URL=http://localhost:4000 POD_AGENT_AUDIENCE= ; [ $? = 0 ] && ok "http is allowed for localhost" || bad "localhost http refused: $(cat "$TMP/out")"

# 4. guarded keys
reset_env
synap config set SYNAP_IMAGE_BACKEND=evil/backend:1; [ $? != 0 ] && grep -q "managed by \`synap update\`" "$TMP/out" && ok "release block (SYNAP_IMAGE_*) refused" || bad "managed key accepted"
synap config set COMPOSE_PROJECT_NAME=deploy; [ $? != 0 ] && grep -q "pinned" "$TMP/out" && ok "COMPOSE_PROJECT_NAME pin refused" || bad "pin changed"
synap config set POSTGRES_PASSWORD=other; [ $? != 0 ] && [ "$(envval POSTGRES_PASSWORD)" = pgpass ] && ok "immutable secret refused without --force" || bad "immutable secret changed"
synap config set --force POSTGRES_PASSWORD=other; [ $? = 0 ] && [ "$(envval POSTGRES_PASSWORD)" = other ] && ok "immutable secret changes with --force" || bad "--force: $(cat "$TMP/out")"
reset_env
printf 'VAULT_SERVER_KEY=\n' >> "$DEPLOY/.env"
synap config set VAULT_SERVER_KEY=abc123; [ $? = 0 ] && [ "$(envval VAULT_SERVER_KEY)" = abc123 ] && ok "an EMPTY immutable secret may be filled (eve restore path)" || bad "fill empty immutable: $(cat "$TMP/out")"
synap config set PUBLIC_URL=https://elsewhere.example.com; [ $? != 0 ] && grep -q "POD_AGENT_AUDIENCE" "$TMP/out" && ok "PUBLIC_URL may not drift from POD_AGENT_AUDIENCE" || bad "audience drift accepted"

# 5. all-or-nothing batch
reset_env
synap config set DEBUG=true PATH=/bin; [ $? != 0 ] && ! grep -q "^DEBUG=" "$DEPLOY/.env" && ok "one bad pair → nothing written" || bad "partial batch written"

# 6. secrets are never printed
reset_env
synap config set OPENAI_API_KEY=sk-TOPSECRET-1234; grep -q TOPSECRET "$TMP/out" && bad "set echoed a secret" || ok "set masks the secret"
synap config list;  grep -q TOPSECRET "$TMP/out" && bad "list echoed a secret" || ok "list masks secrets"
synap config get OPENAI_API_KEY; grep -q TOPSECRET "$TMP/out" && bad "get echoed a secret" || ok "get masks secrets"
synap config diff;  grep -q TOPSECRET "$TMP/out" && bad "diff echoed a secret" || { grep -q "+ OPENAI_API_KEY=\*\*\*\*\*\*\*\*" "$TMP/out" && ok "diff masks secrets"; } || bad "diff: $(cat "$TMP/out")"
synap config get OPENAI_API_KEY --reveal; grep -qx sk-TOPSECRET-1234 "$TMP/out" && ok "get --reveal prints it on request" || bad "--reveal: $(cat "$TMP/out")"
synap config get POSTGRES_PASSWORD; grep -q pgpass "$TMP/out" && bad "get echoed POSTGRES_PASSWORD" || ok "get masks schema secrets"

# 7. --stdin keeps values out of argv; legacy `set KEY VALUE` still works
reset_env
printf 'T3CODE_API_KEY=from-stdin\nT3CODE_URL="http://t3:9000"\n' | ( cd "$TMP"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" bash "$REPO/synap" config set --stdin ) >"$TMP/out" 2>&1
[ "$(envval T3CODE_API_KEY)" = from-stdin ] && [ "$(envval T3CODE_URL)" = http://t3:9000 ] && ok "--stdin batch (quotes stripped)" || bad "--stdin: $(cat "$TMP/out")"
synap config set SYNAP_POD_OIDC_LABEL "Sign in with Synap"
[ "$(envval SYNAP_POD_OIDC_LABEL)" = "'Sign in with Synap'" ] && ok "legacy 'set KEY VALUE' form; a value with spaces is single-quoted" || bad "legacy form: $(grep OIDC "$DEPLOY/.env")"

# 8. unset
synap config unset T3CODE_URL; ! grep -q '^T3CODE_URL=' "$DEPLOY/.env" && ok "unset removes the key" || bad "unset"
synap config unset JWT_SECRET; [ $? != 0 ] && grep -q '^JWT_SECRET=' "$DEPLOY/.env" && ok "unset of an immutable secret refused" || bad "immutable unset"
synap config unset SYNAP_RELEASE_ID; [ $? != 0 ] && ok "unset of the release block refused" || bad "managed unset"

# 9. backup retention: newest 10
reset_env
for i in $(seq 1 12); do synap config set "RSS_FETCH_RETRIES=$i"; done
[ "$(baks)" -le 10 ] && [ "$(baks)" -ge 1 ] && ok "backups capped at 10 ($(baks))" || bad "backups: $(baks)"

# 10. validate
reset_env
synap config validate; [ $? = 0 ] && ok "a clean .env validates" || bad "clean .env: $(cat "$TMP/out")"
printf 'NODE_VERSION=20\nDOMAIN=dup.example.com\nPUBLIC_URL=https://x.example.com/\n' >> "$DEPLOY/.env"
synap config validate; rc=$?
[ "$rc" != 0 ] && grep -q "NODE_VERSION.*unknown key" "$TMP/out" && grep -q "DOMAIN.*more than once" "$TMP/out" && grep -q "PUBLIC_URL.*trailing slash" "$TMP/out" \
  && ok "validate reports unknown, duplicate and malformed keys" || bad "validate (rc=$rc): $(cat "$TMP/out")"

# 11. the update lock covers config writes
reset_env
mkdir -p "$DEPLOY/state/update.lock.d"; echo "synap update pid=$$ since=now" > "$DEPLOY/state/update.lock.d/owner"
: > "$FAKE_LOG"; ( cd "$TMP"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_LOCK_IMPL=mkdir bash "$REPO/synap" config set DEBUG=true ) >"$TMP/out" 2>&1; rc=$?
[ "$rc" != 0 ] && ! grep -q '^DEBUG=' "$DEPLOY/.env" && grep -q "already running" "$TMP/out" && ok "config set waits for no one: refused while an update holds the lock" || bad "config set ignored the lock (rc=$rc): $(cat "$TMP/out")"
rm -rf "$DEPLOY/state/update.lock.d"

# 12. synap apply: running services only, no prune / down / volume op
reset_env
synap apply; rc=$?
grep -qxE "compose (--profile pod-agent )?up -d --no-deps backend kratos postgres" "$FAKE_LOG" && ok "apply recreates what changed among the RUNNING services (one-shots excluded)" || bad "apply (rc=$rc): $(cat "$FAKE_LOG")"
grep -E "prune|down|volume|--remove-orphans|rm -f" "$FAKE_LOG" && bad "apply ran a destructive command" || ok "apply never prunes, downs or touches volumes"
printf 'NODE_VERSION=20\n' >> "$DEPLOY/.env"
synap apply; [ $? != 0 ] && ! grep -q "compose up" "$FAKE_LOG" && ok "apply refuses an invalid .env before recreating anything" || bad "apply ran on an invalid .env"

# 13. sourced under dash — the pod-agent container's shell
reset_env
out="$(cd "$DEPLOY" && SYNAP_DEPLOY_DIR="$DEPLOY" dash -c '. ./env-config.sh && envcfg_set DEBUG=true >/dev/null && envcfg_value DEBUG && envcfg_set PATH=/x 2>/dev/null; echo "rc=$?"' 2>&1)"
[ "$out" = "$(printf 'true\nrc=1')" ] && ok "env-config.sh works SOURCED under dash (set, read, refusal)" || bad "dash: $out"
grep -q '^DEBUG=true$' "$DEPLOY/.env" && ok "dash write landed" || bad "dash write missing"

# 14. CP configure keys (claim-warm-pod, openclaw-provision, exposure) stay accepted
reset_env
synap config set DOMAIN=claimed.example.com PUBLIC_URL=https://claimed.example.com POD_ADMIN_DOMAIN=pod-admin.claimed.example.com \
  POD_ADMIN_URL=https://pod-admin.claimed.example.com FRONTEND_URL=https://claimed.example.com CORS_ORIGIN=https://claimed.example.com \
  ALLOWED_ORIGINS=https://claimed.example.com POD_AGENT_AUDIENCE=https://claimed.example.com OPENCLAW_HUB_API_KEY=k \
  SYNAP_AGENT_USER_ID=u SYNAP_WORKSPACE_ID=w CLOUDFLARED_TUNNEL_TOKEN=t
[ $? = 0 ] && ok "every key the Control Plane sends via configure is accepted" || bad "CP configure keys: $(cat "$TMP/out")"
exit $fail
