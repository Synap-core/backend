# Build Errors Report

**Date**: 2025-01-XX  
**Status**: Analysis Complete - Ready for Fixes  
**Priority**: High

## Executive Summary

This document provides a comprehensive analysis of all remaining build errors in the Synap backend monorepo. These errors are preventing clean builds across multiple packages and need to be addressed systematically.

---

## Error Categories

### 1. Missing Module Exports (`@synap/database/schema`)

**Severity**: High  
**Affected Packages**: `@synap/api`  
**Files Affected**:
- `packages/api/src/routers/api-keys.ts`
- `packages/api/src/services/api-keys.ts`

**Error Messages**:
```
error TS2307: Cannot find module '@synap/database/schema' or its corresponding type declarations.
```

**Root Cause**:
The code is trying to import from `@synap/database/schema`, but the `@synap/database` package exports everything from its root (`index.ts`), not from a `/schema` subpath.

**Current Import Pattern** (❌ Incorrect):
```typescript
import { API_KEY_SCOPES } from '@synap/database/schema';
import { apiKeys, KEY_PREFIXES, ApiKeyRecord, ApiKeyScope } from '@synap/database/schema';
```

**Correct Import Pattern** (✅ Should be):
```typescript
import { API_KEY_SCOPES } from '@synap/database';
import { apiKeys, KEY_PREFIXES, ApiKeyRecord, ApiKeyScope } from '@synap/database';
```

**Files to Fix**:
1. `packages/api/src/routers/api-keys.ts:12`
2. `packages/api/src/services/api-keys.ts:13`

**Verification**:
- Check `packages/database/src/index.ts` - exports `* from './schema/index.js'`
- Check `packages/database/src/schema/index.ts` - exports `* from './api-keys.js'`
- Check `packages/database/src/schema/api-keys.ts` - exports `API_KEY_SCOPES`, `KEY_PREFIXES`, etc.

---

### 2. Missing Module Exports (`@synap/hub-protocol`)

**Severity**: High  
**Affected Packages**: `@synap/api`  
**Files Affected**:
- `packages/api/src/routers/hub-transform.ts`
- `packages/api/src/routers/hub.ts`

**Error Messages**:
```
error TS2307: Cannot find module '@synap/hub-protocol' or its corresponding type declarations.
```

**Root Cause**:
The `@synap/api` package is missing `@synap/hub-protocol` as a dependency in its `package.json`.

**Current State**:
- `packages/hub-protocol/package.json` exists and is properly configured
- `packages/api/package.json` does NOT list `@synap/hub-protocol` as a dependency

**Fix Required**:
Add `@synap/hub-protocol` to `packages/api/package.json` dependencies:

```json
{
  "dependencies": {
    "@synap/hub-protocol": "workspace:*",
    // ... other dependencies
  }
}
```

**Files to Fix**:
1. `packages/api/package.json` - Add dependency

**Verification**:
- Run `pnpm install` after adding dependency
- Verify `packages/hub-protocol/dist/index.js` exists (package is built)
- Check that `packages/hub-protocol/src/index.ts` exports `HubInsight`, `validateHubInsight`, etc.

---

### 3. Type Mismatch in SQL Function Result (`db.execute`)

**Severity**: Medium  
**Affected Packages**: `@synap/api`  
**Files Affected**:
- `packages/api/src/services/api-keys.ts:324`

**Error Message**:
```
error TS2322: Type '{}' is not assignable to type 'number'.
```

**Code Location**:
```typescript
async cleanupExpiredKeys(): Promise<number> {
  const result = await db.execute(sql`SELECT cleanup_expired_api_keys()`);
  return result.rows[0]?.cleanup_expired_api_keys || 0;
}
```

**Root Cause**:
Drizzle ORM's `db.execute()` returns results in a format where `result.rows[0]` is typed as `Record<string, unknown>`, but TypeScript cannot infer that `cleanup_expired_api_keys` will be a number. The actual runtime value might be correct, but the type system doesn't know.

**Solutions**:

**Option A: Type Assertion** (Quick Fix):
```typescript
async cleanupExpiredKeys(): Promise<number> {
  const result = await db.execute(sql`SELECT cleanup_expired_api_keys() as cleanup_expired_api_keys`);
  const count = result.rows[0]?.cleanup_expired_api_keys;
  return typeof count === 'number' ? count : 0;
}
```

**Option B: Explicit Type Cast** (Recommended):
```typescript
async cleanupExpiredKeys(): Promise<number> {
  const result = await db.execute<{ cleanup_expired_api_keys: number }>(
    sql`SELECT cleanup_expired_api_keys() as cleanup_expired_api_keys`
  );
  return result.rows[0]?.cleanup_expired_api_keys ?? 0;
}
```

**Option C: Use Drizzle Query Builder** (If function is callable):
```typescript
// If cleanup_expired_api_keys() can be called via Drizzle's function syntax
import { sql } from 'drizzle-orm';

async cleanupExpiredKeys(): Promise<number> {
  const result = await db.execute(
    sql`SELECT cleanup_expired_api_keys() as count`
  );
  const row = result.rows[0] as { count: number } | undefined;
  return row?.count ?? 0;
}
```

**Recommended Fix**: Option B (explicit type cast with nullish coalescing)

**Files to Fix**:
1. `packages/api/src/services/api-keys.ts:322-325`

---

### 4. Unused Variable (`token`)

**Severity**: Low  
**Affected Packages**: `@synap/auth`  
**Files Affected**:
- `packages/auth/src/token-exchange.ts:36`

**Error Message**:
```
error TS6133: 'token' is declared but its value is never read.
```

