#!/usr/bin/env bash
# Ship @synap-core/api-types to npm — regenerate router surface, lockstep version, publish.
#
# Preferred entry from monorepo root:
#   ./dev ship api-types                  # interactive menu
#   ./dev ship api-types verify           # local vs npm + surface drift
#   ./dev ship api-types bump [--force]   # regen; bump if surface changed (or always with --force)
#   ./dev ship api-types publish          # ★ happy path: regen → ensure new version → build → npm
#   ./dev ship api-types publish 1.27.0   # explicit version then publish
#   ./dev ship api-types publish --force-bump  # always patch-bump even if surface unchanged
#   ./dev ship api-types dry-run
#   ./dev ship api-types --yes …
#
# Happy-path rules (UX):
#   • `publish` is the one command you usually need.
#   • If the router surface changed → auto patch-bump (lockstep stamps) then publish.
#   • If surface unchanged AND version already on npm → exit 0 "nothing to ship"
#     (not a hard error). Use --force-bump or an explicit version to republish.
#   • `bump` alone never lies about next steps: if nothing changed and already on
#     npm, it does NOT say "then publish".
#
# Version stamps (same as check-and-bump.mjs):
#   package.json · src/version.ts · apps/api /health apiTypesVersion
#
# Full IS contracts (tgz + repins): cd synap-backend && pnpm contracts:publish

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
API_DIR="$BACKEND_ROOT/packages/api"
PKG_NAME="@synap-core/api-types"

MODE="${1:-}"
shift || true

YES="${YES:-0}"
DO_BUMP=0          # run check-and-bump (surface-gated)
FORCE_BUMP=0       # always bump even if surface unchanged
BUMP_KIND="patch"  # patch|minor|major
EXPLICIT_VERSION=""
FULL_API_BUILD=0
SKIP_GEN=0
NPM_TAG="latest"
# 2FA: npm profile is auth-and-writes → publish needs OTP or an Automation token.
# Prefer:  ./dev ship api-types publish --otp=123456
# Or:      NPM_OTP=123456 ./dev ship api-types publish
NPM_OTP="${NPM_OTP:-}"
LEGACY_AUTH="${LEGACY_AUTH:-}"   # opt-in: force npm auth-type=legacy (see do_npm_publish)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --bump) DO_BUMP=1 ;;
    --force|--force-bump) FORCE_BUMP=1; DO_BUMP=1 ;;
    --patch) BUMP_KIND=patch; DO_BUMP=1 ;;
    --minor) BUMP_KIND=minor; DO_BUMP=1 ;;
    --major) BUMP_KIND=major; DO_BUMP=1 ;;
    --full) FULL_API_BUILD=1 ;;
    --skip-gen) SKIP_GEN=1 ;;
    --tag) NPM_TAG="${2:-latest}"; shift ;;
    --otp)
      NPM_OTP="${2:-}"
      [[ -n "$NPM_OTP" ]] || { echo "✗ --otp needs a 6-digit code" >&2; exit 1; }
      shift
      ;;
    --otp=*)
      NPM_OTP="${1#--otp=}"
      ;;
    --legacy-auth) LEGACY_AUTH=1 ;;
    --version)
      EXPLICIT_VERSION="${2:-}"
      [[ -n "$EXPLICIT_VERSION" ]] || { echo "✗ --version needs a semver" >&2; exit 1; }
      shift
      ;;
    -*)
      echo "✗ unknown flag: $1" >&2
      exit 1
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$ ]]; then
        EXPLICIT_VERSION="$1"
      else
        echo "✗ unexpected argument: $1" >&2
        exit 1
      fi
      ;;
  esac
  shift || true
done

