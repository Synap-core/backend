#!/usr/bin/env bash
# Ship @synap-core/hub-rest-client to npm — build, version, publish, repin consumers.
#
# Preferred entry from monorepo root:
#   ./dev ship hub-rest-client                  # interactive menu
#   ./dev ship hub-rest-client verify           # local vs npm
#   ./dev ship hub-rest-client build            # tsup build only
#   ./dev ship hub-rest-client publish          # ★ happy path: build → ensure new version → npm
#   ./dev ship hub-rest-client publish 1.2.0    # explicit version then publish
#   ./dev ship hub-rest-client publish --bump   # patch-bump first
#   ./dev ship hub-rest-client dry-run
#   ./dev ship hub-rest-client repin            # consumers: file:/tgz → the published semver
#   ./dev ship hub-rest-client auth
#
# WHY THIS SCRIPT EXISTS
# ---------------------
# This package was consumed by THREE different hand-vendoring hacks, because it
# had never been published:
#   • synap-cli      `file:` + `bundledDependencies` + prepack/postpack that copy
#                    the sibling checkout into node_modules before `npm pack`
#   • synap-raycast  `file:` path to the sibling checkout
#   • intelligence   a CHECKED-IN tarball, pinned to a stale 1.0.9
# All three exist only because npm had no copy. `repin` is what retires them —
# run it AFTER a successful publish. Publishing is therefore not a nicety here:
# it is what makes the CLI's release pipeline movable off a laptop at all
# (prepack depends on `../synap-backend` existing, which CI does not guarantee).
#
# Deliberately NOT modelled on api-types' surface-drift gate: that package's
# version is derived from a GENERATED tRPC surface, so it can compute "did the
# contract change". This client is hand-written — there is nothing to diff
# against, so version choice is a human decision. `publish` will not invent one.
#
# npm scope: @synap-core is the PUBLIC scope (core, types, hub-protocol, cli,
# api-types, workspace-templates all live there). @synap is internal and has
# never published. Renamed into @synap-core on 2026-09-07, before first publish.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
MONOREPO_ROOT="$(cd "$BACKEND_ROOT/.." && pwd)"
PKG_NAME="@synap-core/hub-rest-client"

MODE="${1:-}"
shift || true

YES="${YES:-0}"
DO_BUMP=0
BUMP_KIND="patch"
EXPLICIT_VERSION=""
NPM_TAG="latest"
NPM_OTP="${NPM_OTP:-}"
LEGACY_AUTH="${LEGACY_AUTH:-}"   # opt-in: force npm auth-type=legacy (see do_npm_publish)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --bump) DO_BUMP=1 ;;
    --patch) BUMP_KIND=patch; DO_BUMP=1 ;;
    --minor) BUMP_KIND=minor; DO_BUMP=1 ;;
    --major) BUMP_KIND=major; DO_BUMP=1 ;;
    --tag) NPM_TAG="${2:-latest}"; shift ;;
    --otp) NPM_OTP="${2:-}"; [[ -n "$NPM_OTP" ]] || { echo "✗ --otp needs a 6-digit code" >&2; exit 1; }; shift ;;
    --otp=*) NPM_OTP="${1#--otp=}" ;;
    --legacy-auth) LEGACY_AUTH=1 ;;
    --version) EXPLICIT_VERSION="${2:-}"; [[ -n "$EXPLICIT_VERSION" ]] || { echo "✗ --version needs a semver" >&2; exit 1; }; shift ;;
    -*) echo "✗ unknown flag: $1" >&2; exit 1 ;;
    *)
      if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$ ]]; then
        EXPLICIT_VERSION="$1"
      else
        echo "✗ unexpected argument: $1" >&2; exit 1
      fi
      ;;
  esac
  shift || true
done

