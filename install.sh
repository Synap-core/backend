#!/usr/bin/env bash
# ==============================================================================
# Synap Backend — One-Line Installer
# ==============================================================================
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash
#
# With flags:
#   curl -fsSL ... | bash -s -- --domain synap.example.com --dir /srv/synap
#
# Environment overrides (alternative to flags):
#   SYNAP_DOMAIN=synap.example.com \
#   SYNAP_DIR=/srv/synap \
#   bash <(curl -fsSL ...)
#
# This installer downloads pre-built Docker images from GitHub Container Registry.
# No source code or build tools required.
# ==============================================================================

set -euo pipefail

# Deploy version controls BOTH the raw.githubusercontent.com ref used to fetch
# config files, AND the Docker image tag used for backend/realtime/pod-agent.
# Defaults to "main" (always present on GHCR). Override via --deploy-version
# (e.g. "v1.0.2") or SYNAP_DEPLOY_VERSION env var. Do NOT use "latest" — it
# only exists on v* tags and will break fresh installs if no release has been cut.
DEPLOY_VERSION="${SYNAP_DEPLOY_VERSION:-main}"
RAW_BASE_TEMPLATE="https://raw.githubusercontent.com/Synap-core/backend"

# ─── Defaults (override via env or flags) ─────────────────────────────────────
INSTALL_DIR="${SYNAP_DIR:-/srv/synap}"
DOMAIN="${SYNAP_DOMAIN:-}"
LETSENCRYPT_EMAIL="${SYNAP_EMAIL:-}"
INTELLIGENCE_URL="${SYNAP_INTELLIGENCE_URL:-}"
INTELLIGENCE_API_KEY="${SYNAP_INTELLIGENCE_API_KEY:-}"
ADMIN_EMAIL="${SYNAP_ADMIN_EMAIL:-}"
BACKEND_VERSION_FLAG="${SYNAP_BACKEND_VERSION:-}"
POD_AGENT_VERSION_FLAG="${SYNAP_POD_AGENT_VERSION:-}"
CONTROL_PLANE_URL_FLAG="${SYNAP_CONTROL_PLANE_URL:-}"
# PROVISIONING_TOKEN is used by setup-openclaw.sh to create agent users and
# API keys. It is NOT used for CP trust (seed-trust uses ES256 JWTs instead).
# Managed pods can inject a pre-generated token; self-hosted installs generate one.
PROVISIONING_TOKEN_FLAG="${SYNAP_PROVISIONING_TOKEN:-}"
# SMTP connection URI for Kratos courier. Defaults to local catch-all (no real
# delivery). Managed pods get a real relay URI injected by the Control Plane;
# self-hosted installs can set SYNAP_SMTP_URI or pass --smtp-uri.
SMTP_URI="${SYNAP_SMTP_URI:-}"

# ─── CLI flags ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)              DOMAIN="$2";                  shift 2 ;;
    --dir)                 INSTALL_DIR="$2";              shift 2 ;;
    --email)               LETSENCRYPT_EMAIL="$2";        shift 2 ;;
    --intelligence-url)    INTELLIGENCE_URL="$2";         shift 2 ;;
    --intelligence-key)    INTELLIGENCE_API_KEY="$2";     shift 2 ;;
    --admin-email)         ADMIN_EMAIL="$2";              shift 2 ;;
    --deploy-version)      DEPLOY_VERSION="$2";           shift 2 ;;
    --backend-version)     BACKEND_VERSION_FLAG="$2";     shift 2 ;;
    --pod-agent-version)   POD_AGENT_VERSION_FLAG="$2";   shift 2 ;;
    --control-plane-url)   CONTROL_PLANE_URL_FLAG="$2";   shift 2 ;;
    --provisioning-token)  PROVISIONING_TOKEN_FLAG="$2";  shift 2 ;;
    --smtp-uri)            SMTP_URI="$2";                  shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Image tags default to DEPLOY_VERSION when not set explicitly. This keeps the
