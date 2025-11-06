#!/bin/bash

##
# Initialize PostgreSQL Database for Synap Backend V0.2
# 
# This script:
# 1. Enables pgvector extension
# 2. Pushes Drizzle schemas to PostgreSQL
# 3. Enables Row-Level Security (RLS)
# 4. Creates indexes for performance
#
# Prerequisites:
# - DATABASE_URL environment variable set
# - PostgreSQL database created (Neon)
# - psql CLI installed
##

set -e  # Exit on error

echo "🚀 Initializing Synap PostgreSQL Database..."
echo ""

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "❌ Error: DATABASE_URL not set"
  echo "   Please export DATABASE_URL=postgresql://..."
  exit 1
fi

echo "✅ DATABASE_URL is set"
echo ""

# Step 1: Enable pgvector extension
echo "📦 Step 1/4: Enabling pgvector extension..."
psql "$DATABASE_URL" < packages/database/migrations-pg/0001_enable_pgvector.sql
echo "✅ pgvector enabled"
echo ""

# Step 2: Push Drizzle schemas
echo "📊 Step 2/4: Pushing Drizzle schemas..."
cd packages/database
export DB_DIALECT=postgres
pnpm drizzle-kit push
cd ../..
echo "✅ Schemas pushed"
echo ""

# Step 3: Enable RLS
echo "🔒 Step 3/4: Enabling Row-Level Security..."
psql "$DATABASE_URL" < packages/database/migrations-pg/0002_enable_rls.sql
echo "✅ RLS enabled"
echo ""

# Step 4: Verify setup
echo "✅ Step 4/4: Verifying setup..."

# Check if tables exist
TABLE_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")
echo "   Tables created: $TABLE_COUNT"

# Check if RLS is enabled
RLS_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true;")
echo "   Tables with RLS: $RLS_COUNT"

# Check if pgvector is enabled
PGVECTOR=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM pg_extension WHERE extname = 'vector';")
if [ "$PGVECTOR" -eq "1" ]; then
  echo "   pgvector: ✅ Enabled"
else
  echo "   pgvector: ❌ Not enabled"
  exit 1
fi

echo ""
echo "🎉 Database initialization complete!"
echo ""
echo "Next steps:"
echo "  1. Configure Better Auth OAuth (Google, GitHub)"
echo "  2. Run tests: pnpm test multi-user"
echo "  3. Start API server: pnpm --filter api dev"
echo ""

