# Config Loading Issue - Root Cause Analysis

## Issues Encountered

### 1. Build Errors (✅ RESOLVED)
- **TypeScript compilation errors**: Unused variables, missing types, incorrect imports
- **Resolution**: Fixed all TypeScript errors properly
- **Status**: ✅ Correctly resolved - these were legitimate code issues

### 2. Runtime Config Loading Errors (⚠️ PARTIALLY RESOLVED WITH BANDAGE)

#### Problem
Multiple packages try to access `@synap/core` config at **module load time** to create singleton instances:

1. **`@synap/jobs`** - Creates `inngest` client
2. **`@synap/ai`** - Creates `conversationalAgent` singleton  
3. **`@synap/storage`** - Creates `storage` singleton

#### Root Cause
- ESM modules load asynchronously
- Import order is not guaranteed
- When `@synap/jobs` or `@synap/ai` are imported, they execute top-level code that tries to access `config`
- But `@synap/core` might not be imported yet, or config might not be loaded yet
- This causes: `Error: Config not loaded. Please ensure @synap/core is imported before using...`

#### Current "Fix" (Bandage)
For `@synap/jobs`, I used:
- Proxy pattern for lazy initialization
- `globalThis.__synap_core_module` hack to access config
- This works but is **not clean architecture**

#### What Still Needs Fixing
- `@synap/ai` - Same issue, needs same fix
- `@synap/storage` - Same pattern, might need fix too

## Proper Solution (Not Implemented Yet)

### Option 1: True Lazy Initialization (Recommended)
Make all singletons truly lazy - only initialize when first accessed:
```typescript
// Instead of: export const inngest = new Inngest(...) at top level
// Do: Lazy getter that initializes on first access
```

### Option 2: Dependency Injection
Pass config as parameter instead of reading from global:
```typescript
// Instead of: function getInngest() { return new Inngest({ eventKey: config.inngest.eventKey }) }
// Do: function createInngest(config: Config) { return new Inngest({ eventKey: config.inngest.eventKey }) }
```

### Option 3: Ensure Import Order
Make sure `@synap/core` is always imported first, but this is fragile.

## Current Status

- ✅ Build errors: Fixed
- ⚠️ `@synap/jobs`: Fixed with bandage (works but not ideal)
- ❌ `@synap/ai`: Same issue, needs same fix
- ❓ `@synap/storage`: Might have same issue

## Next Steps

1. Apply same Proxy + globalThis fix to `@synap/ai` (quick fix to get server running)
2. Later: Refactor to proper lazy initialization or dependency injection pattern

