# Contributing to Synap

We're thrilled you want to help! 🚀

This document details our standards and workflows to keep the codebase healthy, type-safe, and scalable.

## Quick Setup

1.  **Install pnpm v10+**:
    ```bash
    corepack enable
    pnpm install
    ```

2.  **Validate your environment**:
    ```bash
    pnpm run-ci
    ```
    This runs Lint, Typecheck, Test, and Build across all workspaces to ensure you're starting from a clean slate.

## Workflow

### 1. Quality Gates
We have zero tolerance for broken types in the `main` branch.
Before opening a PR, you **must** run:

```bash
pnpm run-ci
```

Your PR will be blocked if key checks fail:
- **Lint**: No errors allowed. (Warnings are acceptable but should be minimized).
- **Typecheck**: `tsc -b` must pass with 0 errors.
- **Test**: Unit tests must pass.

### 2. Linting & Formatting
We use **ESLint Flat Config** (`eslint.config.mjs`) with Prettier integration.

- **Rule**: `no-explicit-any` is currently `WARN/OFF` due to heavy Drizzle ORM usage, but please avoid `any` wherever possible.
- **Rule**: strict undefined checks are enforced.

To fix lint errors automatically:
```bash
pnpm lint:fix
```

### 3. Database Changes
All schema changes happen in `packages/database`.

1.  Modify `packages/database/src/schema/*.ts`.
2.  Generate migrations:
    ```bash
    pnpm --filter @synap/database db:generate
    ```
3.  Apply (locally):
    ```bash
    pnpm --filter @synap/database db:push
    ```

### 4. Adding New Packages
Use the standard structure:
- `package.json` with `"type": "module"`.
- `tsconfig.json` extending `../../tsconfig.json`.
- `src/index.ts` as entry point.

## Architecture Guidelines

- **API**: Use tRPC for internal services.
- **Types**: Use `@synap-core/types` for shared Drizzle/Zod schemas.
- **Imports**: Prefer strict workspace references (`workspace:*`) to avoid version drift.

## Troubleshooting

- **"Type instantiation is excessively deep..."**:
    Usually caused by complex Drizzle inference. Try casting `input` in your router or simplifying the query.

- **"Module not found..."**:
    Run `pnpm build` in the dependency package, or check `tsconfig.json` paths.

thank you for building with us!