log() { printf '\n→ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
warn() { printf '⚠  %s\n' "$*" >&2; }
ok() { printf '  ✓ %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

pkg_version() {
  node -p "require('$PKG_DIR/package.json').version"
}

npm_published() {
  npm view "$PKG_NAME" version 2>/dev/null || true
}

# next_semver current kind → prints major.minor.patch
next_semver() {
  node -e '
const [v, kind] = process.argv.slice(1);
const core = v.trim().replace(/^v/i, "").split(/[-+]/)[0];
let [maj, min, pat] = core.split(".").map((n) => parseInt(n, 10));
if ([maj, min, pat].some(Number.isNaN)) { console.error("bad semver", v); process.exit(1); }
if (kind === "major") { maj += 1; min = 0; pat = 0; }
else if (kind === "minor") { min += 1; pat = 0; }
else { pat += 1; }
console.log(`${maj}.${min}.${pat}`);
' "$1" "$2"
}

# semver_cmp a b → exit 0 equal, 1 a>b, 2 a<b
semver_cmp() {
  node -e '
const a = process.argv[1].split(".").map(Number);
const b = process.argv[2].split(".").map(Number);
for (let i = 0; i < 3; i++) {
  const x = a[i] || 0, y = b[i] || 0;
  if (x > y) process.exit(1);
  if (x < y) process.exit(2);
}
process.exit(0);
' "$1" "$2"
}

prompt_yn() {
  local q="$1" default="${2:-n}" ans
  # Explicit --yes / YES=1 always confirms.
  if [[ "$YES" == "1" ]]; then return 0; fi
  # Non-interactive (piped/CI) must pass --yes — never auto-confirm a publish.
  if [[ ! -t 0 ]]; then
    echo "✗ non-interactive session — re-run with --yes to confirm: $q" >&2
    return 1
  fi
  if [[ "$default" == "y" ]]; then
    read -r -p "$q [Y/n] " ans || true
    ans="$(printf '%s' "${ans:-y}" | tr '[:upper:]' '[:lower:]')"
    [[ "$ans" != "n" && "$ans" != "no" ]]
  else
    read -r -p "$q [y/N] " ans || true
    ans="$(printf '%s' "${ans:-n}" | tr '[:upper:]' '[:lower:]')"
    [[ "$ans" == "y" || "$ans" == "yes" ]]
  fi
}

print_npm_auth_help() {
  cat <<'EOF' >&2

── npm publish auth ──────────────────────────────────────────────────────────
You are already logged in (npm whoami works). Publish still needs a 2FA step
because your account is two-factor auth = "auth-and-writes".

WHICH SECOND FACTOR DO YOU HAVE? This decides everything below.

  • SECURITY KEY / PASSKEY (WebAuthn) → the WEB flow is required. npm opens
    https://www.npmjs.com/login/<id> and you approve there. A security key
    cannot produce a 6-digit code, so an "Enter OTP:" prompt means the flow
    fell back to legacy and is unanswerable.
      Fix:  npm config delete auth-type    (npm 10 defaults to `web`)
    Do not pass --legacy-auth or --otp with a security key.

  • AUTHENTICATOR APP (TOTP) → either flow works; type the 6 digits, or pass
    --otp=123456 to skip the prompt.

This script does NOT force an auth type — it inherits your npm config.
`--legacy-auth` is an opt-in escape hatch for one historical failure: a web
flow that 404'd on /-/v1/done?authId=… . Use it only with a TOTP app.

Optional shortcuts:
  ./dev ship api-types publish --otp=123456     # skip the prompt
  Automation token (CI / no OTP ever):
    npmjs.com → Access Tokens → Classic → Automation
    npm config set //registry.npmjs.org/:_authToken=npm_…

Diagnose:  ./dev ship api-types auth
EOF
}

# Publish using the caller's existing npm login.
# Interactive TTY: npm prompts for OTP (2FA). Non-TTY: need --otp or Automation token.
#
# Auth type is INHERITED, not forced (--legacy-auth opts in):
#   Forcing legacy used to be the default here, to route around a web flow that
#   404'd on /-/v1/done?authId=… . That is the WRONG default for a SECURITY KEY /
#   passkey account: legacy prints the "open this URL to use your security key"
#   link and then blocks on `Enter OTP:` — which a security key cannot produce.
#   Hit for real on 2026-09-07. npm 10 defaults to `web`, which is what a
#   security key needs; --legacy-auth remains for the historical 404, TOTP only.
#
# Why pnpm --filter (not bare npm in the package dir):
#   api-types depends on workspace:* — pnpm rewrites those to real versions on publish.
do_npm_publish() {
  local ver="$1"
  local who
  who="$(npm whoami 2>/dev/null || echo '?')"

  if [[ -n "$NPM_OTP" ]]; then
    info "using your npm login ($who) + OTP from --otp / NPM_OTP"
  elif [[ -t 0 && -t 1 ]]; then
    info "using your npm login ($who)"
    info "when prompted, enter the 6-digit code from your authenticator app"
  else
    warn "non-interactive — pass --otp=XXXXXX or use an Automation token"
  fi

  log "pnpm publish $PKG_NAME@$ver${LEGACY_AUTH:+ (auth-type=legacy, forced)}"

  local -a cmd=(
    pnpm --filter "$PKG_NAME" publish
    --access public
    --no-git-checks
    --tag "$NPM_TAG"
  )
  if [[ -n "$NPM_OTP" ]]; then
    cmd+=(--otp "$NPM_OTP")
  fi

  set +e
  (
    cd "$BACKEND_ROOT"
    # AUTH TYPE IS NOT FORCED — inherit the user's npm config.
    #
    # This used to export auth-type=legacy unconditionally, to route around a
    # web flow that once 404'd on `/-/v1/done?authId=…`. That is the WRONG
    # default for a SECURITY KEY / passkey account: legacy prints the
    # "Open https://www.npmjs.com/login/… to use your security key" URL and then
    # blocks on `Enter OTP:` — which a security key can never produce, because it
    # is not a TOTP authenticator. The publish hangs on an unanswerable prompt.
    # (Hit for real on 2026-09-07.)
    #
    # npm 10 defaults to `web`, which is what a security key needs. Legacy is now
    # opt-in via --legacy-auth, for the historical 404 case only.
    if [[ -n "${LEGACY_AUTH:-}" ]]; then
      export NPM_CONFIG_AUTH_TYPE=legacy
      export npm_config_auth_type=legacy
    fi
    "${cmd[@]}"
  )
  local rc=$?
  set -e
  return $rc
}

cmd_auth() {
  ensure_layout
  need_cmd npm
  log "npm auth diagnostics for $PKG_NAME"
  local user tfa
  user="$(npm whoami 2>/dev/null || true)"
  if [[ -z "$user" ]]; then
    warn "not logged in (npm whoami failed)"
    info "run: npm login   OR set //registry.npmjs.org/:_authToken"
  else
    ok "whoami: $user"
  fi
  info "registry:  $(npm config get registry)"
  info "auth-type: $(npm config get auth-type 2>/dev/null || echo default)"
  # profile (2FA mode)
  local profile
  profile="$(npm profile get 2>/dev/null || true)"
  if [[ -n "$profile" ]]; then
    tfa="$(printf '%s\n' "$profile" | awk -F': ' '/two-factor auth/ {print $2; exit}')"
    info "2FA mode:  ${tfa:-unknown}"
    if [[ "$tfa" == *auth-and-writes* ]]; then
      ok "2FA=auth-and-writes — publish needs a second factor"
      info "auth-type is INHERITED from your npm config, not forced by this script."
      info "  security key / passkey → needs auth-type=web (npm config delete auth-type)"
      info "  authenticator app      → either flow; --otp=XXXXXX skips the prompt"
    fi
  fi
  # package rights
  if npm view "$PKG_NAME" version >/dev/null 2>&1; then
    ok "can read $PKG_NAME@$(npm_published) from registry"
  else
    warn "cannot npm view $PKG_NAME"
  fi
  info "org owner / access: you should have read-write on @synap-core/api-types"
  if npm access list packages @synap-core 2>/dev/null | grep -q "api-types"; then
    ok "access list includes api-types"
  fi
  if [[ -n "$NPM_OTP" ]]; then
    ok "OTP provided for this run (--otp / NPM_OTP)"
  elif [[ -t 0 && -t 1 ]]; then
    ok "interactive terminal — publish will use your login and prompt for OTP"
  else
    info "non-interactive — pass --otp= or Automation token"
  fi
  print_npm_auth_help
}

menu() {
  local ver live
  ver="$(pkg_version)"
  live="$(npm_published)"
  cat <<EOF

@synap-core/api-types ship helper
─────────────────────────────────
  package.json:  $ver
  npm latest:    ${live:-unknown}
  backend:       $BACKEND_ROOT

  1) verify     — local vs npm + surface drift
  2) prepare    — regen + plan (no publish)
  3) bump       — regen; version++ if surface changed
                  (--force always bumps)
  4) build      — gen-types + package build
  5) publish    — ★ regen → ensure unpublished version → npm
  6) dry-run    — build + publish --dry-run
  7) auth       — diagnose npm login / 2FA / OTP (E404 helper)
  q) quit

  Usual path:     ./dev ship api-types publish
                  (uses your npm login; prompts for 2FA OTP in the terminal)
  Force new ver:  ./dev ship api-types publish --force-bump
  Explicit ver:   ./dev ship api-types publish 1.27.0
  Auth debug:     ./dev ship api-types auth

