#!/bin/bash

# =============================================================================
# DEPRECATED — DO NOT RUN FOR PUBLISHING
# =============================================================================
#
# This script used to publish a hardcoded list of 11 packages to npm. It is
# retired for three reasons:
#
#   1. NO SURFACE GATE. It published whatever version sat in each
#      package.json, including versions already live on npm. `npm publish`
#      rejects those, so the script failed on every honest re-run — but only
#      AFTER it had already been invoked, which is the wrong place to discover
#      that.
#
#   2. NO VERSION CHECK. It never asked whether the router surface had changed
#      (the api-types drift gate lives in check-and-bump.mjs and is owned by
#      publish-types.yml). It would happily bump-and-republish an unchanged
#      contract, which is the exact "four authorities on one version number"
#      defect this repo has spent weeks unwinding.
#
#   3. DUPLICATE OF CI. `publish-types.yml` is the single publish door: it
#      builds through turbo, gates api-types on a real surface diff, and
#      publishes only when there is something new. Hand-running this script
#      bypassed all of that.
#
# WHAT REPLACES IT
#   npm publishing  →  .github/workflows/publish-types.yml  (CI, the only door)
#   local checking  →  ./dev ship <package> verify | dry-run | auth
#
# This file is KEPT, not deleted, so existing muscle memory and any CI
# reference to `scripts/publish-packages.sh` do not break with "command not
# found". It prints the above and exits — it does not build, bump, or publish
# anything.
# =============================================================================

cat <<'EOF'

╔══════════════════════════════════════════════════════════════════════════════╗
║  ⛔  scripts/publish-packages.sh IS DEPRECATED — it will NOT publish.       ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  npm publishing now has exactly ONE door: CI.                               ║
║                                                                              ║
║    .github/workflows/publish-types.yml                                      ║
║      → triggers on every push to `main` that touches a type package,        ║
║        plus a manual `workflow_dispatch` button.                             ║
║      → builds through turbo, gates api-types on a real surface diff,         ║
║        and refuses to re-publish an unchanged version.                       ║
║                                                                              ║
║  To publish the contract packages: press the CI button. There is no local   ║
║  publish, by design.                                                        ║
║                                                                              ║
║  Locally you can still verify everything CI would check, without publishing:  ║
║                                                                              ║
║    ./dev ship api-types verify        local version vs npm + surface drift    ║
║    ./dev ship api-types dry-run       build + pack, no upload                 ║
║    ./dev ship api-types auth          diagnose npm login / 2FA                ║
║                                                                              ║
║  Hand-publishing from a laptop is the proven root cause of the broken        ║
║  releases (an artifact was published from Node 22.22.3 while CI pins         ║
║  Node 20). Trusted Publishing makes local npm publishing impossible by       ║
║  design — there is no path back. Use the CI button.                          ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝

EOF

# Preserve the original argument surface so callers who pass --dry-run get a
# useful answer instead of an unexplained exit.
if [[ "${1:-}" == "--dry-run" ]]; then
  echo "There is no dry-run for this script anymore."
  echo "See ./dev ship <package> dry-run for per-package dry-runs."
fi

exit 0