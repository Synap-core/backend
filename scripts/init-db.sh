#!/bin/bash
set -e

echo "🚀 Synap Database Migration Script"
echo "==================================="
echo ""

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL..."
until PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c '\q' 2>/dev/null; do
  echo "   PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "✅ PostgreSQL is ready!"
echo ""

# Check if pgvector extension exists
echo "📦 Checking PostgreSQL extensions..."
PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;"
PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"

echo "✅ Extensions enabled"
echo ""

# Check if tables exist
echo "🔍 Checking if database is initialized..."
TABLE_COUNT=$(PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '\_%';" | tr -d '[:space:]')

if [ "$TABLE_COUNT" -gt "0" ]; then
  echo "✅ Database already initialized ($TABLE_COUNT tables found)"
  echo "   Skipping migrations"
else
  echo "📋 Database is empty - need torun migrations"
  echo ""
  
  # Create migrations tracking table
  echo "📦 Creating migrations tracking table..."
  PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" << 'EOSQL'
    CREATE TABLE IF NOT EXISTS _drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    );
EOSQL
  
  # Run custom migrations if they exist
  if [ -d "/migrations" ] && [ "$(ls -A /migrations/*.sql 2>/dev/null)" ]; then
    echo "📂 Running custom SQL migrations..."
    for migration in /migrations/*.sql; do
      if [ -f "$migration" ]; then
        filename=$(basename "$migration")
        echo "   Applying: $filename"
        PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "$migration"
      fi
    done
    echo "✅ Custom migrations completed"
  else
    echo "⏭️  No custom migrations found"
  fi
fi

echo ""
echo "🎉 Database initialization complete!"
echo "==================================="

# Show table summary
echo ""
echo "📊 Database Summary:"
PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "\dt"