EOF
  local choice
  read -r -p "Choice [1-7/q]: " choice || true
  case "${choice:-}" in
    1|verify) MODE=verify ;;
    2|prepare) MODE=prepare ;;
    3|bump) MODE=bump ;;
    4|build) MODE=build ;;
    5|publish) MODE=publish ;;
    6|dry-run|dry) MODE=dry-run ;;
    7|auth) MODE=auth ;;
    q|Q|quit) exit 0 ;;
    *) die "invalid choice" ;;
  esac
}

ensure_layout() {
  [[ -d "$API_DIR" ]] || die "api package missing: $API_DIR"
  [[ -f "$PKG_DIR/package.json" ]] || die "api-types package.json missing"
  need_cmd pnpm
  need_cmd node
}

# ── version lockstep ─────────────────────────────────────────────────────────

set_explicit_version() {
  local next="$1"
  need_cmd node
  log "Set version → $next (lockstep: package.json + version.ts + /health)"
  node - "$next" "$PKG_DIR" "$BACKEND_ROOT" <<'NODE'
const fs = require("fs");
const path = require("path");
const [next, pkgDir, backend] = process.argv.slice(2);
const pkgPath = path.join(pkgDir, "package.json");
const versionTs = path.join(pkgDir, "src", "version.ts");
const healthTs = path.join(backend, "apps", "api", "src", "index.ts");

if (!/^\d+\.\d+\.\d+([.-].*)?$/.test(next)) {
  console.error("✗ invalid semver:", next);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const prev = pkg.version;
if (prev === next) {
  console.log("   already at", next);
  process.exit(0);
}
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("   package.json", prev, "→", next);

function replace(file, re, replacement, label) {
  const before = fs.readFileSync(file, "utf8");
  if (!re.test(before)) {
    console.error("✗ could not find", label, "in", file);
    process.exit(1);
  }
  fs.writeFileSync(file, before.replace(re, replacement));
  console.log("   ", label);
}
replace(
  versionTs,
  /export const API_TYPES_VERSION = "[^"]*";/,
  `export const API_TYPES_VERSION = "${next}";`,
  "API_TYPES_VERSION",
);
if (fs.existsSync(healthTs)) {
  replace(
    healthTs,
    /apiTypesVersion: "[^"]*",/,
    `apiTypesVersion: "${next}",`,
    "/health apiTypesVersion",
  );
} else {
  console.warn("   skip health stamp (missing", healthTs + ")");
}
NODE
}