log()  { printf '\n→ %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }
warn() { printf '⚠  %s\n' "$*" >&2; }
ok()   { printf '  ✓ %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

pkg_version()   { node -p "require('$PKG_DIR/package.json').version"; }
npm_published() { npm view "$PKG_NAME" version 2>/dev/null || true; }

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

# exit 0 equal, 1 a>b, 2 a<b
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

set_version() {
  local next="$1"
  [[ "$next" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$ ]] || die "invalid semver: $next"
  node - "$next" "$PKG_DIR" <<'NODE'
const fs = require("fs"); const path = require("path");
const [next, pkgDir] = process.argv.slice(2);
const p = path.join(pkgDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
if (pkg.version === next) { console.log("   already at", next); process.exit(0); }
console.log("   package.json", pkg.version, "→", next);
pkg.version = next;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
NODE
}

prompt_yn() {
  local q="$1" default="${2:-n}" ans
  if [[ "$YES" == "1" ]]; then return 0; fi
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
Publishing needs a 2FA step when your npm account is "auth-and-writes".

WHICH SECOND FACTOR DO YOU HAVE?  This decides everything below.

  • SECURITY KEY / PASSKEY (WebAuthn)  → you MUST use the web flow.
      npm opens https://www.npmjs.com/login/<id> and you approve there.
      A security key CANNOT produce a 6-digit code, so if you ever see
      "Enter OTP:" the flow has fallen back to legacy and is unanswerable.
      Fix:  npm config delete auth-type      (npm 10 defaults to `web`)
      Never pass --legacy-auth or --otp with a security key.

  • AUTHENTICATOR APP (TOTP)           → either flow works.
      Terminal prompt: type the 6 digits.
      Or skip the prompt:  publish --otp=123456

This script does NOT force an auth type — it inherits your npm config, so a
security key works out of the box. `--legacy-auth` is an opt-in escape hatch
for one historical failure: a web flow that 404'd on /-/v1/done?authId=… .
Use it only if you hit that, and only with a TOTP authenticator.

BEST PRACTICE for publishing — a granular token, no 2FA prompt at all:
  npmjs.com → Access Tokens → Granular Access Token
    scope: @synap-core, permission: read+write
  npm config set //registry.npmjs.org/:_authToken=npm_…
  This also unblocks moving the release to CI, which an interactive OTP cannot.

Diagnose: ./dev ship hub-rest-client auth
EOF
}

# pnpm --filter from the backend root so workspace deps resolve to real versions.
do_npm_publish() {
  local ver="$1" who
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
  local -a cmd=(pnpm --filter "$PKG_NAME" publish --access public --no-git-checks --tag "$NPM_TAG")
  [[ -n "$NPM_OTP" ]] && cmd+=(--otp "$NPM_OTP")

  set +e
  (
    cd "$BACKEND_ROOT"
    # AUTH TYPE IS NOT FORCED HERE — deliberately.
    #
    # An earlier version of this script (copied from api-types') exported
    # auth-type=legacy unconditionally, to route around an npm web-auth flow
    # that once 404'd on `/-/v1/done?authId=…`. That is the WRONG default for a
    # security-key (WebAuthn/passkey) account: legacy mode prints the
    # "Open https://www.npmjs.com/login/… to use your security key" URL and then
    # blocks on `Enter OTP:` — a prompt a security key can never satisfy, because
    # it is not a TOTP authenticator. The publish is unanswerable and hangs.
    #
    # So: inherit whatever the user's npm config says (npm 10 defaults to `web`,
    # which is what a security key needs), and keep legacy as an explicit opt-in
    # for the 404 case via --legacy-auth.
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

ensure_layout() {
  [[ -f "$PKG_DIR/package.json" ]] || die "hub-rest-client package.json missing: $PKG_DIR"
  local name
  name="$(node -p "require('$PKG_DIR/package.json').name")"
  [[ "$name" == "$PKG_NAME" ]] || die "package name is '$name', expected '$PKG_NAME' — this script and package.json disagree"
  need_cmd pnpm; need_cmd node; need_cmd npm
}

build_package() {
  log "Build $PKG_NAME"
  (cd "$BACKEND_ROOT" && pnpm --filter "$PKG_NAME" build)
  ok "built $(pkg_version)"
}

cmd_verify() {
  ensure_layout
  local ver live
  ver="$(pkg_version)"; live="$(npm_published)"
  log "Verify $PKG_NAME"
  info "local: $ver"
  info "npm:   ${live:-<not published>}"
  if [[ -z "$live" ]]; then
    ok "not on npm yet — first publish will create it"
  elif [[ "$live" == "$ver" ]]; then
    ok "versions match (already published)"
  else
    set +e; semver_cmp "$ver" "$live"; local cmp=$?; set -e
    if [[ $cmp -eq 1 ]]; then ok "local $ver is ahead of npm $live — ready to publish"
    else warn "local $ver is behind npm $live — bump or pull"; fi
  fi

  log "Consumers still hand-vendoring this package"
  local found=0
  while IFS= read -r line; do
    found=1; info "$line"
  done < <(consumer_report)
  [[ "$found" == "1" ]] || ok "none — every consumer is on a published version"
}

# One line per consumer still hand-vendoring, under EITHER name.
#
# Checking the pre-rename name too is deliberate. A report that only knew the
# current name would print "every consumer is on a published version" for a repo
# still pinned to `@synap-core/hub-rest-client` — a false clean, and the loudest
# possible lie for a script whose whole job is to say who is still vendoring.
# A stale old-name reference is a HARDER failure than a file: pin (it resolves to
# a package that no longer exists), so it is reported first and marked.
consumer_report() {
  node - "$MONOREPO_ROOT" "$PKG_NAME" <<'NODE'
const fs = require("fs"); const path = require("path");
const [root, name] = process.argv.slice(2);
// Built from parts ON PURPOSE. Written as a plain literal, a repo-wide rename of
// the old name rewrites THIS line too — silently disabling the stale-name check
// and making the report claim "clean" for a consumer that is still broken. A
// guard must not be defeatable by the very migration it exists to police.
const LEGACY = ["@synap", "hub-rest-client"].join("/");
const targets = [
  "synap-cli/package.json",
  "synap-raycast/package.json",
  "synap-intelligence-service/apps/intelligence-hub/package.json",
];
for (const rel of targets) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  let pkg; try { pkg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
  for (const field of ["dependencies", "devDependencies"]) {
    for (const n of [LEGACY, name]) {
      const spec = pkg[field]?.[n];
      if (!spec) continue;
      const stale = n === LEGACY ? "  ⚠ STALE NAME — rename incomplete" : "";
      if (/^file:/.test(spec) || stale) console.log(`${rel} → ${field}.${n} = ${spec}${stale}`);
    }
  }
  for (const n of [LEGACY, name]) {
    if (Array.isArray(pkg.bundledDependencies) && pkg.bundledDependencies.includes(n)) {
      console.log(`${rel} → bundledDependencies includes ${n}${n === LEGACY ? "  ⚠ STALE NAME" : ""}`);
    }
  }
  for (const hook of ["prepack", "postpack"]) {
    const s = pkg.scripts?.[hook];
    if (s && s.includes("hub-rest-client")) console.log(`${rel} → scripts.${hook} vendoring hook`);
  }
}
NODE
}

cmd_repin() {
  ensure_layout
  local live
  live="$(npm_published)"
  [[ -n "$live" ]] || die "$PKG_NAME is not on npm yet — publish first, then repin"

  log "Repin consumers → $PKG_NAME@^$live"
  info "This retires the file:/tgz/bundledDependencies vendoring."
  echo
  consumer_report | sed 's/^/  /'
  echo

  prompt_yn "Rewrite those to \"^$live\" (and drop the CLI's bundledDependencies + prepack/postpack)?" y \
    || die "aborted — nothing written"

  node - "$MONOREPO_ROOT" "$PKG_NAME" "$live" <<'NODE'
const fs = require("fs"); const path = require("path");
const [root, name, live] = process.argv.slice(2);
const spec = `^${live}`;
const targets = [
  "synap-cli/package.json",
  "synap-raycast/package.json",
  "synap-intelligence-service/apps/intelligence-hub/package.json",
];
for (const rel of targets) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const raw = fs.readFileSync(p, "utf8");
  const pkg = JSON.parse(raw);
  let touched = false;
  for (const field of ["dependencies", "devDependencies"]) {
    if (pkg[field]?.[name] && pkg[field][name] !== spec) {
      console.log(`  ${rel}: ${field}.${name}  ${pkg[field][name]} → ${spec}`);
      pkg[field][name] = spec;
      touched = true;
    }
  }
  if (Array.isArray(pkg.bundledDependencies)) {
    const next = pkg.bundledDependencies.filter((d) => d !== name);
    if (next.length !== pkg.bundledDependencies.length) {
      console.log(`  ${rel}: bundledDependencies -= ${name}`);
      if (next.length) pkg.bundledDependencies = next;
      else delete pkg.bundledDependencies;
      touched = true;
    }
  }
  // The prepack/postpack pair exists ONLY to make bundledDependencies work on a
  // symlinked workspace dep. With the dep published they are not just dead, they
  // are actively harmful: prepack rm -rf's a node_modules path it no longer owns.
  for (const hook of ["prepack", "postpack"]) {
    const s = pkg.scripts?.[hook];
    if (s && s.includes("hub-rest-client")) {
      console.log(`  ${rel}: scripts.${hook} removed (vendoring hook, now dead)`);
      delete pkg.scripts[hook];
      touched = true;
    }
  }
  if (touched) fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
}
NODE

  echo
  ok "package.json files rewritten"
  info "Next: install in each touched repo so lockfiles pick up the registry version."
  info "USE THE INSTALLER THAT REPO ACTUALLY USES — running pnpm in an npm-managed"
  info "repo 'succeeds' in seconds, links nothing, and leaves a stale symlink behind"
  info "(synap-raycast has package-lock.json and no packageManager field):"
  for repo in synap-cli synap-raycast synap-intelligence-service; do
    local dir="$MONOREPO_ROOT/$repo"
    [[ -d "$dir" ]] || continue
    if [[ -f "$dir/package-lock.json" && ! -f "$dir/pnpm-lock.yaml" ]]; then
      info "  (cd $dir && npm install)      # npm-managed"
    else
      info "  (cd $dir && pnpm install)"
    fi
  done
  info "Then rebuild/verify each before committing."
}

cmd_auth() {
  ensure_layout
  log "npm auth diagnostics for $PKG_NAME"
  local user profile tfa
  user="$(npm whoami 2>/dev/null || true)"
  if [[ -z "$user" ]]; then
    warn "not logged in (npm whoami failed)"
    info "run: npm login   OR set //registry.npmjs.org/:_authToken"
  else
    ok "whoami: $user"
  fi
  info "registry:  $(npm config get registry)"
  info "auth-type: $(npm config get auth-type 2>/dev/null || echo default)"
  profile="$(npm profile get 2>/dev/null || true)"
  if [[ -n "$profile" ]]; then
    tfa="$(printf '%s\n' "$profile" | awk -F': ' '/two-factor auth/ {print $2; exit}')"
    info "2FA mode:  ${tfa:-unknown}"
  fi
  if npm view "$PKG_NAME" version >/dev/null 2>&1; then
    ok "$PKG_NAME is on npm at $(npm_published)"
  else
    info "$PKG_NAME not on npm yet (expected before first publish)"
  fi
  info "you need publish rights on the @synap-core scope"
  print_npm_auth_help
}

cmd_dry_run() {
  ensure_layout
  build_package
  local ver; ver="$(pkg_version)"
  log "Publish dry-run $PKG_NAME@$ver"
  (cd "$BACKEND_ROOT" && pnpm --filter "$PKG_NAME" publish --dry-run --no-git-checks) || warn "dry-run exited non-zero"
}

cmd_publish() {
  ensure_layout
  local ver live
  ver="$(pkg_version)"; live="$(npm_published)"

  log "Publish $PKG_NAME"
  info "local: $ver   npm: ${live:-<not published>}"

  if [[ -n "$EXPLICIT_VERSION" ]]; then
    set_version "$EXPLICIT_VERSION"
  elif [[ "$DO_BUMP" == "1" ]]; then
    local next; next="$(next_semver "$ver" "$BUMP_KIND")"
    log "Bump ($BUMP_KIND) $ver → $next"
    set_version "$next"
  fi

  ver="$(pkg_version)"

  # Refuse to re-publish an existing version — npm forbids it and the error is opaque.
  if [[ -n "$live" ]]; then
    if [[ "$live" == "$ver" ]]; then
      echo
      warn "npm already has $PKG_NAME@$ver"
      info "This package is hand-written, so there is no surface diff to bump from."
      info "Choose a version explicitly:"
      info "  ./dev ship hub-rest-client publish --bump      # patch"
      info "  ./dev ship hub-rest-client publish --minor"
      info "  ./dev ship hub-rest-client publish 1.2.0"
      exit 1
    fi
    set +e; semver_cmp "$ver" "$live"; local cmp=$?; set -e
    [[ $cmp -eq 2 ]] && die "local $ver is behind npm $live — bump past it first"
  fi

  build_package

  log "Upload $PKG_NAME@$ver → registry.npmjs.org (tag=$NPM_TAG)"
  npm whoami >/dev/null 2>&1 || die "not logged in to npm — run: npm login   then re-run"
  info "session: $(npm whoami)"

  if [[ ! -t 0 || ! -t 1 ]] && [[ -z "$NPM_OTP" ]] && [[ "$YES" != "1" ]]; then
    print_npm_auth_help
    die "non-interactive publish needs --otp=XXXXXX or an Automation token + --yes"
  fi

  prompt_yn "Publish $PKG_NAME@$ver to npm as $(npm whoami)?" y \
    || die "Aborted (version left at $ver)."

  if ! do_npm_publish "$ver"; then
    warn "npm publish failed"
    print_npm_auth_help
    die "publish failed — if npm opened a browser, re-run in a normal terminal and enter the OTP when prompted"
  fi

  log "Post-publish verify"
  # npm's WRITE path and its CDN-backed READ path are not the same system. A
  # first-ever publish of a new name can take minutes to appear via `npm view`,
  # while `npm access list` (ownership metadata) shows it immediately. A single
  # 2s sleep then a soft "propagation lag?" line was actively misleading: it read
  # exactly like a failed publish for a publish that had in fact succeeded.
  # (Hit for real on the first publish of this package, 2026-09-07.)
  #
  # So: poll the read path, and if it is still cold, check the AUTHORITATIVE
  # signal — whether the registry now lists the package under the scope — before
  # saying anything. Never report a successful upload as a failure.
  local waited=0 live=""
  while (( waited < 90 )); do
    live="$(npm_published)"
    [[ -n "$live" ]] && break
    sleep 5; waited=$(( waited + 5 ))
  done

  if [[ "$live" == "$ver" ]]; then
    ok "$PKG_NAME@$ver is live (visible after ${waited}s)"
  elif npm access list packages "${PKG_NAME%%/*}" 2>/dev/null | grep -q "^${PKG_NAME}:"; then
    ok "$PKG_NAME@$ver PUBLISHED — the registry lists it under the scope"
    info "The public read path (npm view) has not propagated yet; that is normal"
    info "for a first publish and can take several minutes. Nothing is wrong."
    info "Confirm later with:  npm view $PKG_NAME version"
  else
    warn "could not confirm $PKG_NAME@$ver on the registry"
    info "Check your email for an npm publish receipt, then:"
    info "  npm view $PKG_NAME version"
    info "  npm access list packages ${PKG_NAME%%/*}"
  fi

  cat <<EOF

★ Next — retire the three vendoring hacks this package existed under:

    ./dev ship hub-rest-client repin

  That rewrites synap-cli / synap-raycast / intelligence-hub from file:/tgz to
  ^$ver, and drops the CLI's bundledDependencies + prepack/postpack pair.
  Run an install in each afterwards, then verify before committing.

EOF
}

menu() {
  local ver live
  ver="$(pkg_version)"; live="$(npm_published)"
  cat <<EOF

$PKG_NAME ship helper
────────────────────────────────────────
  package.json:  $ver
  npm latest:    ${live:-<not published>}
  package:       $PKG_DIR

  1) verify     — local vs npm + which consumers still vendor it
  2) build      — tsup build
  3) publish    — ★ build → publish (explicit version / --bump)
  4) dry-run    — build + publish --dry-run
  5) repin      — consumers: file:/tgz → published semver
  6) auth       — diagnose npm login / 2FA
  q) quit

  First publish:  ./dev ship hub-rest-client publish
  Then:           ./dev ship hub-rest-client repin

