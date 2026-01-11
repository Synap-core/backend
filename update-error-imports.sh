#!/bin/bash
# Update error imports from @synap-core/core to @synap-core/types

echo "Updating error imports..."

# Find all TypeScript files that import error types from @synap-core/core
find packages apps -type f -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.turbo/*" | while read file; do
  # Check if file imports error types from @synap-core/core
  if grep -q "from '@synap-core/core'" "$file"; then
    # Check if it imports error types
    if grep -E "(ValidationError|NotFoundError|UnauthorizedError|ForbiddenError|ConflictError|RateLimitError|InternalServerError|ServiceUnavailableError|SynapError|isSynapError|toSynapError)" "$file" | grep -q "@synap-core/core"; then
      echo "Updating: $file"
      
      # Create backup
      cp "$file" "$file.bak"
      
      # Update imports - handle both single and multi-line imports
      # Pattern 1: Single line with error types
      sed -i '' 's/import { \([^}]*\)\(ValidationError\|NotFoundError\|UnauthorizedError\|ForbiddenError\|ConflictError\|RateLimitError\|InternalServerError\|ServiceUnavailableError\|SynapError\|isSynapError\|toSynapError\)\([^}]*\) } from '\''@synap-core\/core'\'';/import { \1\2\3 } from '\''@synap-core\/types'\'';/g' "$file"
      
      # If file still has @synap-core/core imports (for logger, config, etc), keep them
      # Just add a new import for error types if needed
      if grep -qE "(ValidationError|NotFoundError|UnauthorizedError|ForbiddenError|ConflictError|RateLimitError|InternalServerError|ServiceUnavailableError|SynapError|isSynapError|toSynapError)" "$file"; then
        if ! grep -q "from '@synap-core/types'" "$file"; then
          # Add error types import
          echo "  -> Adding separate error import"
        fi
      fi
      
      # Remove backup if successful
      rm "$file.bak"
    fi
  fi
done

echo "Done! Please review changes and run: pnpm build"
