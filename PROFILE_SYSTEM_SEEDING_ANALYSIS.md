# Profile System Seeding Analysis & Solution

## 🔍 Current State

### What Exists

1. **Seed Script**: `packages/database/scripts/seed-profiles.ts`
   - Creates system property definitions (title, status, priority, dueDate, startTime, endTime, assignee, tags)
   - Creates system profiles: `note`, `task`, `project`, `event`, `person`
   - Links properties to profiles
   - **Problem**: Not run automatically - must be executed manually

2. **Profile Repository**: `getAccessibleProfiles()` returns:
   - System profiles (scope = 'system')
   - Workspace profiles (scope = 'workspace', workspaceId matches)
   - User profiles (scope = 'user', userId matches)

### What's Missing

1. ❌ **No automatic seeding** - Profiles not created on database init
2. ❌ **No migration integration** - Seed script not part of migrations
3. ❌ **No workspace creation hook** - Profiles not ensured when workspace created
4. ❌ **Missing "company" profile** - User suggested adding this

---

## 🎯 Proposed Solution

### Option 1: Migration-Based Seeding (RECOMMENDED)

**Pros**:

- Runs automatically with migrations
- Idempotent (safe to run multiple times)
- Version controlled
- Part of database schema

**Cons**:

- Requires migration file

**Implementation**:

- Create migration file: `0023_seed_system_profiles.sql`
- Use `ON CONFLICT DO NOTHING` for idempotency
- Seed profiles, property definitions, and links

### Option 2: Utility Function + Workspace Creation Hook

**Pros**:

- Can be called from multiple places
- More flexible
- Can ensure profiles exist on workspace creation

**Cons**:

- Requires code changes in multiple places
- Not automatic for existing workspaces

**Implementation**:

- Create `ensureSystemProfiles()` utility function
- Call from workspace creation executor
- Call from migration or init script

### Option 3: Hybrid Approach (BEST)

**Combine both**:

1. Migration for initial seeding (one-time, automatic)
2. Utility function for runtime checks (workspace creation, manual fixes)

---

## 📋 Recommended Profiles

### Current System Profiles

1. ✅ **note** - Simple notes
2. ✅ **task** - Tasks with status, priority, dueDate
3. ✅ **project** - Projects (hierarchical)
4. ✅ **event** - Calendar events with startTime/endTime
5. ✅ **person** - People/contacts

### Suggested Additions

6. 🆕 **company** - Companies/organizations
   - Properties: name, website, industry, employees, location
   - Icon: building
   - Color: #6366F1 (indigo)

### Base Property Definitions (Reusable)

These should be available for any profile:

- `title` - Text title (required for most)
- `tags` - Array of tags (optional, for all)
- `description` - Text description (optional, for all)
- `createdAt` - Auto-managed timestamp
- `updatedAt` - Auto-managed timestamp

---

## 🛠️ Implementation Plan

### Step 1: Create Utility Function

**File**: `packages/database/src/utils/ensure-system-profiles.ts`

- Idempotent function to ensure system profiles exist
- Can be called from migrations, workspace creation, or manually

### Step 2: Create Migration

**File**: `packages/database/migrations-custom/0023_seed_system_profiles.sql`

- SQL-based seeding (faster, no TypeScript compilation needed)
- Uses `ON CONFLICT DO NOTHING` for idempotency
- Seeds property definitions, profiles, and links

### Step 3: Add Company Profile

- Add to seed script and migration
- Define company-specific properties

### Step 4: Integration Points

- Call `ensureSystemProfiles()` from workspace creation executor (optional, for safety)
- Migration runs automatically on `db:migrate`

---

## 💡 Discussion Points

1. **Should profiles be created per workspace?**
   - Current: System profiles (shared across all workspaces)
   - Alternative: Copy system profiles to workspace on creation
   - **Recommendation**: Keep system profiles, allow workspace customization

2. **Property inheritance?**
   - Should all profiles inherit base properties (title, tags)?
   - **Recommendation**: Yes, via parent profile or explicit linking

3. **Migration vs Runtime?**
   - Migration: One-time, automatic
   - Runtime: Ensures profiles exist, can fix missing data
   - **Recommendation**: Both (migration for new installs, runtime for safety)
