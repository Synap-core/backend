# Synap CI/CD — single source of truth

**Everything about how Synap builds, tests and publishes lives here.**

Each git repo keeps a real, self-contained workflow file — that is required, because npm's
*Trusted Publishing* identifies a publisher by **repository + workflow filename**. A cross-repo
reusable workflow would change the OIDC identity and break authentication.

"One shared config" here means **one shared set of rules**, enforced automatically by
`synap-backend/ci/scripts/check.mjs`. It is not one file that generates the others: the workflows are
genuinely different (see *Release classes*), and a single linear template cannot express
conditional or output-gated steps.

---

## The model in one picture

```
              synap-backend/ci/repos.yml  +  synap-backend/ci/scripts/check.mjs
                        │
              a set of RULES every publish workflow must satisfy
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
  synap-app/.github/  synap-backend/…  synap-cli/.github/
  workflows/*.yml     workflows/*.yml  workflows/*.yml
        │
        └─ npm Trusted Publishing (OIDC, id-token: write) ─▶ npmjs
             no long-lived NPM_TOKEN
```

- `synap-backend/ci/repos.yml` — which repo publishes what, which invariants hold, which conflicts are open.
- `synap-backend/ci/scripts/check.mjs` — **the gate**. Fails CI when a workflow violates a rule.

### Why rules and not one generated workflow

An earlier version of this directory generated every repo's workflow from one template. That was
the wrong abstraction and it was reverted. The workflows are genuinely different: `synap-app`
versions via changesets, the backend gates its publish on a **step output** (`if: bumped ==
'true'`) and commits the bump back, the CLI is a single package. A linear template cannot express
conditional or output-gated steps — flattening them silently dropped real logic from the backend
pipeline.

npm Trusted Publishing also identifies a publisher by *(repository, workflow filename)*, so a
workflow pulled in via `uses: owner/repo/.github/workflows/x.yml@ref` would change the OIDC
identity npm validates against and break auth. **Each repo needs a real, committed workflow file.**

So "one shared config" here means **one shared set of rules, enforced by `check.mjs`** — not one
shared file that generates the rest. `check.mjs` is what keeps that true.

---

## Release classes

Each class has **exactly one** publish door. This is the rule that fixes the original
defect: four independent ways to bump and publish one version.

| Class | Packages | Door | Version authority |
|---|---|---|---|
| **App internals** | the 66 `@synap-core/*` in `synap-app` | `changeset publish` (CI) | changesets — `major/minor/patch` from a changeset file |
| **Backend contracts** | `@synap-core/types`, `api-types`, `hub-protocol`, `hub-rest-client` | `publish-types.yml` (CI) | `check-and-bump.mjs` — bumps **only if the generated surface changed** |
| **CLI** | `@synap-core/cli` | `publish-cli.yml` (CI) | explicit, in-repo |
| **Templates** | workspace templates | `publish-official-templates.yml` | control-plane API, not npm |
| **Desktop** | Electron binaries | `browser-release.yml` | electron-builder |
| **Mobile** | Relay | EAS | eas.json |
| **Images** | Docker | `docker-publish.yml` | GHCR via `GITHUB_TOKEN` + `id-token` |

### Why contracts do NOT use changesets

`@synap-core/api-types` has a version that is a **lockstep stamp in three places**:
`package.json`, `src/version.ts`, and the `/health` literal in `apps/api/src/index.ts`.
Its bump is **surface-gated** — `check-and-bump.mjs` regenerates `generated.d.ts`, diffs it
against the committed copy, and bumps *only if the router surface actually changed*.

Changesets can express neither. It edits `package.json` plus a changelog, and bumps whenever
a human writes a changeset file. Adopting it would silently break the `/health` contract and
publish versions that claim a change that did not happen. **Do not migrate these to changesets.**

---

## Authentication: Trusted Publishing, not tokens

npm is deprecating long-lived 2FA-bypass tokens. Synap uses **Trusted Publishing** (OIDC):

- No `NPM_TOKEN` secret. Nothing to leak, rotate, or expire.
- npm mints short-lived credentials for the GitHub Actions job based on its identity token.
- **Provenance attestations come for free.**

### Required workflow permissions

```yaml
permissions:
  contents: read          # push version bumps back to the repo
  id-token: write         # ← required for npm to mint credentials
```

`id-token: write` may be declared **ahead of** the npm UI configuration being finished.
It is inert until npm knows to trust the workflow.

### One-time manual setup (npmjs.com — cannot be automated)

For **each** published package:
1. npmjs.com → package → **Settings → Trusted Publishers → Add**
2. Organization/user: `Synap-core`
3. Repository: `Synap-core/<repo>`
4. Workflow filename: `<workflow>.yml` (e.g. `publish-types.yml`)
5. Environment: leave blank unless the job declares an `environment:`

Repeat for every package. This is tedious but one-time.

### Transitional state

