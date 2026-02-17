# Audit: commit 97d6912 and build artifacts

## What changed (vs “what worked before”)

1. **Pre-commit hook** (`.husky/pre-commit`)
   - **Before:** `pnpm lint-staged` + `pnpm typecheck`
   - **After:** only `pnpm lint-staged`
   - **Effect:** Commits no longer run typecheck, so a commit can succeed even when typecheck would fail. That did **not** create the extra files; it only allowed a commit that included them.

2. **Pre-push hook** (new file `.husky/pre-push`)
   - **Added:** runs `pnpm typecheck && pnpm build` on `git push`.
   - **Effect:** Typecheck/build moved from commit to push. No impact on which files were staged.

3. **Tsconfig path mappings** (`packages/database`, `packages/jobs`)
   - **Added:** `baseUrl` + `paths` so `@synap-core/types` resolves to `../types/src/index.ts`.
   - **Effect:** Fixes TS2307 when running typecheck. Does **not** change where `tsc` emits: `outDir` is still `./dist`, so build output should stay in `dist/`, not in `src/`.

4. **.gitignore**
   - **Added (now):** `**/src/**/*.js`, `**/src/**/*.d.ts`, `**/src/**/*.js.map`, `**/src/**/*.d.ts.map` so build artifacts under `src/` are never tracked.

## Why 314 files (build artifacts) were committed

- `.gitignore` only had `dist/`. Build artifacts were emitted (or left) under **`src/`** (e.g. `packages/database/src/schema/*.js`, `packages/types/src/**/*.js`), so they were **not** ignored.
- With typecheck removed from pre-commit, the commit no longer failed. A broad `git add .` then staged those untracked artifacts and they went into the commit.
- So: the **same** artifacts were likely already on disk before; the only change was that the commit was allowed and they got included.

## Where the `src/` artifacts come from

- Normal config: `outDir: "./dist"`, so `tsc` should write only to `dist/`.
- Artifacts under `src/` usually mean at some point `tsc` was run without the right config (e.g. from a subfolder, or with an old/different tsconfig that had no or wrong `outDir`). The recent tsconfig path changes do **not** make `tsc` emit into `src/`.

## Fix: remove artifacts from git and re-commit cleanly

Run from **synap-backend** root.

**Option A – Undo commit and re-commit without artifacts (recommended)**

The new `.gitignore` entries ensure `**/src/**/*.js`, `*.d.ts`, `*.map` are never tracked. After undoing the commit, re-add everything; ignored files won’t be staged.

```bash
# 1. Undo the last commit; keep working tree, clear index to state before that commit
git reset HEAD~1

# 2. Stage again; .gitignore now excludes build artifacts under src/
git add -A

# 3. Check what is staged (no .js/.d.ts under src/)
git status

# 4. Commit again
git commit -m "feat: new entity-document handling"
```

**Option B – You already pushed 97d6912**

If you want to remove the artifacts from history (rewrite the last commit):

```bash
git reset HEAD~1
git add -A
git status   # verify no src/**/*.js etc.
git commit -m "feat: new entity-document handling"
git push --force-with-lease
```

**Optional: delete build artifacts from disk**

```bash
find packages/database/src packages/types/src -type f \( -name '*.js' -o -name '*.d.ts' -o -name '*.js.map' -o -name '*.d.ts.map' \) -delete
```

After this, future `git add .` will not stage those files thanks to the new .gitignore rules.
