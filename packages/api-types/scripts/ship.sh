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

── npm publish auth (this is your E404 / web-login loop) ────────────────────
Your npm account has two-factor auth = "auth-and-writes".
That means a normal login / "Publish" token is NOT enough to put a package:

  1) PUT /@synap-core/api-types  →  401  (token can't write without 2FA)
  2) npm opens browser web-auth    →  polls /-/v1/done?authId=…
  3) poll ends in 404              →  "Not Found" (web auth never finished)

FIX — pick ONE:

  A) Recommended for ./dev ship (no browser):
     npmjs.com → Access Tokens → Generate New Token → Classic → Automation
     (Automation tokens bypass 2FA for publish.)
     Then:
       npm config set //registry.npmjs.org/:_authToken=npm_YOUR_AUTOMATION_TOKEN
       ./dev ship api-types publish --yes

  B) Keep current token + one-shot OTP from your authenticator app:
       ./dev ship api-types publish --otp=123456 --yes
     (or:  NPM_OTP=123456 ./dev ship api-types publish --yes)

  C) Avoid broken web auth:
       npm config set auth-type legacy
     then use B with --otp=…

Do NOT rely on "npm login" web flow for publish while auth-type=web — it is
what produces the done?authId 404 you saw.

Diagnose anytime:  ./dev ship api-types auth
EOF
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
    if [[ "$tfa" == *auth-and-writes* || "$tfa" == *auth-and-writes* ]]; then
      warn "2FA=auth-and-writes → publish needs Automation token OR --otp=XXXXXX"
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
  else
    info "no OTP in env for this run"
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

  Usual path:     ./dev ship api-types publish --otp=XXXXXX
  Force new ver:  ./dev ship api-types publish --force-bump --otp=XXXXXX
  Explicit ver:   ./dev ship api-types publish 1.27.0 --otp=XXXXXX
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

  # 2FA preflight — avoid the browser web-auth 404 loop
  local tfa=""
  tfa="$(npm profile get 2>/dev/null | awk -F': ' '/two-factor auth/ {print $2; exit}' || true)"
  if [[ "$tfa" == *auth-and-writes* || "$tfa" == *auth-and-writes* ]]; then
    if [[ -z "$NPM_OTP" ]]; then
      warn "npm 2FA is auth-and-writes and no --otp was passed."
      info "Publish tokens alone return 401 → npm opens broken web-auth → done?authId 404."
      info "Pass a fresh authenticator code, or use an Automation token (see auth help)."
      if [[ -t 0 && "$YES" != "1" ]]; then
        read -r -p "  OTP from authenticator (or empty to abort): " NPM_OTP || true
      fi
      if [[ -z "$NPM_OTP" ]]; then
        print_npm_auth_help
        die "missing OTP — re-run: ./dev ship api-types publish --otp=XXXXXX --yes"
      fi
    else
      ok "using OTP from --otp / NPM_OTP"
    fi
  fi

  if ! prompt_yn "Publish $PKG_NAME@$ver to npm?" y; then
    die "Aborted (version stamps left at $ver — commit or discard as you like)."
  fi

  local pub_args=(--filter "$PKG_NAME" publish --access public --no-git-checks --tag "$NPM_TAG")
  if [[ -n "$NPM_OTP" ]]; then
    pub_args+=(--otp "$NPM_OTP")
  fi

  set +e
  (cd "$BACKEND_ROOT" && pnpm "${pub_args[@]}")
  local pub_rc=$?
  set -e

  if [[ $pub_rc -ne 0 ]]; then
    warn "pnpm publish failed (exit $pub_rc)"
    print_npm_auth_help
    die "publish failed — fix auth (Automation token or --otp), then re-run"
  fi

  log "Post-publish verify"
  sleep 2
  live="$(npm_published)"
  info "npm latest: ${live:-unknown}"
  if [[ "$live" == "$ver" ]]; then
    ok "$PKG_NAME@$ver is live"
  else
    warn "npm reports '$live' (propagation lag?).  npm view $PKG_NAME version"
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

Usual:     ./dev ship api-types publish --otp=XXXXXX
Auth help: ./dev ship api-types auth
Force ver: ./dev ship api-types publish --force-bump --otp=XXXXXX
EOF
    ;;
  *) die "unknown mode '$MODE' (verify|prepare|bump|build|publish|dry-run|auth)" ;;
esac
