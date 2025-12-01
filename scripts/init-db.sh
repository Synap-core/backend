#!/bin/bash
set -e

echo "🚀 Starting Synap database initialization..."

# Database connection (passed via environment)
DB_URL="${DATABASE_URL:-postgresql://postgres:synap_dev_password@postgres:5432/synap}"

# Function to execute SQL and check success
execute_sql() {
  local sql="$1"
  if psql "$DB_URL" -c "$sql" > /dev/null 2>&1; then
    return 0
  else
    return 1
  fi
}

# 1. Create migrations tracking table if it doesn't exist
echo "📝 Setting up migration tracking..."
psql "$DB_URL" <<SQL
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT NOW(),
    description TEXT,
    checksum VARCHAR(64)
  );
SQL

if [ $? -eq 0 ]; then
  echo "✅ Migration tracking table ready"
else
  echo "❌ Failed to create migration tracking table"
  exit 1
fi

# 2. Apply migrations in order
echo "⚙️  Applying database migrations..."
migration_count=0
skipped_count=0
failed=0

for migration in /migrations/*.sql; do
  # Skip if no migrations found
  if [ ! -f "$migration" ]; then
    echo "⚠️  No migration files found in /migrations"
    break
  fi

  filename=$(basename "$migration")
  version="${filename%%.sql}"
  
  # Extract description from first comment line if exists
  description=$(head -n 5 "$migration" | grep -E "^-- " | head -n 1 | sed 's/^-- //' || echo "No description")
  
  # Generate checksum for idempotency verification
  checksum=$(md5sum "$migration" | awk '{print $1}')
  
  # Check if already applied
  if psql "$DB_URL" -t -c "SELECT 1 FROM schema_migrations WHERE version='$version'" | grep -q 1; then
    # Verify checksum matches
    stored_checksum=$(psql "$DB_URL" -t -c "SELECT checksum FROM schema_migrations WHERE version='$version'" | tr -d ' ')
    
    if [ "$stored_checksum" != "$checksum" ]; then
      echo "⚠️  WARNING: $version has been modified since application!"
      echo "   Stored checksum:  $stored_checksum"
      echo "   Current checksum: $checksum"
      echo "   Skipping to avoid potential data corruption."
    else
      echo "⏭️  Skipping $version (already applied)"
    fi
    skipped_count=$((skipped_count + 1))
    continue
  fi
  
  # Apply migration
  echo "⚙️  Applying $version..."
  echo "   Description: $description"
  
  if psql "$DB_URL" -f "$migration" 2>&1 | tee /tmp/migration_output.log; then
    # Record successful migration
    psql "$DB_URL" -c "INSERT INTO schema_migrations (version, description, checksum) VALUES ('$version', '$description', '$checksum')" > /dev/null
    echo "✅ Applied $version successfully"
    migration_count=$((migration_count + 1))
  else
    echo "❌ Failed to apply $version"
    echo "   Check logs above for details"
    cat /tmp/migration_output.log
    failed=1
    break
  fi
done

# 3. Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $failed -eq 0 ]; then
  echo "🎉 Database initialization complete!"
  echo "   Applied: $migration_count migration(s)"
  echo "   Skipped: $skipped_count migration(s)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # Show migration status
  echo ""
  echo "📋 Migration Status:"
  psql "$DB_URL" -c "SELECT version, applied_at, description FROM schema_migrations ORDER BY applied_at DESC LIMIT 5"
  
  exit 0
else
  echo "💥 Database initialization FAILED"
  echo "   Applied: $migration_count migration(s)"
  echo "   Failed at: Check logs above"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 1
fi
