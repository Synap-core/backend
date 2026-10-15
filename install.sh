#!/usr/bin/env bash
# ==============================================================================
# Synap pod bootstrapper (PODPROV-CONTRACT §3)
# ==============================================================================
#
# The install ENGINE is the `synap` CLI (install / update / rollback / guards).
# This file only gets a bare host to the point where the engine can run:
#
#   1. Docker (+ compose v2), curl, jq, openssl present — installed if missing
#   2. the release manifest for --release (default: the stable channel)
#   3. that release's deploy bundle (`synap` + deploy/ + kratos/),
#      checked against the manifest's sha256, unpacked into --dir (/opt/synap)
#   4. the CLI linked onto PATH (/usr/local/bin/synap), so an operator in a
#      shell finds the same engine the systemd units run
#   5. exec synap install --non-interactive --release <resolved id> [flags…]
#
# Images are pulled by digest by the engine, never built on the host.
#
# Usage:
#   curl -fsSL https://github.com/synap-core/backend/releases/download/<release>/install.sh \
#     | sudo bash -s -- --release <release> --name <name> --register-token spr_…
#
# Flags it owns: --release <id|stable|fast>, --dir <path>, --help.
# Every other flag goes to `synap install` unchanged (--name, --domain, --email,
# --edge, --register-token, --control-plane, --intelligence-url, …; see
# `synap install --help`). Flags of the retired installer are mapped below, or
# refused with their new spelling — never silently ignored.
#
# SYNAP_RELEASE_VERIFY=warn|enforce|off (default warn): the release manifest's
# cosign signature (Synap CI, keyless) is checked before its bundle is trusted.
# warn only reports a missing cosign/signature or a failed check; enforce refuses.
# ==============================================================================

set -euo pipefail

RELEASE="${SYNAP_RELEASE:-${SYNAP_DEPLOY_VERSION:-stable}}"
INSTALL_DIR="${SYNAP_DIR:-/opt/synap}"
BIN_DIR="${SYNAP_BIN_DIR:-/usr/local/bin}"
RELEASE_BASE_URL="${SYNAP_RELEASE_BASE_URL:-https://github.com/synap-core/backend/releases/download}"

die()  { echo "✗  $*" >&2; exit 1; }
info() { echo "→  $*"; }
warn() { echo "⚠  $*" >&2; }

usage() {
  sed -n '2,33p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
  exit 0
}

ARGS=()
# Environment overrides of the retired installer, kept as aliases.
[ -n "${SYNAP_DOMAIN:-}" ] && ARGS+=(--domain "$SYNAP_DOMAIN")
[ -n "${SYNAP_EMAIL:-}" ] && ARGS+=(--email "$SYNAP_EMAIL")
[ -n "${SYNAP_INTELLIGENCE_URL:-}" ] && ARGS+=(--intelligence-url "$SYNAP_INTELLIGENCE_URL")
[ -n "${SYNAP_INTELLIGENCE_API_KEY:-}" ] && ARGS+=(--intelligence-key "$SYNAP_INTELLIGENCE_API_KEY")
[ -n "${SYNAP_ADMIN_EMAIL:-}" ] && ARGS+=(--admin-email "$SYNAP_ADMIN_EMAIL")
[ -n "${SYNAP_SMTP_URI:-}" ] && ARGS+=(--smtp-uri "$SYNAP_SMTP_URI")
for legacy in SYNAP_CONTROL_PLANE_URL SYNAP_PROVISIONING_TOKEN SYNAP_BACKEND_VERSION SYNAP_POD_AGENT_VERSION; do
  [ -z "${!legacy:-}" ] || die "${legacy} is retired: register the pod with --register-token <spr_…> (and --control-plane <url>); images come from --release."
done