force_bump_version() {
  local kind="${1:-patch}"
  local cur next
  cur="$(pkg_version)"
  next="$(next_semver "$cur" "$kind")"
  log "Force ${kind} bump (surface-gated bump was a no-op or skipped)"
  info "$cur → $next"
  set_explicit_version "$next"
}

# ── build ────────────────────────────────────────────────────────────────────

regen_types() {
  if [[ "$SKIP_GEN" == "1" ]]; then
    info "skip gen-types (--skip-gen)"
    return
  fi
  if [[ "$FULL_API_BUILD" == "1" ]]; then
    log "Full @synap/api build (includes gen-types)"
    (cd "$BACKEND_ROOT" && pnpm --filter @synap/api build)
  else
    log "Regenerate router types (api → gen-types)"
    (cd "$API_DIR" && pnpm gen-types)
  fi
}

build_package() {
  log "Build $PKG_NAME"
  (cd "$BACKEND_ROOT" && pnpm --filter "$PKG_NAME" build)
  ok "built $(pkg_version)"
}

cmd_build() {
  ensure_layout
  regen_types
  build_package
}

# ── commands ─────────────────────────────────────────────────────────────────

cmd_verify() {
  ensure_layout
  need_cmd npm
  local ver live
  ver="$(pkg_version)"
  live="$(npm_published)"
  log "Verify $PKG_NAME"
  info "local:  $ver"
  info "npm:    ${live:-<not found>}"
  if [[ -n "$live" && "$live" == "$ver" ]]; then
    ok "versions match (already published)"
  elif [[ -n "$live" ]]; then
    set +e
    semver_cmp "$ver" "$live"
    local cmp=$?
    set -e
    if [[ $cmp -eq 1 ]]; then
      ok "local $ver is ahead of npm $live — ready to publish"
    else
      warn "local $ver is behind npm $live — bump or pull"
    fi
  else
    warn "could not read npm (offline / private?)"
  fi

  log "Surface drift gate (check-and-bump --check)"
  if (cd "$PKG_DIR" && node scripts/check-and-bump.mjs --check); then
    ok "generated surface is in sync with version stamps"
  else
    die "surface drifted without a version bump — run: ./dev ship api-types bump"
  fi

  if [[ -f "$PKG_DIR/scripts/check-publish-freshness.mjs" ]]; then
    log "Published-tarball freshness (best-effort)"
    (cd "$PKG_DIR" && node scripts/check-publish-freshness.mjs) || warn "freshness check failed (non-fatal)"
  fi
}