EOF
  local choice
  read -r -p "Choice [1-6/q]: " choice || true
  case "${choice:-}" in
    1|verify) MODE=verify ;;
    2|build) MODE=build ;;
    3|publish) MODE=publish ;;
    4|dry-run|dry) MODE=dry-run ;;
    5|repin) MODE=repin ;;
    6|auth) MODE=auth ;;
    q|Q|quit) exit 0 ;;
    *) die "invalid choice" ;;
  esac
}

if [[ -z "$MODE" ]]; then
  if [[ -t 0 ]]; then
    menu
  else
    cat <<'EOF' >&2
Usage: ./dev ship hub-rest-client <mode> [flags]

  verify | build | publish | dry-run | repin | auth

  ./dev ship hub-rest-client publish            # first publish
  ./dev ship hub-rest-client publish --bump     # patch-bump then publish
  ./dev ship hub-rest-client publish 1.2.0
  ./dev ship hub-rest-client repin              # after publishing
EOF
    exit 1
  fi
fi

case "$MODE" in
  verify)       cmd_verify ;;
  build)        ensure_layout; build_package ;;
  publish)      cmd_publish ;;
  dry-run|dry)  cmd_dry_run ;;
  repin)        cmd_repin ;;
  auth)         cmd_auth ;;
  help|-h|--help)
    cat <<'EOF'
Modes: verify | build | publish | dry-run | repin | auth
Flags: --yes --bump --patch --minor --major --version X.Y.Z --otp=XXXXXX --tag <npm-tag>

First publish:  ./dev ship hub-rest-client publish
Then retire the vendoring:  ./dev ship hub-rest-client repin
Auth help:      ./dev ship hub-rest-client auth
EOF
    ;;
  *) die "unknown mode '$MODE' (verify|build|publish|dry-run|repin|auth)" ;;
esac