while [ $# -gt 0 ]; do
  case "$1" in
    --release|--deploy-version)
      [ $# -ge 2 ] || die "$1 needs a value"
      RELEASE="$2"; shift 2 ;;
    --dir)
      [ $# -ge 2 ] || die "--dir needs a value"
      INSTALL_DIR="$2"; shift 2 ;;
    --help|-h) usage ;;
    # Retired spellings — fail loudly with the new one.
    --backend-version|--pod-agent-version)
      die "$1 is retired: every image is pinned by digest in the release manifest — use --release <id>." ;;
    --control-plane-url)
      die "--control-plane-url is retired: a pod trusts a Control Plane only by registering — use --register-token <spr_…> --control-plane <url>." ;;
    --provisioning-token)
      die "--provisioning-token is retired: each pod generates its own; the owner comes from --register-token <spr_…>." ;;
    --token)
      die "--token is not a flag: use --register-token <spr_…>." ;;
    --non-interactive|--automated)
      shift ;;  # always non-interactive
    *)
      ARGS+=("$1"); shift ;;
  esac
done

case "$RELEASE" in
  main) die "'main' is not a release: use --release fast (latest main build) or --release stable." ;;
esac

# ─── 1. Prerequisites ─────────────────────────────────────────────────────────
need_root() {
  [ "$(id -u)" = 0 ] || die "$1 — re-run as root (sudo bash …)."
}
apt_install() {
  command -v apt-get >/dev/null 2>&1 || die "missing $* and no apt-get to install it — install it, then re-run."
  need_root "installing $*"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
}
for tool in curl tar jq openssl; do
  command -v "$tool" >/dev/null 2>&1 || apt_install "$tool"
done
if ! command -v docker >/dev/null 2>&1; then
  need_root "installing Docker"
  info "Installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose version failed)."

# ─── 2. Release manifest ──────────────────────────────────────────────────────
manifest_url() { # <release> [asset]
  case "$1" in
    fast|stable) echo "${RELEASE_BASE_URL}/channel-$1/${2:-release.json}" ;;
    *)           echo "${RELEASE_BASE_URL}/$1/${2:-release.json}" ;;
  esac
}
fetch() { curl -fsSL --retry 3 --max-time 300 -o "$2" "$1"; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# D12 — CI signs every release.json keyless (docker-publish.yml publish-release)
# on the release AND on the channel pointer. This is the SAME rule `synap`
# applies in `_ue_verify_manifest_sig` (update/install): the two identity
# constants below are byte-for-byte copies of the ones in `synap`, pinned equal
# by deploy/__tests__/install-manifest-signature.test.sh — change both or neither.
# warn (default): a missing cosign, missing bundle or failed check WARNS and the
# install goes on; enforce: any of them refuses; off: skip (a private mirror).
SYNAP_RELEASE_SIGNER_RE='^https://github\.com/(?i:synap-core/backend)/\.github/workflows/docker-publish\.yml@refs/(heads/main|tags/v[0-9][0-9A-Za-z.+-]*)$'
SYNAP_RELEASE_OIDC_ISSUER="https://token.actions.githubusercontent.com"

verify_manifest_sig() { # <release> <manifest> — non-zero only under enforce
  local mode="${SYNAP_RELEASE_VERIFY:-warn}" bundle="$2.sigstore.json" why="" out
  case "$mode" in
    warn|enforce) ;;
    off) return 0 ;;
    *) warn "SYNAP_RELEASE_VERIFY=${mode} is not warn|enforce|off — using warn"; mode=warn ;;
  esac
  rm -f "$bundle"
  if ! command -v cosign >/dev/null 2>&1; then
    why="cosign is not installed"
  elif ! fetch "$(manifest_url "$1" release.json.sigstore.json)" "$bundle" 2>/dev/null; then
    why="no signature (release.json.sigstore.json) is published for '$1'"
  elif ! out="$(cosign verify-blob --bundle "$bundle" \
          --certificate-identity-regexp "$SYNAP_RELEASE_SIGNER_RE" \
          --certificate-oidc-issuer "$SYNAP_RELEASE_OIDC_ISSUER" "$2" 2>&1)"; then
    why="the signature does not verify as Synap CI ($(printf '%s' "$out" | tail -1))"
  else
    info "release manifest signature verified (Synap CI, keyless)"
    return 0
  fi
  if [ "$mode" = enforce ]; then
    echo "✗  release manifest for '$1' refused: ${why} (SYNAP_RELEASE_VERIFY=enforce)" >&2
    return 1
  fi
  warn "release manifest for '$1' is NOT signature-verified: ${why} — continuing (SYNAP_RELEASE_VERIFY=warn)"
  return 0
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
info "Resolving release '${RELEASE}'"
fetch "$(manifest_url "$RELEASE")" "$WORK/release.json" \
  || die "could not fetch the release manifest $(manifest_url "$RELEASE")"