cmd_prepare() {
  ensure_layout
  need_cmd npm
  local ver live
  ver="$(pkg_version)"
  live="$(npm_published)"
  log "Prepare — plan only"
  info "local:  $ver"
  info "npm:    ${live:-unknown}"

  log "Dry report (check-and-bump --dry-run)"
  (cd "$PKG_DIR" && node scripts/check-and-bump.mjs --dry-run) || true

  echo
  if [[ -n "$live" && "$live" == "$ver" ]]; then
    info "Already live on npm as $ver."
    info "  surface change later → ./dev ship api-types publish"
    info "  force new version    → ./dev ship api-types publish --force-bump"
    info "  explicit version     → ./dev ship api-types publish 1.x.y"
  else
    info "Next: ./dev ship api-types publish"
  fi
}

cmd_bump() {
  ensure_layout
  need_cmd npm
  local before after live
  before="$(pkg_version)"
  live="$(npm_published)"

  log "Bump ($BUMP_KIND) — regenerates types; bumps only if router surface changed"
  info "before: $before   npm: ${live:-unknown}"
  (cd "$PKG_DIR" && node scripts/check-and-bump.mjs "--$BUMP_KIND")
  after="$(pkg_version)"

  echo
  if [[ "$after" != "$before" ]]; then
    ok "bumped $before → $after"
    info "next:  ./dev ship api-types publish"
    info "       (or combine: ./dev ship api-types publish — it auto-bumps when needed)"
    return 0
  fi

  # Surface unchanged — check-and-bump was a no-op
  if [[ "$FORCE_BUMP" == "1" ]]; then
    force_bump_version "$BUMP_KIND"
    after="$(pkg_version)"
    ok "force-bumped → $after"
    info "next:  ./dev ship api-types publish"
    return 0
  fi

  info "Router surface unchanged — version stays $after"
  if [[ -n "$live" && "$live" == "$after" ]]; then
    ok "already published on npm as $after — nothing to bump"
    echo
    info "There is nothing to publish either (same surface + same version)."
    info "  Want a new version anyway?  ./dev ship api-types bump --force"
    info "  Or one-shot:               ./dev ship api-types publish --force-bump"
    info "  Or explicit:               ./dev ship api-types publish 1.x.y"
    return 0
  fi

  if [[ -n "$live" ]]; then
    set +e
    semver_cmp "$after" "$live"
    local cmp=$?
    set -e
    if [[ $cmp -eq 1 ]]; then
      ok "local $after is already ahead of npm $live — no bump needed"
      info "next:  ./dev ship api-types publish"
      return 0
    fi
  fi

  warn "no version change"
  info "force a bump:  ./dev ship api-types bump --force"
}

