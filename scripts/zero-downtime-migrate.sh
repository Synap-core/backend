#!/bin/bash
# Zero-Downtime Database Migration Script
#
# Strategy: Expand-Migrate-Contract
# 1. Expand: Add new columns/tables (nullable)
# 2. Deploy: Code that writes to both old and new
# 3. Migrate: Backfill data
# 4. Deploy: Code that reads from new
# 5. Contract: Remove old columns/tables

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if migration is safe
check_migration_safety() {
    local migration_file=$1
    
    log_info "Checking migration safety: $migration_file"
    
    # Check for dangerous operations
    if grep -q "DROP TABLE\|DROP COLUMN\|ALTER COLUMN.*NOT NULL" "$migration_file"; then
        log_error "Migration contains potentially dangerous operations!"
        log_error "Use expand-migrate-contract pattern instead."
        return 1
    fi
    
    log_info "Migration safety check passed"
    return 0
}

# Phase 1: Expand Schema
expand_schema() {
    log_info "Phase 1: Expanding schema (adding new columns/tables)"
    
    # Run migration that adds new columns (nullable)
    cd "$PROJECT_ROOT/packages/database"
    pnpm db:migrate
    
    log_info "Schema expanded successfully"
}

# Phase 2: Deploy Dual-Write Code
deploy_dual_write() {
    log_info "Phase 2: Deploying dual-write code"
    
    # This would typically be done via CI/CD
    # For manual deployment:
    log_warn "Deploy code that writes to BOTH old and new columns"
    log_warn "Press Enter when deployment is complete..."
    read
    
    log_info "Dual-write code deployed"
}

# Phase 3: Backfill Data
backfill_data() {
    log_info "Phase 3: Backfilling data to new columns"
    
    # Example: Backfill in batches to avoid locks
    psql $DATABASE_URL <<EOF
DO \$\$
DECLARE
    batch_size INT := 1000;
    offset_val INT := 0;
    rows_updated INT;
BEGIN
    LOOP
        -- Example: Copy data from old_column to new_column
        -- UPDATE entities 
        -- SET new_column = old_column 
        -- WHERE new_column IS NULL 
        -- LIMIT batch_size;
        
        GET DIAGNOSTICS rows_updated = ROW_COUNT;
        
        EXIT WHEN rows_updated = 0;
        
        offset_val := offset_val + batch_size;
        
        -- Log progress
        RAISE NOTICE 'Backfilled % rows', offset_val;
        
        -- Small delay to avoid overwhelming the database
        PERFORM pg_sleep(0.1);
    END LOOP;
END \$\$;
EOF
    
    log_info "Data backfill completed"
}

# Phase 4: Deploy Read-New Code
deploy_read_new() {
    log_info "Phase 4: Deploying code that reads from new columns"
    
    log_warn "Deploy code that reads from NEW columns only"
    log_warn "Press Enter when deployment is complete..."
    read
    
    log_info "Read-new code deployed"
}

# Phase 5: Contract Schema
contract_schema() {
    log_info "Phase 5: Contracting schema (removing old columns)"
    
    log_warn "This will DROP old columns. Are you sure? (yes/no)"
    read confirmation
    
    if [ "$confirmation" != "yes" ]; then
        log_error "Contract phase cancelled"
        return 1
    fi
    
    # Run migration that drops old columns
    # This should be a separate migration file
    cd "$PROJECT_ROOT/packages/database"
    pnpm db:migrate
    
    log_info "Schema contracted successfully"
}

# Verify migration
verify_migration() {
    log_info "Verifying migration..."
    
    # Check table exists
    psql $DATABASE_URL -c "\dt" | grep -q "entities" || {
        log_error "Entities table not found!"
        return 1
    }
    
    # Check data integrity
    psql $DATABASE_URL -c "SELECT COUNT(*) FROM entities;" || {
        log_error "Failed to query entities table!"
        return 1
    }
    
    log_info "Migration verified successfully"
}

# Rollback function
rollback() {
    log_error "Rolling back migration..."
    
    # Restore from backup
    if [ -f "$BACKUP_FILE" ]; then
        log_info "Restoring from backup: $BACKUP_FILE"
        psql $DATABASE_URL < "$BACKUP_FILE"
        log_info "Rollback completed"
    else
        log_error "No backup file found!"
        return 1
    fi
}

# Create backup before migration
create_backup() {
    log_info "Creating database backup..."
    
    BACKUP_DIR="$PROJECT_ROOT/backups"
    mkdir -p "$BACKUP_DIR"
    
    BACKUP_FILE="$BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).sql"
    
    pg_dump $DATABASE_URL > "$BACKUP_FILE"
    
    log_info "Backup created: $BACKUP_FILE"
}

# Main execution
main() {
    log_info "Starting zero-downtime migration process"
    
    # Check environment
    if [ -z "$DATABASE_URL" ]; then
        log_error "DATABASE_URL not set!"
        exit 1
    fi
    
    # Create backup
    create_backup
    
    # Execute phases
    expand_schema || { log_error "Expand phase failed"; rollback; exit 1; }
    deploy_dual_write || { log_error "Dual-write deployment failed"; exit 1; }
    backfill_data || { log_error "Backfill phase failed"; rollback; exit 1; }
    deploy_read_new || { log_error "Read-new deployment failed"; exit 1; }
    contract_schema || { log_error "Contract phase failed"; exit 1; }
    
    # Verify
    verify_migration || { log_error "Verification failed"; exit 1; }
    
    log_info "Migration completed successfully!"
}

# Run main if executed directly
if [ "${BASH_SOURCE[0]}" == "${0}" ]; then
    main "$@"
fi
