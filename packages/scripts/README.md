# Table Code Generator

Auto-generates worker, permissions, event helpers, and tests for new database tables.

## Usage

```bash
# Interactive mode (recommended)
pnpm codegen:table projects

# Dry run (preview only)
pnpm codegen:table projects --dry-run
```

## What It Generates

1. **Worker** (`packages/jobs/src/functions/TABLE.ts`)
   - Full CRUD operations (create, update, delete)
   - Event emission (validated events)
   - Socket.IO bridge integration
   - TODO markers for customization

2. **Tests** (`packages/jobs/src/functions/TABLE.test.ts`)
   - Worker test suite
   - Database operation validation
   - Event emission tests

3. **Event Helpers** (`packages/events/src/helpers/TABLE.ts`)
   - Type-safe event publisher functions
   - `createRequested`, `updateRequested`, `deleteRequested`

4. **Updates:**
   - `permission-validator.ts` - Adds permission logic
   - `index.ts` - Registers new worker

## Interactive Prompts

The generator asks:
1. Does this table belong to a workspace?
2. Does this table have a userId field (owner)?
3. Generate test files?

## Example Output

```
┌  Table Code Generator
│
◇  Does this table belong to a workspace?
│  Yes
│
◇  Does this table have a userId field (owner)?
│  Yes
│
◇  Generate test files?
│  Yes
│
◆  Files generated successfully
│
├  Generated Files
│  ✓ Worker: packages/jobs/src/functions/projects.ts
│  ✓ Tests: packages/jobs/src/functions/projects.test.ts
│  ✓ Event Helpers: packages/events/src/helpers/projects.ts
│  ⚠ Updated: permission-validator.ts (review changes)
│  ⚠ Updated: index.ts (review changes)
│
├  Next Steps
│  1. Review generated files
│  2. Customize TODO sections as needed
│  3. Run: pnpm --filter @synap/jobs test projects
│  4. Commit changes
│
└  Done! 🎉
```

## Customization

Generated files include `TODO` comments for customization:

```typescript
// TODO: Customize field mapping
await db.insert(projects).values({
  id: data.projectId,
  userId,
  workspaceId: data.workspaceId,
  // TODO: Add other fields from data
});
```

## Code Preservation

Re-running the generator with `--force` preserves custom code between:
- `// CUSTOM START` and `// CUSTOM END` markers
- Or prompts for confirmation before overwriting

## Tips

- Run after creating schema file
- Review generated code before committing
- Customize TODO sections for business logic
- Run tests to validate setup

## Files Structure

```
packages/
├── scripts/
│   └── src/
│       └── generate-table-code.ts
├── jobs/src/functions/
│   ├── TABLE.ts           (generated)
│   └── TABLE.test.ts      (generated)
├── events/src/helpers/
│   └── TABLE.ts           (generated)
```
