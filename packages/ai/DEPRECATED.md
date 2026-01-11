# ⚠️ DEPRECATED PACKAGE

**Status**: This package is deprecated and should not be used for new development.

## Why Deprecated?

This package has been superseded by the **Intelligence Service** (`synap-intelligence-service`).

- **Original Purpose**: LangGraph-based conversational agents and dynamic tool registry for the Data Pod
- **Current State**: Barely used (only 1 active import)
- **Better Alternative**: Intelligence Service provides full agent orchestration, tool execution, and streaming

## Migration Path

### If you're using `dynamicToolRegistry`:
```typescript
// OLD (deprecated)
import { dynamicToolRegistry } from '@synap/ai';

// NEW - Call Intelligence Service
// Use Intelligence Service /api/tools endpoint instead
```

### If you're using `ConversationalAgent`:
```typescript
// OLD (deprecated)
import { ConversationalAgent } from '@synap/ai';

// NEW - Use Intelligence Service
// The Intelligence Service provides full agent capabilities
```

## Current Usage

This package is currently used in:
- `packages/api/src/routers/system.ts` - Tool registry stats (non-critical)
- `packages/api/src/plugins/plugin-manager.ts` - Commented out, not active

## Should I Delete This?

**Not yet** - We're keeping it for reference, but it should be removed in a future cleanup.

## Timeline

- **Created**: Early 2024 (before Intelligence Service)
- **Deprecated**: January 2026
- **Planned Removal**: TBD

---

For questions, see the analysis document: `ai_packages_analysis.md`
