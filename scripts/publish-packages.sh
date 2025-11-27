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
for package in "${PACKAGES[@]}"; do
  echo ""
  echo "📤 Publishing $package..."
  
  if [ "$DRY_RUN" == "--dry-run" ]; then
    cd "$package" && pnpm publish --dry-run && cd ../..
  else
    cd "$package" && pnpm publish --no-git-checks && cd ../..
  fi
  
  echo "✅ Published $package"
done

echo ""
echo "🎉 All packages published successfully!"

