# @synap/trpc-types

Shared tRPC types package for Synap frontend/backend type safety.

## Purpose

This package re-exports the `AppRouter` type from `@synap/api` to enable full type safety in frontend applications.

## Installation

```bash
# In your frontend project
pnpm add @synap/trpc-types@file:../synap-backend/packages/trpc-types
```

## Usage

```typescript
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@synap/trpc-types';

export const api = createTRPCReact<AppRouter>();
```

Now you have full type safety and autocomplete for all tRPC procedures!

## Development

```bash
# Build
pnpm run build

# Watch mode
pnpm run dev

# Type check
pnpm run type-check
```

## How It Works

1. Backend (`@synap/api`) exports `AppRouter` type
2. This package re-exports it
3. Frontend imports from this package
4. TypeScript infers all types automatically

## Benefits

- ✅ Full autocomplete in IDE
- ✅ Compile-time type safety  
- ✅ Catch errors before runtime
- ✅ No manual type definitions needed