# three artifacts (config files, backend image, pod-agent image) version-aligned.
BACKEND_VERSION="${BACKEND_VERSION_FLAG:-$DEPLOY_VERSION}"
POD_AGENT_VERSION="${POD_AGENT_VERSION_FLAG:-$DEPLOY_VERSION}"
RAW_BASE="${RAW_BASE_TEMPLATE}/${DEPLOY_VERSION}"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}→${RESET}  $*"; }
success() { echo -e "${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}✗${RESET}  $*" >&2; exit 1; }
heading() { echo -e "\n${BOLD}$*${RESET}"; }
blank()   { echo ""; }

# ─── Prerequisites ─────────────────────────────────────────────────────────────
blank
heading "Synap Backend — One-Line Installer"
echo "Sets up a production Synap Backend using pre-built Docker images."
echo "No source code or build tools required — only Docker is needed."
blank

for cmd in docker curl openssl; do
  command -v "$cmd" >/dev/null 2>&1 || error "$cmd is required but not installed."
done

docker compose version >/dev/null 2>&1 \
  || error "Docker Compose v2 is required. See: https://docs.docker.com/compose/install/"

success "Prerequisites OK (docker, curl, openssl)"

# ─── Interactive prompts ───────────────────────────────────────────────────────
heading "Configuration"

if [[ -z "$DOMAIN" ]]; then
  read -rp "$(echo -e "${BOLD}Domain${RESET} (e.g. synap.example.com): ")" DOMAIN
  [[ -z "$DOMAIN" ]] && error "Domain is required."
fi

