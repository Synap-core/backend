# Profile System Seeding - Complete Solution

## ✅ What Was Created

### 1. Utility Function

**File**: `packages/database/src/utils/ensure-system-profiles.ts`

- Idempotent function to ensure system profiles exist
- Can be called from migrations, workspace creation, or manually
- Returns status and counts of created items
- **Exported** from `@synap/database` package

### 2. Migration File

**File**: `packages/database/migrations-custom/0023_seed_system_profiles.sql`

- SQL-based seeding (faster, no TypeScript compilation)
- Uses `ON CONFLICT DO NOTHING` for idempotency
- Seeds property definitions, profiles, and links
- **Runs automatically** when migrations are executed

### 3. System Profiles Created

#### Profiles (6 total):

1. ✅ **note** - Simple notes (icon: file-text, color: #6B7280)
2. ✅ **task** - Tasks with status, priority, dueDate (icon: check-square, color: #3B82F6)
3. ✅ **project** - Projects (icon: folder, color: #8B5CF6)
4. ✅ **event** - Calendar events (icon: calendar, color: #10B981)
5. ✅ **person** - People/contacts (icon: user, color: #F59E0B)
6. 🆕 **company** - Companies/organizations (icon: building, color: #6366F1)

#### Property Definitions (15 total):

- **Base properties** (reusable): `title`, `description`, `tags`
- **Task properties**: `status`, `priority`, `dueDate`, `assignee`
- **Event properties**: `startTime`, `endTime`
- **Person properties**: `email`, `phone`
- **Company properties**: `website`, `industry`, `employees`, `location`

---

## 🚀 How It Works

### Automatic Seeding (Migration)

When you run `pnpm db:migrate`, the migration `0023_seed_system_profiles.sql` will:

1. Create all property definitions (if they don't exist)
2. Create all system profiles (if they don't exist)
3. Link properties to profiles (if links don't exist)

**Idempotent**: Safe to run multiple times - won't create duplicates.

### Manual Seeding (Utility Function)

You can also call the utility function programmatically:

```typescript
import { ensureSystemProfiles } from "@synap/database";

const result = await ensureSystemProfiles();
console.log(result.status); // "created" | "exists" | "error"
console.log(result.profilesCreated); // number
```

**Use cases**:

- Workspace creation hook (optional safety check)
- Manual fixes if profiles are missing
- Development/testing

---

## 📋 Next Steps

### 1. Run Migration

```bash
cd synap-backend/packages/database
pnpm db:migrate
```

This will automatically seed all system profiles.

### 2. Verify Profiles Exist

```bash
# Check profiles in database
psql -U postgres -d synap -c "SELECT slug, display_name, scope FROM profiles WHERE scope = 'system';"
```

Should show: note, task, project, event, person, company

### 3. Test Frontend

- Open workspace settings → Profiles
- Should see 6 system profiles
- Should be able to create entities with these profiles

---

## 💡 Discussion & Decisions

### ✅ Decisions Made

1. **System Profiles (not workspace-specific)**
   - Profiles are `scope = 'system'` (shared across all workspaces)
   - Users can create workspace/user profiles for customization
   - **Rationale**: Consistency across workspaces, easier to maintain

2. **Migration-Based Seeding (primary)**
   - Migration runs automatically on `db:migrate`
   - One-time setup for new installations
   - **Rationale**: Automatic, version-controlled, part of schema

3. **Utility Function (safety net)**
   - Can be called from workspace creation (optional)
   - Useful for manual fixes
   - **Rationale**: Flexibility, safety checks

4. **Added "company" Profile**
   - As suggested by user
   - Properties: name, website, industry, employees, location
   - **Rationale**: Common entity type, useful for CRM use cases

### 🤔 Open Questions

1. **Should we call `ensureSystemProfiles()` from workspace creation?**
   - **Current**: No (rely on migration)
   - **Alternative**: Yes (safety check)
   - **Recommendation**: Optional - migration should be sufficient

2. **Should all profiles inherit base properties (title, tags)?**
   - **Current**: Explicitly linked to each profile
   - **Alternative**: Parent profile with base properties
   - **Recommendation**: Keep explicit (clearer, more flexible)

3. **Should we add more base profiles?**
   - Current: 6 profiles
   - Could add: document, file, bookmark, etc.
   - **Recommendation**: Start with these 6, add more as needed

---

## 🔍 Troubleshooting

### Issue: "No workspace profiles" in frontend

**Possible causes**:

1. Migration not run → Run `pnpm db:migrate`
2. Profiles exist but scope is wrong → Check `scope = 'system'`
3. Frontend query issue → Check `trpc.profiles.list` query

**Fix**:

```bash
# 1. Run migration
cd synap-backend/packages/database
pnpm db:migrate

# 2. Or manually call utility
cd synap-backend
node -e "import('./packages/database/dist/utils/ensure-system-profiles.js').then(m => m.ensureSystemProfiles().then(r => console.log(r)))"
```

### Issue: Profiles exist but properties not linked

**Fix**: Re-run migration (idempotent, safe)

---

## 📝 Summary

✅ **Created**: Utility function + migration for automatic seeding
✅ **Added**: Company profile (6 total profiles)
✅ **Idempotent**: Safe to run multiple times
✅ **Automatic**: Runs with migrations
✅ **Flexible**: Can also be called programmatically

**Result**: System profiles will be automatically created when migrations run, solving the "no workspace profiles" issue.
