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

RAW_BASE="https://raw.githubusercontent.com/Synap-core/backend/main"

# ─── Defaults (override via env or flags) ─────────────────────────────────────
INSTALL_DIR="${SYNAP_DIR:-/srv/synap}"
DOMAIN="${SYNAP_DOMAIN:-}"
LETSENCRYPT_EMAIL="${SYNAP_EMAIL:-}"
INTELLIGENCE_URL="${SYNAP_INTELLIGENCE_URL:-}"
INTELLIGENCE_API_KEY="${SYNAP_INTELLIGENCE_API_KEY:-}"
ADMIN_EMAIL="${SYNAP_ADMIN_EMAIL:-}"

# ─── CLI flags ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)           DOMAIN="$2";             shift 2 ;;
    --dir)              INSTALL_DIR="$2";         shift 2 ;;
    --email)            LETSENCRYPT_EMAIL="$2";   shift 2 ;;
    --intelligence-url) INTELLIGENCE_URL="$2";    shift 2 ;;
    --intelligence-key) INTELLIGENCE_API_KEY="$2"; shift 2 ;;
    --admin-email)      ADMIN_EMAIL="$2";         shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

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

# ─── Download config files ─────────────────────────────────────────────────────
heading "Downloading configuration files"

_download() {
  local src="$1" dst="$2"
  info "Fetching $src"
  curl -fsSL "$RAW_BASE/$src" -o "$dst" || error "Failed to download $src"
}

_download "deploy/docker-compose.standalone.yml"           "$INSTALL_DIR/docker-compose.yml"
_download "deploy/Caddyfile"                               "$INSTALL_DIR/Caddyfile"
_download "kratos/identity.schema.json"                    "$INSTALL_DIR/config/kratos/identity.schema.json"
_download "kratos/oidc.github.jsonnet"                     "$INSTALL_DIR/config/kratos/oidc.github.jsonnet"
_download "kratos/oidc.google.jsonnet"                     "$INSTALL_DIR/config/kratos/oidc.google.jsonnet"
_download "docker/postgres/init-databases.sh"              "$INSTALL_DIR/config/postgres/init-databases.sh"

chmod +x "$INSTALL_DIR/config/postgres/init-databases.sh"

success "Config files downloaded"

# ─── Generate Kratos config ────────────────────────────────────────────────────
heading "Generating Kratos config"

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
      enabled: true
      allowed_origins:
        - https://$DOMAIN
      allowed_headers:
        - Authorization
        - Content-Type
        - Cookie
      exposed_headers:
        - Content-Type
        - Set-Cookie
      allow_credentials: true
  admin:
    base_url: http://kratos:4434

selfservice:
  default_browser_return_url: https://$DOMAIN/
  allowed_return_urls:
    - https://$DOMAIN

  methods:
    password:
      enabled: true
    oidc:
      enabled: false

  flows:
    login:
      ui_url: https://$DOMAIN/login
      lifespan: 10m
    registration:
      ui_url: https://$DOMAIN/registration
      lifespan: 10m
    recovery:
      enabled: true
      ui_url: https://$DOMAIN/recovery
    settings:
      ui_url: https://$DOMAIN/settings
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
        default_browser_return_url: https://$DOMAIN/login

session:
  cookie:
    domain: $DOMAIN
    same_site: Lax

identity:
  default_schema_id: default
  schemas:
    - id: default
      url: file:///etc/config/kratos/identity.schema.json

courier:
  smtp:
    connection_uri: \${SMTP_CONNECTION_URI:-smtp://localhost:1025/?skip_ssl_verify=true}
    from_address: noreply@$DOMAIN
    from_name: Synap
KRATOS_EOF

success "Kratos config written"

# ─── Generate secrets (skip if updating) ──────────────────────────────────────
if [[ "$UPDATE_ONLY" == "true" ]]; then
  heading "Skipping secret regeneration (update mode)"
  info "Using existing .env at $INSTALL_DIR/.env"
else
  heading "Generating secrets"

  _gen() { openssl rand -hex 32; }

  POSTGRES_PASSWORD=$(_gen)
  MINIO_SECRET_KEY=$(_gen)
  TYPESENSE_API_KEY=$(_gen)
  TYPESENSE_ADMIN_API_KEY=$(_gen)
  JWT_SECRET=$(_gen)
  ENCRYPTION_KEY=$(_gen)
  KRATOS_SECRETS_COOKIE=$(_gen)
  KRATOS_SECRETS_CIPHER=$(_gen)
  KRATOS_WEBHOOK_SECRET=$(_gen)
  ORY_HYDRA_SECRETS_SYSTEM=$(_gen)
  HUB_PROTOCOL_API_KEY=$(_gen)
  HUB_JWT_SECRET=$(_gen)

  success "Secrets generated"

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

# ── Image versions ─────────────────────────────────────────────────────────────
BACKEND_VERSION=latest

# ── Admin (first user) ────────────────────────────────────────────────────────
ADMIN_EMAIL=${ADMIN_EMAIL:-}

# ── PostgreSQL ────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

# ── MinIO (Object Storage) ────────────────────────────────────────────────────
MINIO_ACCESS_KEY=synap
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

# ── Control Plane Integration ─────────────────────────────────────────────────
# For Synap-managed deployments only. Leave blank for fully self-hosted setups.
# The pod verifies CP JWTs by fetching /.well-known/jwks.json from CONTROL_PLANE_URL.
# No shared secret required — only the public URL is needed here.
CONTROL_PLANE_URL=

# ── Intelligence Service (Synap Agent Hub) ────────────────────────────────────
INTELLIGENCE_HUB_URL=${INTELLIGENCE_URL:-}
INTELLIGENCE_HUB_API_KEY=${INTELLIGENCE_API_KEY:-}

# ── AI Providers (optional) ───────────────────────────────────────────────────
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GOOGLE_AI_API_KEY=

# ── Email (optional — configure SMTP for user notifications) ──────────────────
# SMTP_CONNECTION_URI=smtps://user:pass@smtp.example.com:465

# ── Frontend / CORS ───────────────────────────────────────────────────────────
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

info "Starting application services..."
docker compose up -d backend realtime caddy

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
  info "Admin account: ${BOLD}$ADMIN_EMAIL${RESET}"
  info "Visit ${BOLD}https://$DOMAIN/registration${RESET} to set your password."
fi

blank
