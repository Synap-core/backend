-- Migration: System Seed
-- Description: Initial data population for Roles and Templates.

-- ============================================================================
-- 1. SYSTEM ROLES
-- ============================================================================
-- We insert default roles into a 'system' context (workspace_id = '00000000-0000-0000-0000-000000000000')
-- Application logic should copy these when creating a new workspace, or reference them.

INSERT INTO "roles" (id, workspace_id, name, permissions)
VALUES 
    (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'admin', '["*"]'),
    (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'editor', '["read", "write", "comment"]'),
    (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'viewer', '["read", "comment"]')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 2. DEFAULT TEMPLATES
-- ============================================================================
-- Insert default entity templates (Note, Task) here if needed.