verify_manifest_sig "$RELEASE" "$WORK/release.json" || exit 1
ID="$(jq -r '.id // empty' "$WORK/release.json")"
ASSET="$(jq -r '.bundle.asset // empty' "$WORK/release.json")"
WANT="$(jq -r '.bundle.sha256 // empty' "$WORK/release.json")"
[ -n "$ID" ] || die "the release manifest has no id"
[ -n "$ASSET" ] && [ -n "$WANT" ] || die "release ${ID} ships no deploy bundle — it cannot be installed on a bare host."

# ─── 3. Deploy bundle ─────────────────────────────────────────────────────────
if [ -f "$INSTALL_DIR/deploy/.env" ]; then
  # Already installed: the engine owns every later change (backup, canary,
  # rollback). Re-running the same release just re-enters `synap install`,
  # which is idempotent; another release goes through `synap update`.
  CURRENT="$(jq -r '.id // empty' "$INSTALL_DIR/deploy/state/current-release.json" 2>/dev/null || true)"
  [ "$CURRENT" = "$ID" ] || [ -z "$CURRENT" ] \
    || die "${INSTALL_DIR} already runs release ${CURRENT} — to move to ${ID}, run: synap update --release ${ID}"
  [ -f "$INSTALL_DIR/synap" ] || die "${INSTALL_DIR}/deploy/.env exists but ${INSTALL_DIR}/synap does not — not touching it."
  info "Release ${ID} is already unpacked in ${INSTALL_DIR}"
else
  info "Downloading deploy bundle ${ASSET}"
  fetch "$(manifest_url "$ID" "$ASSET")" "$WORK/bundle.tgz" || die "could not download ${ASSET}"
  GOT="$(sha256 "$WORK/bundle.tgz")"
  [ "$GOT" = "$WANT" ] || die "deploy bundle sha256 mismatch (manifest ${WANT}, got ${GOT})"
  mkdir -p "$WORK/bundle"
  tar -xzf "$WORK/bundle.tgz" -C "$WORK/bundle" || die "deploy bundle is not a valid tar.gz"
  [ -f "$WORK/bundle/synap" ] && [ -f "$WORK/bundle/deploy/docker-compose.yml" ] \
    || die "deploy bundle lacks synap + deploy/docker-compose.yml"
  mkdir -p "$INSTALL_DIR"
  cp -R "$WORK/bundle/." "$INSTALL_DIR/"
  chmod 755 "$INSTALL_DIR/synap"
fi

# ─── 4. The engine on PATH (operators) ────────────────────────────────────────
if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
  ln -sfn "$INSTALL_DIR/synap" "$BIN_DIR/synap"
else
  need_root "linking ${BIN_DIR}/synap"
fi

# ─── 5. Hand over to the engine ───────────────────────────────────────────────
info "Running: synap install --non-interactive --release ${ID} (in ${INSTALL_DIR})"
cd "$INSTALL_DIR"
# SYNAP_DEPLOY_DIR: the bundle has no .git, so name the deploy dir explicitly —
# the engine's project pin and update lock resolve it before any cd.
SYNAP_DEPLOY_DIR="$INSTALL_DIR/deploy" \
  exec bash "$INSTALL_DIR/synap" install --non-interactive --release "$ID" ${ARGS[@]+"${ARGS[@]}"}
