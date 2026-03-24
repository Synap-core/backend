#!/bin/bash

# Script to publish all open-source packages to npm
# Usage: ./scripts/publish-packages.sh [--dry-run]

set -e

DRY_RUN=${1:-""}

echo "📦 Publishing Synap packages to npm"
echo ""

# List of packages to publish (in dependency order)
PACKAGES=(
  "packages/core"
  "packages/types"
  "packages/auth"
  "packages/hub-protocol"
  "packages/database"
  "packages/domain"
  "packages/storage"
  "packages/jobs"
  "packages/hub-protocol-client"
  "packages/hub-orchestrator-base"
  "packages/api"
)

# Build all packages first
echo "🔨 Building all packages..."
pnpm build

# Publish each package
# IMPORTANT: Use --filter from workspace root so pnpm resolves workspace:* → real versions
for package in "${PACKAGES[@]}"; do
  echo ""
  PKG_NAME=$(node -p "require('./$package/package.json').name")
  echo "📤 Publishing $PKG_NAME ($package)..."

  if [ "$DRY_RUN" == "--dry-run" ]; then
    pnpm --filter "$PKG_NAME" publish --dry-run
  else
    pnpm --filter "$PKG_NAME" publish --no-git-checks
  fi

  echo "✅ Published $PKG_NAME"
done

echo ""
echo "🎉 All packages published successfully!"