**Code Location**:
```typescript
async function validateExternalToken(
  token: string,  // ← This parameter is declared but never used
  tokenType: string
): Promise<any | null> {
  // TODO: Implement validation for different providers
  // For now, this is a placeholder
  // ...
}
```

**Root Cause**:
The function parameter `token` is declared but not used in the function body (it's a TODO placeholder).

**Solutions**:

**Option A: Prefix with Underscore** (Indicates intentionally unused):
```typescript
async function validateExternalToken(
  _token: string,  // ← Prefix with underscore
  tokenType: string
): Promise<any | null> {
  // TODO: Implement validation for different providers
  // ...
}
```

**Option B: Remove Parameter** (If not needed yet):
```typescript
async function validateExternalToken(
  tokenType: string
): Promise<any | null> {
  // TODO: Implement validation for different providers
  // Will add token parameter when implementing
  // ...
}
```

**Option C: Use Parameter** (If it should be used):
```typescript
async function validateExternalToken(
  token: string,
  tokenType: string
): Promise<any | null> {
  // TODO: Implement validation for different providers
  // For now, log that token validation is not implemented
  console.warn(`Token validation not implemented for type: ${tokenType}, token length: ${token.length}`);
  return null;
}
```

**Recommended Fix**: Option A (prefix with underscore) - preserves function signature for future implementation

**Files to Fix**:
1. `packages/auth/src/token-exchange.ts:35-36`

---

## Summary Table

| # | Error Type | Severity | Files | Status |
|---|-----------|----------|-------|--------|
| 1 | Missing `@synap/database/schema` export | High | 2 files | 🔴 Needs Fix |
| 2 | Missing `@synap/hub-protocol` dependency | High | 1 file | 🔴 Needs Fix |
| 3 | Type mismatch in SQL function result | Medium | 1 file | 🟡 Needs Fix |
| 4 | Unused variable `token` | Low | 1 file | 🟢 Needs Fix |
| 5 | Syntax errors in `migrate.ts` script | Medium | 1 file | 🟡 Needs Investigation |

---

### 5. Syntax Errors in Migration Script

**Severity**: Medium  
**Affected Packages**: `@synap/database`  
**Files Affected**:
- `packages/database/scripts/migrate.ts:43-45`

**Error Messages**:
```
error TS1005: ',' expected.
```

**Root Cause**:
Syntax errors in the migration script, likely related to template literals or string formatting.

**Note**: This is a script file (not part of the main build), but should still be fixed for consistency.

**Files to Fix**:
1. `packages/database/scripts/migrate.ts:43-45` - Investigate syntax errors

---

## Action Plan

### Phase 1: Critical Fixes (High Priority)

1. **Fix Import Paths for `@synap/database/schema`**
   - [ ] Update `packages/api/src/routers/api-keys.ts:12`
   - [ ] Update `packages/api/src/services/api-keys.ts:13`
   - [ ] Verify imports work after changes

2. **Add `@synap/hub-protocol` Dependency**
   - [ ] Add `"@synap/hub-protocol": "workspace:*"` to `packages/api/package.json`
   - [ ] Run `pnpm install`
   - [ ] Verify `@synap/hub-protocol` is built (`pnpm --filter @synap/hub-protocol build`)
   - [ ] Verify imports work after changes

### Phase 2: Type Safety Fixes (Medium Priority)

3. **Fix SQL Function Result Type**
   - [ ] Update `packages/api/src/services/api-keys.ts:322-325`
   - [ ] Use explicit type cast with nullish coalescing (Option B)
   - [ ] Test that function returns correct number value

### Phase 3: Code Quality (Low Priority)

4. **Fix Unused Variable**
   - [ ] Update `packages/auth/src/token-exchange.ts:35-36`
   - [ ] Prefix parameter with underscore (Option A)
   - [ ] Verify no other references to this parameter

### Verification Steps

After all fixes:
1. Run `pnpm build` from root - should complete without errors
2. Run `pnpm --filter @synap/api build` - should complete without errors
3. Run `pnpm --filter @synap/auth build` - should complete without errors
4. Run `pnpm --filter @synap/hub-protocol build` - should complete without errors
5. Run `pnpm --filter @synap/database build` - should complete without errors

---

## Additional Notes

### Dependencies Check

Before fixing, verify these packages are built:
- `@synap/hub-protocol` - Must be built before `@synap/api` can use it
- `@synap/database` - Must be built and export schema correctly

### TypeScript Configuration

Ensure `tsconfig.json` in each package has correct:
- `paths` configuration (if using path aliases)
- `include` / `exclude` patterns
- `references` to other packages (if using project references)

### Build Order

If using workspace dependencies, ensure build order:
1. `@synap/core` (base utilities)
2. `@synap/types` (type definitions)
3. `@synap/database` (database schemas)
4. `@synap/hub-protocol` (protocol schemas)
5. `@synap/api` (depends on above)
6. `@synap/auth` (depends on above)

---

## Testing Checklist

After fixes are applied:

- [ ] All TypeScript compilation errors resolved
- [ ] All linter errors resolved
- [ ] `pnpm build` completes successfully
- [ ] No runtime errors when importing fixed modules
- [ ] API key service functions work correctly
- [ ] Hub protocol imports work correctly
- [ ] Token exchange function compiles without warnings

---

## Related Documentation

- [Hub Protocol V1.0](../PRDs/HUB_PROTOCOL_V1.0.md)
- [API Keys Implementation](../PRDs/API_KEYS_IMPLEMENTATION_STATUS.md)
- [Database Schema Documentation](../../packages/database/src/schema/README.md)

---

**Next Steps**: Proceed with Phase 1 fixes (Critical Fixes) first, then Phase 2 and Phase 3.