# Ensure package.json version is not already the npm latest.
# Returns 0 if we have a publishable version, 1 if nothing to ship (caller exits 0).
ensure_publishable_version() {
  local ver live
  ver="$(pkg_version)"
  live="$(npm_published)"

  if [[ -z "$live" ]]; then
    info "npm version unknown — will try publish of $ver"
    return 0
  fi

  if [[ "$live" != "$ver" ]]; then
    set +e
    semver_cmp "$ver" "$live"
    local cmp=$?
    set -e
    if [[ $cmp -eq 1 ]]; then
      ok "local $ver is ahead of npm $live"
      return 0
    fi
    if [[ $cmp -eq 2 ]]; then
      warn "local $ver is behind npm $live"
      if [[ "$FORCE_BUMP" == "1" ]] || [[ "$DO_BUMP" == "1" ]]; then
        force_bump_version "$BUMP_KIND"
        return 0
      fi
      die "local version behind npm — run: ./dev ship api-types publish --force-bump"
    fi
  fi

  # live == ver
  if [[ "$FORCE_BUMP" == "1" ]]; then
    force_bump_version "$BUMP_KIND"
    return 0
  fi

  # Default publish: already live + no force = nothing to do (success, not error)
  return 1
}

cmd_publish() {
  ensure_layout
  need_cmd npm

  local before after live
  before="$(pkg_version)"
  live="$(npm_published)"

  log "Publish $PKG_NAME"
  info "local:  $before   npm: ${live:-unknown}"

  # ── 1. resolve version ────────────────────────────────────────────────────
  if [[ -n "$EXPLICIT_VERSION" ]]; then
    set_explicit_version "$EXPLICIT_VERSION"
    regen_types
  else
    # Surface-gated bump first (default for publish — keeps types fresh + auto-bumps on real change)
    log "Regen + surface-gated bump ($BUMP_KIND) via check-and-bump"
    (cd "$PKG_DIR" && node scripts/check-and-bump.mjs "--$BUMP_KIND")
    after="$(pkg_version)"
    if [[ "$after" != "$before" ]]; then
      ok "surface changed — bumped $before → $after"
    else
      info "surface unchanged at $after"
    fi

    if ! ensure_publishable_version; then
      after="$(pkg_version)"
      live="$(npm_published)"
      echo
      ok "Nothing to ship — $PKG_NAME@$after is already on npm with the current router surface."
      info "That is expected after a no-op bump when nothing in the API contract changed."
      echo
      info "If you still need a new version (e.g. republish / pin churn):"
      info "  ./dev ship api-types publish --force-bump"
      info "  ./dev ship api-types publish 1.x.y"
      exit 0
    fi
  fi

  # ── 2. build package (gen-types already ran via check-and-bump or explicit path)
  build_package

  local ver
  ver="$(pkg_version)"
  live="$(npm_published)"

  # Safety: never try to overwrite same version on npm
  if [[ -n "$live" && "$live" == "$ver" ]]; then
    die "refusing to publish: npm already has $PKG_NAME@$ver (internal bug — ensure_publishable_version should have bumped)"
  fi

  log "Upload $PKG_NAME@$ver → registry.npmjs.org (tag=$NPM_TAG)"
  info "npm currently: ${live:-unknown}"
  info "session:       $(npm whoami 2>/dev/null || echo 'not logged in')"

  if ! npm whoami >/dev/null 2>&1; then
    die "not logged in to npm — run: npm login   then re-run ./dev ship api-types publish"
  fi

  # Interactive: confirm then let npm prompt for 2FA OTP using YOUR login.
  # Non-interactive without --otp: fail early with auth help.
  if [[ ! -t 0 || ! -t 1 ]] && [[ -z "$NPM_OTP" ]] && [[ "$YES" != "1" ]]; then
    print_npm_auth_help
    die "non-interactive publish needs --otp=XXXXXX or an Automation token + --yes"
  fi

  if ! prompt_yn "Publish $PKG_NAME@$ver to npm as $(npm whoami)?" y; then
    die "Aborted (version stamps left at $ver — commit or discard as you like)."
  fi

  if ! do_npm_publish "$ver"; then
    warn "npm publish failed"
    print_npm_auth_help
    die "publish failed — if npm asked for a browser login, re-run in a normal terminal and enter the authenticator OTP when prompted"
  fi

  log "Post-publish verify"
  # npm's WRITE path and its CDN-backed READ path are different systems: a fresh
  # publish can be invisible to `npm view` for minutes while `npm access list`
  # already shows it. A 2s sleep + soft "propagation lag?" read exactly like a
  # FAILED publish for one that had succeeded (hit for real on hub-rest-client's
  # first publish, 2026-09-07). Poll, then fall back to the ownership signal.
  local waited=0
  live=""
  while (( waited < 90 )); do
    live="$(npm_published)"
    [[ -n "$live" ]] && break
    sleep 5; waited=$(( waited + 5 ))
  done

  if [[ "$live" == "$ver" ]]; then
    ok "$PKG_NAME@$ver is live (visible after ${waited}s)"
  elif npm access list packages "${PKG_NAME%%/*}" 2>/dev/null | grep -q "^${PKG_NAME}:"; then
    ok "$PKG_NAME@$ver PUBLISHED — the registry lists it under the scope"
    info "The public read path has not propagated yet; that is normal. Nothing is wrong."
    info "Confirm later with:  npm view $PKG_NAME version"
  else
    warn "could not confirm $PKG_NAME@$ver on the registry"
    info "Check for an npm publish receipt email, then: npm view $PKG_NAME version"
  fi
  cat <<EOF

Consumers:
  pnpm add $PKG_NAME@$ver

Related:
  Full contracts (IS tgz + repins):  cd synap-backend && pnpm contracts:publish --yes

EOF
}

