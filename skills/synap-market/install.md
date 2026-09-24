# Install

## CLI — `synap market install <slug>`

```bash
synap market install crm                        # install as a new workspace
synap market install crm --dry-run               # preview: would-create / reuse / conflicts, writes nothing
synap market install crm --onto <workspaceId>     # reconcile ONTO an existing workspace (additive)
synap market install crm --project <id>           # link the installed workspace(s) to an EXISTING project (id only)
```

Installs are **workspace-first**: a `workspace`/`template` package spins up
(or reconciles onto) a workspace directly. Other package types (capability,
automation, cell) route you to the right surface (`synap capability add`,
etc.) rather than being force-fit into a workspace install.

## Pod verb — `market.install` (MCP / agent / automation)

```json
{ "slug": "crm", "kind": "template", "version": "optional", "params": {} }
```

`kind` ∈ `capability | automation | template | cell` — required, unlike
`market.search`.

**This verb ALWAYS mutates**, so it goes through the full permission gate —
never treat a non-"installed" response as failure:

- **Operator call** (no agent identity — e.g. you're driving the CLI as the
  pod owner): executes directly → `{ status: "installed", result }`.
- **Agent call** (any MCP/automation/agent-key caller): ALWAYS proposes,
  regardless of any standing grant on `market.install` itself — a grant on
  the verb governs _invoking_ it, not the provisioning it performs. Response:
  `{ status: "proposed", proposalId, reviewUrl }`.

**`"proposed"` is success, not an error.** Surface `reviewUrl` to the user so
they can approve it — don't retry, don't report it as a failure. See
`governance-and-catalog.md`.

## Project packs — a suite of workspaces, linked to a project

A **project** is a cross-cutting lens over workspaces, not a package kind. A
"project pack" is a **suite**: an ordinary `workspace`-category package tagged
`suite`, whose `dependencies[]` **`require`** each constituent workspace package
(never `compose` — re-applying must not duplicate workspaces). Installing a
suite installs every constituent workspace (idempotent: reused if present).

**Author one from a live project** — never hand-write the suite:

```bash
synap market publish --from-project <projectId>   # publishes the constituents first, then the thin suite
```

(Agent door: `export_project_pack` returns `{ definition, constituents }` —
publish the constituents before the suite so every `require` resolves.)

**Install onto a project.** The install never needs to know why the project
exists — it installs the workspaces and LINKS them (a `project --uses-->
workspace` edge per workspace, plus seeded entities filed into the project):

```bash
synap market install <suite-slug> --project <projectId>   # EXISTING project id only; errors if not found
```

The CLI has no flag that creates a project. Create the project first:

- **A human**: in the app, or by passing `projectName` on the Hub door
  `POST /api/hub/packages/apply` (mints or reuses by exact name).
- **An agent**: `create_project` requires `evidenceEntityIds` — at least 5
  existing entities that belong to it — or it is REJECTED (not proposed).
  Without that evidence, ask the human to create the project, then install with
  its id.
- **An agent calling `market.install` with `projectName`**: the install becomes
  a proposal that carries the name, and when a human approves it the project is
  minted. The approval is the consent — say so when you propose it.

Two packs on one project = install each with the same `--project <id>`. Each
lands its own workspaces; both link to the project. Only ONE `compose`
dependency is allowed per package, at every level.

**Onboarding comes with the workspaces.** A workspace package's `onboarding`
(`goal`, `framing`, `collect`, `openingQuestions`, `doneWhen`, `expertise`) is
stored on that workspace's `settings.onboarding`. The `onboard` skill runs the
interview when a lens is empty; for a project spanning several workspaces it
sets up one workspace's slice at a time, each entity filed into the project.
There is no project-level recipe — the recipe always lives on a workspace. A
journey completes by itself once the lens holds real data.

## Idempotency by kind

- **capability** — natural key is `(name, workspaceId)`; installing twice
  converges, doesn't duplicate.
- **template/workspace** — keyed by `packageSlug`/`proposalId` (both set to
  the catalog slug); re-installing the same template for the same user
  converges to the existing workspace rather than creating a second one.
- **automation** — pre-checked by `(name, workspace)` before creating.
- **cell** — keyed by `(typeKey, workspaceId)`.

## Locked / tier-gated packages

A package can declare a `requiredTier`. Installing one your account's plan
doesn't cover fails a pre-check (`assertPackageTierAccess`) BEFORE any
proposal or provisioning — tell the user which tier is required rather than
retrying.