if [[ -z "$LETSENCRYPT_EMAIL" ]]; then
  read -rp "$(echo -e "${BOLD}Email${RESET} (for Let's Encrypt SSL notifications): ")" LETSENCRYPT_EMAIL
  [[ -z "$LETSENCRYPT_EMAIL" ]] && error "Email is required for SSL certificate issuance."
fi

if [[ -z "$ADMIN_EMAIL" ]]; then
  read -rp "$(echo -e "${BOLD}Admin email${RESET} (first admin account, leave blank to invite later): ")" ADMIN_EMAIL
fi

blank
echo "  Intelligence Service (Synap Agent Hub) — optional, configure later:"
if [[ -z "$INTELLIGENCE_URL" ]]; then
  read -rp "$(echo -e "  ${BOLD}Intelligence URL${RESET} [leave blank]: ")" INTELLIGENCE_URL
fi
if [[ -n "$INTELLIGENCE_URL" && -z "$INTELLIGENCE_API_KEY" ]]; then
  read -rp "$(echo -e "  ${BOLD}Intelligence API Key${RESET}: ")" INTELLIGENCE_API_KEY
fi

success "Configuration collected"

# ─── Existing install guard ────────────────────────────────────────────────────
if [[ -f "$INSTALL_DIR/.env" ]]; then
  warn "Existing installation detected at $INSTALL_DIR"
  read -rp "$(echo -e "${YELLOW}Update config files only? (y) or full reinstall? (n): ${RESET}")" choice
  if [[ "$choice" != "n" && "$choice" != "N" ]]; then
    UPDATE_ONLY=true
  else
    UPDATE_ONLY=false
  fi
else
  UPDATE_ONLY=false
fi

# ─── Directory structure ───────────────────────────────────────────────────────
heading "Creating directories"

mkdir -p "$INSTALL_DIR"/{config/{kratos,postgres},logs}

if [[ "$UPDATE_ONLY" != "true" ]]; then
  # Named Docker volumes manage data — no local bind mounts for data dirs
  info "Using Docker named volumes for persistent data (postgres, redis, minio, typesense)"
fi

success "Directories ready at $INSTALL_DIR"

# ─── Cleanup known stale artifacts from older installers ──────────────────────
heading "Cleaning stale install artifacts"
rm -f "$INSTALL_DIR/patch_migration.js"
if [[ -f "$INSTALL_DIR/docker-compose.override.yml" ]] && grep -q "patch_migration.js" "$INSTALL_DIR/docker-compose.override.yml" 2>/dev/null; then
  rm -f "$INSTALL_DIR/docker-compose.override.yml"
  info "Removed legacy docker-compose.override.yml with patch_migration hook"
fi
success "Stale artifact cleanup complete"

# ─── Download config files ─────────────────────────────────────────────────────
heading "Downloading configuration files"

_download() {
  local src="$1" dst="$2"
  info "Fetching $src"
  curl -fsSL "$RAW_BASE/$src" -o "$dst" || error "Failed to download $src"
}

_download "deploy/docker-compose.yml"                      "$INSTALL_DIR/docker-compose.yml"
_download "deploy/Caddyfile"                               "$INSTALL_DIR/Caddyfile"
_download "deploy/openclaw_auth.snippet"                   "$INSTALL_DIR/openclaw_auth.snippet"
_download "kratos/identity.schema.json"                    "$INSTALL_DIR/config/kratos/identity.schema.json"
_download "kratos/oidc.github.jsonnet"                     "$INSTALL_DIR/config/kratos/oidc.github.jsonnet"
_download "kratos/oidc.google.jsonnet"                     "$INSTALL_DIR/config/kratos/oidc.google.jsonnet"
_download "docker/postgres/init-databases.sh"              "$INSTALL_DIR/config/postgres/init-databases.sh"

# Pod-agent operational scripts — executed from /deploy/ mount when the
# Control Plane issues a pod-agent command (configure, suspend, archive,
# restore, update, etc.). The pod-agent container bind-mounts $INSTALL_DIR
# as /deploy:rw, so these files MUST live next to docker-compose.yml.
POD_AGENT_SCRIPTS="configure-pod.sh suspend-pod.sh restore-pod.sh restore-archive-pod.sh archive-pod.sh update-pod.sh update-agent.sh"
for script in $POD_AGENT_SCRIPTS; do
  _download "deploy/$script" "$INSTALL_DIR/$script"
  chmod +x "$INSTALL_DIR/$script"
done

# Add-on installer (referenced by the post-install "Next steps" message)
_download "deploy/setup-openclaw.sh" "$INSTALL_DIR/setup-openclaw.sh"
chmod +x "$INSTALL_DIR/setup-openclaw.sh"

chmod +x "$INSTALL_DIR/config/postgres/init-databases.sh"

success "Config files downloaded"

# ─── Generate Kratos config ────────────────────────────────────────────────────
heading "Generating Kratos config"

# Validate DOMAIN before it is interpolated into shell, .env, and kratos.yml —
# reject anything but a hostname so a malformed/hostile value can't inject config.
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  error "Invalid domain '$DOMAIN' — only letters, digits, dots and hyphens are allowed."
fi

# Root domain (strip leading "pod." so the session cookie and Eve subdomain
# entries are scoped to the shared parent, e.g. "team.example.com").
ROOT_DOMAIN="${DOMAIN#pod.}"

cat > "$INSTALL_DIR/config/kratos/kratos.yml" << KRATOS_EOF
version: v1.3.1

dsn: postgres://synap:\${POSTGRES_PASSWORD}@postgres:5432/kratos?sslmode=disable

log:
  level: info
  format: text

serve:
  public:
    base_url: https://$DOMAIN/.ory/kratos/public/
    cors:
      # Internal only — all external browser traffic enters via Caddy →
      # backend:4000, and the backend owns the CORS gate (ALLOWED_ORIGINS).
      # Leaving this enabled with the pod's own origin is defensive for the
      # case where Kratos gets called directly (e.g. dev / debug).
      enabled: true
      allowed_origins:
        - https://$DOMAIN
        - https://*.$ROOT_DOMAIN
        - https://eve.$ROOT_DOMAIN
      allowed_headers:
        - Authorization
        - Content-Type
        - Cookie
        - X-Session-Token
      exposed_headers:
        - Content-Type
        - Set-Cookie
      allow_credentials: true
  admin:
    base_url: http://kratos:4434

selfservice:
  default_browser_return_url: https://$DOMAIN/admin/
  allowed_return_urls:
    - https://$DOMAIN
    - https://$DOMAIN/*
    - https://eve.$ROOT_DOMAIN
    - https://eve.$ROOT_DOMAIN/*

  methods:
    password:
      enabled: true
    oidc:
      enabled: false

  flows:
    login:
      ui_url: https://$DOMAIN/admin/kratos
      lifespan: 10m
    registration:
      ui_url: https://$DOMAIN/admin/kratos
      lifespan: 10m
    recovery:
      enabled: true
      ui_url: https://$DOMAIN/admin/kratos
    settings:
      ui_url: https://$DOMAIN/admin/kratos
      privileged_session_max_age: 15m
      after:
        password:
          hooks:
            - hook: web_hook
              config:
                url: http://backend:4000/webhooks/kratos
                method: POST
                body: base64://eyJmbG93X2lkIjoie3sgLkZsb3cuSUQgfX0iLCAiaWRlbnRpdHkiOiB7eyAuSWRlbnRpdHkgfCB0b0pzb24gfX19
    verification:
      enabled: false
    logout:
      after:
        default_browser_return_url: https://$DOMAIN/admin/

session:
  cookie:
    domain: $ROOT_DOMAIN
    same_site: Lax

identity:
  default_schema_id: default
  schemas:
    - id: default
      url: file:///etc/config/kratos/identity.schema.json

courier:
  smtp:
    # connection_uri is set via COURIER_SMTP_CONNECTION_URI env var in docker-compose
    # (kratos reads COURIER_SMTP_* env vars natively; file-level substitution is unreliable)
    from_address: noreply@$DOMAIN
    from_name: Synap
KRATOS_EOF

success "Kratos config written"

# ─── Generate secrets (skip if updating) ──────────────────────────────────────
if [[ "$UPDATE_ONLY" == "true" ]]; then
  heading "Skipping secret regeneration (update mode)"
  info "Using existing .env at $INSTALL_DIR/.env"

  # Ensure kratos.yml has secrets block (may be missing on older installs)
  if ! grep -q "^secrets:" "$INSTALL_DIR/config/kratos/kratos.yml" 2>/dev/null; then
    # Read secrets from existing .env
    source "$INSTALL_DIR/.env" 2>/dev/null || true
    if [[ -n "$KRATOS_SECRETS_COOKIE" && -n "$KRATOS_SECRETS_CIPHER" ]]; then
      cat >> "$INSTALL_DIR/config/kratos/kratos.yml" << SECRETS_EOF

secrets:
  cookie:
    - $KRATOS_SECRETS_COOKIE
  cipher:
    - $KRATOS_SECRETS_CIPHER
SECRETS_EOF
      info "Kratos secrets injected into kratos.yml (upgrade from older install)"
    fi
  fi

  # Self-heal: backfill SYNAP_BASE_DOMAIN (added 2026-05 for the derived first-party
  # CORS allowlist). .env files from before this change lack it; without it the
  # backend denies cross-subdomain frontends (fail-closed). Derive from the pod
  # domain so updates need NO manual edit.
  if ! grep -q "^SYNAP_BASE_DOMAIN=" "$INSTALL_DIR/.env" 2>/dev/null; then
    _base="$ROOT_DOMAIN"
    if [[ -z "$_base" ]]; then
      source "$INSTALL_DIR/.env" 2>/dev/null || true
      _base="${DOMAIN#pod.}"
    fi
    if [[ -n "$_base" ]]; then
      printf '\n# Parent domain for the derived first-party CORS allowlist (backfilled on update)\nSYNAP_BASE_DOMAIN=%s\n' "$_base" >> "$INSTALL_DIR/.env"
      info "Backfilled SYNAP_BASE_DOMAIN=$_base into .env (CORS allowlist self-heal)"
      # Force the env-consuming services to recreate this run so the new var is
      # injected immediately (a plain `up -d` may skip recreation on an .env-only
      # change, leaving CORS fail-closed until the next restart).
      RECREATE_FOR_CORS=1
    else
      warn "Could not derive SYNAP_BASE_DOMAIN — set it in .env manually, or cross-subdomain frontends will be denied by CORS"
    fi
  fi
else
  heading "Generating secrets"

  _gen() { openssl rand -hex 32; }

  POSTGRES_PASSWORD=$(_gen)
  MINIO_ACCESS_KEY=$(openssl rand -hex 16)
  MINIO_SECRET_KEY=$(_gen)
  TYPESENSE_API_KEY=$(_gen)
  TYPESENSE_ADMIN_API_KEY=$(_gen)
  JWT_SECRET=$(_gen)
  ENCRYPTION_KEY=$(_gen)
  KRATOS_SECRETS_COOKIE=$(_gen)
  KRATOS_SECRETS_CIPHER=$(openssl rand -hex 16)  # 32 chars = 16-byte AES key (kratos max=32)
  KRATOS_WEBHOOK_SECRET=$(_gen)
  ORY_HYDRA_SECRETS_SYSTEM=$(_gen)
  HUB_PROTOCOL_API_KEY=$(_gen)
  HUB_JWT_SECRET=$(_gen)
  SYNAP_SERVICE_ENCRYPTION_KEY=$(_gen)
  VAULT_SERVER_KEY=$(_gen)
  # Use the CP-supplied token when available (managed pods); otherwise generate.
  PROVISIONING_TOKEN="${PROVISIONING_TOKEN_FLAG:-$(_gen)}"

  success "Secrets generated"

  # ─── Inject secrets into kratos.yml ──────────────────────────────────────────
  # Kratos v1.3.1 does NOT support ${VAR} substitution in config files, and
  # env vars require indexed array format (SECRETS_COOKIE_0=xxx). Writing the
  # actual values directly into kratos.yml is the only reliable approach.
  cat >> "$INSTALL_DIR/config/kratos/kratos.yml" << SECRETS_EOF

secrets:
  cookie:
    - $KRATOS_SECRETS_COOKIE
  cipher:
    - $KRATOS_SECRETS_CIPHER
SECRETS_EOF
  success "Kratos secrets injected into kratos.yml"

  # ─── Write .env ─────────────────────────────────────────────────────────────
  heading "Writing .env"

  cat > "$INSTALL_DIR/.env" << ENV_EOF
# ==============================================================================
# Synap Backend — Environment Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# WARNING: Keep this file secure. Never commit to version control.
# ==============================================================================

# ── Domain ────────────────────────────────────────────────────────────────────
DOMAIN=$DOMAIN
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL

# ── Deploy layout (install.sh downloads config next to docker-compose.yml) ────
# These point docker-compose.yml at the install-flow locations instead of the
# source-repo relative paths (../kratos, ../docker/postgres/...).
KRATOS_CONFIG_DIR=./config/kratos
POSTGRES_INIT_SCRIPT=./config/postgres/init-databases.sh

# ── Image versions ─────────────────────────────────────────────────────────────
# Resolved by install.sh from --deploy-version (default: "main"). Override with
# --backend-version / --pod-agent-version for split deployments.
# Do NOT set these to "latest" unless you have cut a v* release — the workflow
# only publishes :latest on version tags, so fresh installs will fail to pull.
BACKEND_VERSION=$BACKEND_VERSION
# Pod-agent (CP → configure / archive / suspend / …) — keep in sync with backend ring when pinning
POD_AGENT_VERSION=$POD_AGENT_VERSION

# ── Admin (first user) ────────────────────────────────────────────────────────
ADMIN_EMAIL=${ADMIN_EMAIL:-}

# ── PostgreSQL ────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

# ── MinIO (Object Storage) ────────────────────────────────────────────────────
# Auto-generated by install.sh — do not set manually in production
MINIO_ACCESS_KEY=$MINIO_ACCESS_KEY
MINIO_SECRET_KEY=$MINIO_SECRET_KEY

# ── Typesense (Search) ────────────────────────────────────────────────────────
TYPESENSE_API_KEY=$TYPESENSE_API_KEY
TYPESENSE_ADMIN_API_KEY=$TYPESENSE_ADMIN_API_KEY

# ── Auth (JWT + Kratos + Hydra) ───────────────────────────────────────────────
JWT_SECRET=$JWT_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
KRATOS_SECRETS_COOKIE=$KRATOS_SECRETS_COOKIE
KRATOS_SECRETS_CIPHER=$KRATOS_SECRETS_CIPHER
KRATOS_WEBHOOK_SECRET=$KRATOS_WEBHOOK_SECRET
ORY_HYDRA_SECRETS_SYSTEM=$ORY_HYDRA_SECRETS_SYSTEM

# ── Hub Protocol ──────────────────────────────────────────────────────────────
HUB_PROTOCOL_API_KEY=$HUB_PROTOCOL_API_KEY
HUB_JWT_SECRET=$HUB_JWT_SECRET

# ── Service credential encryption ─────────────────────────────────────────────
# Used by the pod to encrypt Hub API keys and other IS credentials at rest.
# REQUIRED for Control Plane provisioning (register-intelligence endpoint).
# Rotating this key will invalidate stored IS credentials — re-provision to recover.
SYNAP_SERVICE_ENCRYPTION_KEY=$SYNAP_SERVICE_ENCRYPTION_KEY

# ── Secrets vault ─────────────────────────────────────────────────────────────
# Used for add-on provisioning (OpenClaw, ZeroClaw bootstrap credentials).
VAULT_SERVER_KEY=$VAULT_SERVER_KEY

# ── OpenClaw / Agent Setup ────────────────────────────────────────────────────
# Used by setup-openclaw.sh to create agent users and API keys on this pod.
# NOT used for CP trust — seed-trust authenticates via ES256 JWT against
# CONTROL_PLANE_URL, no shared secret required.
PROVISIONING_TOKEN=$PROVISIONING_TOKEN

# ── Pod Public URL ────────────────────────────────────────────────────────────
# MUST match the public HTTPS origin the browser uses to reach this pod.
# Used as:
#   1) Handshake JWT audience check — CP signs handshake tokens with
#      aud=https://<this-pod-domain>, and the pod verifies aud === PUBLIC_URL.
#      If PUBLIC_URL is wrong, every handshake fails with 401.
#   2) Self-reference for any backend-side link generation (invite URLs, etc.).
# Overriding this is ONLY correct if you fronted the pod with a different
# public hostname (custom domain) — then set PUBLIC_URL to that hostname too.
PUBLIC_URL=https://$DOMAIN

# ── Control Plane Integration ─────────────────────────────────────────────────
# For Synap-managed deployments only. Leave blank for fully self-hosted setups.
# The pod verifies ALL CP JWTs by fetching /.well-known/jwks.json from this URL.
# This includes the seed-trust bootstrap JWT — no shared secret is required.
# Setting this explicitly pins which Control Plane is trusted to act on this pod.
# When blank the pod cannot accept CP provisioning calls (seed-trust returns 500).
CONTROL_PLANE_URL=${CONTROL_PLANE_URL_FLAG}

# ── Intelligence Service (Synap Agent Hub) ────────────────────────────────────
INTELLIGENCE_HUB_URL=${INTELLIGENCE_URL:-}
INTELLIGENCE_HUB_API_KEY=${INTELLIGENCE_API_KEY:-}

# ── AI Providers (optional) ───────────────────────────────────────────────────
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GOOGLE_AI_API_KEY=

# ── Email — SMTP for Kratos courier (password reset, recovery codes) ──────────
# When --smtp-uri is passed (e.g. by the Synap Control Plane), real email is
# delivered. Self-hosted installs can set SYNAP_SMTP_URI or edit this directly.
# Without a real URI Kratos queues messages locally (never delivered).
SMTP_CONNECTION_URI=${SMTP_URI:-smtp://localhost:1025/}
# Example real relay: SMTP_CONNECTION_URI=smtps://resend:RESEND_API_KEY@smtp.resend.com:465

# ── Frontend / CORS ───────────────────────────────────────────────────────────
# SYNAP_BASE_DOMAIN: the pod's parent domain. The backend + realtime derive their
# credentialed CORS allowlist from this — every https://*.SYNAP_BASE_DOMAIN
# first-party surface (studio., app., devplane., relay., eve.) is trusted;
# unknown origins are denied (no reflect-all). Cross-TLD/iframe origins can be
# added explicitly via ALLOWED_ORIGINS.
SYNAP_BASE_DOMAIN=$ROOT_DOMAIN
FRONTEND_URL=https://$DOMAIN
CORS_ORIGIN=https://$DOMAIN
ALLOWED_ORIGINS=https://$DOMAIN
ENV_EOF

  chmod 600 "$INSTALL_DIR/.env"
  success "Written $INSTALL_DIR/.env"
fi

# ─── Pull images ───────────────────────────────────────────────────────────────
heading "Pulling Docker images"

cd "$INSTALL_DIR"
docker compose pull

success "Images pulled"

# ─── Start services ────────────────────────────────────────────────────────────
heading "Starting services"

info "Starting infrastructure (postgres, redis, minio, typesense, kratos)..."
docker compose up -d postgres redis minio typesense kratos-migrate

info "Waiting 8s for databases to initialize..."
sleep 8

info "Running database migrations..."
docker compose up -d kratos hydra-migrate hydra backend-migrate

info "Waiting 5s for migrations to complete..."
sleep 5

docker compose logs --tail=30 backend-migrate || true

info "Starting application services (including pod-agent for Control Plane commands)..."
# --remove-orphans frees ports held by orphaned containers from renamed/removed
# services (a common "port is already allocated" cause on update). Volumes and
# the network are untouched — non-destructive self-heal.
# ${RECREATE_FOR_CORS:+--force-recreate} only expands when the SYNAP_BASE_DOMAIN
# backfill ran this update, so the new env var actually reaches the containers.
docker compose up -d --remove-orphans ${RECREATE_FOR_CORS:+--force-recreate} backend realtime caddy pod-agent

success "All services started"

# ─── Health check ─────────────────────────────────────────────────────────────
heading "Verifying deployment"

info "Waiting 15s for services to be ready..."
sleep 15

if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then
  success "Health check passed — API is responding"
elif curl -fsS --max-time 5 "http://localhost:4000/health" >/dev/null 2>&1; then
  warn "API is up on port 4000 but HTTPS not yet ready (DNS/SSL may take a moment)"
else
  warn "Health check inconclusive — services may still be starting"
  info "Check status with: docker compose -f $INSTALL_DIR/docker-compose.yml logs -f"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
blank
heading "🎉  Synap Backend is live!"
blank
echo -e "  API:          ${BOLD}https://$DOMAIN${RESET}"
echo -e "  Health:       ${BOLD}https://$DOMAIN/health${RESET}"
echo -e "  Storage UI:   ${BOLD}https://$DOMAIN/storage${RESET}"
blank
echo -e "  Install dir:  ${BOLD}$INSTALL_DIR${RESET}"
echo -e "  Logs:         ${BOLD}docker compose -f $INSTALL_DIR/docker-compose.yml logs -f${RESET}"
echo -e "  Status:       ${BOLD}docker compose -f $INSTALL_DIR/docker-compose.yml ps${RESET}"
blank
warn "Back up ${BOLD}$INSTALL_DIR/.env${RESET} securely — it contains all secrets."

if [[ -n "$ADMIN_EMAIL" ]]; then
  blank
  heading "Next steps"
  info "1. Visit ${BOLD}https://$DOMAIN/registration${RESET} to create your admin account"
  info "   Use email: ${BOLD}$ADMIN_EMAIL${RESET}"
  info "2. To add OpenClaw (AI agent), run:"
  info "   ${BOLD}cd $INSTALL_DIR && bash setup-openclaw.sh${RESET}"
else
  blank
  heading "Next steps"
  warn "No ADMIN_EMAIL was provided."
  info "Set ${BOLD}ADMIN_EMAIL${RESET} in $INSTALL_DIR/.env, then restart:"
  info "   ${BOLD}docker compose -f $INSTALL_DIR/docker-compose.yml restart backend${RESET}"
  info "Then visit ${BOLD}https://$DOMAIN/registration${RESET} to create your account."
fi

blank