cmd_dry_run() {
  ensure_layout
  regen_types
  build_package
  local ver
  ver="$(pkg_version)"
  log "Publish dry-run $PKG_NAME@$ver"
  (cd "$BACKEND_ROOT" && pnpm --filter "$PKG_NAME" publish --dry-run --no-git-checks) || warn "dry-run exited non-zero"
}

# ── main ─────────────────────────────────────────────────────────────────────

if [[ -z "$MODE" ]]; then
  if [[ -t 0 ]]; then
    menu
  else
    cat <<'EOF' >&2
Usage: ./dev ship api-types <mode> [flags]

  verify | prepare | bump | build | publish | dry-run

  ./dev ship api-types publish              # usual path
  ./dev ship api-types publish --force-bump # new version even if surface unchanged
  ./dev ship api-types publish 1.27.0
  ./dev ship api-types bump --force
  ./dev ship api-types verify
EOF
    exit 1
  fi
fi

case "$MODE" in
  verify) cmd_verify ;;
  prepare) cmd_prepare ;;
  bump) cmd_bump ;;
  build) cmd_build ;;
  publish) cmd_publish ;;
  dry-run|dry) cmd_dry_run ;;
  auth) cmd_auth ;;
  help|-h|--help)
    cat <<'EOF'
Modes: verify | prepare | bump | build | publish | dry-run | auth
Flags: --yes --force/--force-bump --otp=XXXXXX --patch --minor --major --full --version X.Y.Z --tag <npm-tag>

Usual:     ./dev ship api-types publish
           (your npm login + terminal OTP prompt)
Auth help: ./dev ship api-types auth
Optional:  ./dev ship api-types publish --otp=XXXXXX
Force ver: ./dev ship api-types publish --force-bump
EOF
    ;;
  *) die "unknown mode '$MODE' (verify|prepare|bump|build|publish|dry-run|auth)" ;;
esac