Repos may still carry `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. That is intentional and
documented inline: it keeps publishing working while the npm UI is being configured.
**Migration is complete when the secret is deleted from every workflow** — do not delete it
before npm has the Trusted Publisher configured, or publishing stops entirely.

Verify nothing still depends on the secret:

```bash
grep -rn "NPM_TOKEN" */.github/workflows/
```

When that returns only comments and no live `env:` blocks, the migration is done, and the
secret can be deleted from the GitHub repository settings.

---

## Version pinning — one source per repo

Two distinct pins, and they mean different things:

- **`packageManager: "pnpm@X"`** — which pnpm to run. `pnpm/action-setup@v4` reads it
  automatically. **Never also pass `version:`** — the action rejects both and errors with
  *"Multiple versions of pnpm specified"*, which has silently broken pipelines here before.
- **`.node-version`** — which Node to run. `actions/setup-node` reads it via
  `node-version-file:`.

```yaml
- uses: pnpm/action-setup@v4          # no `version:` — reads packageManager
- uses: actions/setup-node@v4
  with:
    node-version-file: ".node-version"
    registry-url: "https://registry.npmjs.org"
```

---

## Concurrency — never cancel a publish

Publishing is not idempotent at the transport layer; killing a run mid-publish can leave a
version half-uploaded. Every publish job serialises and never cancels:

```yaml
concurrency:
  group: npm-publish
  cancel-in-progress: false
```

`cancel-in-progress: true` on a pipeline that also versions is a footgun: it cancels the
publish job, not just the queue wait.

---

## How to publish

There is **no local publish**. Every npm package ships from GitHub Actions.

| What | Workflow (repo) | Trigger |
|---|---|---|
| `@synap-core/types`, `@synap-core/api-types` | `publish-types.yml` (synap-backend) | push to `main` touching routers/types, **or** the *Run workflow* button |
| Other `@synap-core/*` (app internals) | `changeset.yml` (synap-app) | a version PR merges (changesets opens it on every `main` push) |
| `@synap-core/sdk`, `sdk-realtime`, `react` | `publish-packages.yml` (synap-app) | push to `main` touching those paths, or the button |
| `@synap-core/cli` | `publish-cli.yml` (synap-cli) | *Run workflow* button only |
| Workspace templates | `publish-official-templates.yml` (synap-app) | push to `main`, or the button |
| Desktop binaries | `browser-release.yml` (browser) | `./dev ship browser cut` |
| Docker images | `docker-publish.yml` | push to `main` |

Trigger a manual run from the CLI:

```bash
gh workflow run publish-types.yml --repo Synap-core/backend
gh workflow run publish-cli.yml    --repo Synap-core/synap-cli
```

**Before you press the button**, run what CI would run — all local, none of it publishing:

```bash
node synap-backend/ci/scripts/check.mjs               # CI/CD conformance gate
./dev ship api-types verify             # local version vs npm + surface drift
./dev ship api-types dry-run            # build + pack, no upload
```

If a publish fails, `./dev ship api-types auth` diagnoses npm login, 2FA and scope access.

---

Things that will break silently if violated. Each has bitten this repo before.

1. **`workspace:` must never survive into a published tarball.** Consumers get
   `EUNSUPPORTEDPROTOCOL`. `verify-publishable.mjs` inspects the **packed tarball**, never
   the source manifest — pnpm rewrites `workspace:` *after* any `prepack` hook runs, so a
   source-based check false-positives on every legitimate release.

2. **Publish from CI, never from a laptop.** A laptop build once shipped an artifact from a
   different Node than CI pins, and it broke. Publishing is now CI-only by design.

3. **Lockstep version stamps move together.** `package.json`, `src/version.ts`, and the
   `/health` literal. `check-and-bump.mjs` is the only thing allowed to move them, and it
   moves all three at once.

4. **A package name belongs to exactly one repo.** `@synap-core/control-plane-types` exists
   in both `synap-app` (1.1.0) and `synap-control-plane-api` (1.0.2). Both are public, so
   whoever publishes last wins `latest` and consumers get a coin flip between two different
   type surfaces. **Unresolved — see Open Items.**

5. **The changeset `ignore` list is a hand-maintained mirror of publishability.** 188
   entries. `synap-backend/ci/scripts/check.mjs` and `synap-app/scripts/sync-changeset-ignore.mjs --check`
   are the guards; a new public package that is not added to `ignore` will be versioned and
   published by changesets without anyone deciding that.

6. **Never `sudo npm`.** It root-owns `~/.npm/_cacache`, after which every npm call fails
   with `EPERM`. Recovery: `sudo rm -rf ~/.npm/_cacache`.

---

## Local commands

```bash
node synap-backend/ci/scripts/check.mjs      # the CI/CD gate — run it before pushing
node synap-backend/ci/scripts/check.mjs --quiet   # failures only
```

Other repo-level commands:

- `./dev status` — branch/dirty/ahead-behind for every repo
- `./dev verify [repo]` — run gates
- `./dev commit [repo]` / `./dev push [repo]` — per-repo git flow
- `./dev ship api-types auth` — diagnose npm login, 2FA, scope access
- `./dev ship api-types verify` — local version vs npm, and surface drift

These orchestrate across repos. They never publish — see invariant 2.

---

## Open items

| Item | Status |
|---|---|
| `@synap-core/control-plane-types` exists in two repos (invariant 4) | **open — needs a decision on the survivor** |
| `sdk`, `sdk-realtime`, `react` are changeset-ignored yet published by `publish-packages.yml` | migrating to changesets ownership |
| Trusted Publishing configured in the npm UI | **manual — cannot be automated from a repo** |
| `publish-types.yml` cross-repo pin bump for `synap-app` | blocked while `link:` overrides are in place |