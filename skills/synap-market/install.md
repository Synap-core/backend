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

**One space per domain:** A space is a domain, installed once (Content, Brand, CRM…). A project is a filter across spaces. To make something “for project X”: file it into X inside the domain's space (`file_into_project`), and link X to the space (`project_use_workspace`). Never create a space named after a project, a brand or a client. Reinstalling reuses the live space. A template is installed **once per pod**, and a space name is held by **one** active space — whoever owns it, human or agent alike: a second copy is refused (`409` — `status: "exists"` + the space to use, or `WORKSPACE_IDENTITY_CONFLICT` naming the space that holds it). There are no named copies: `--as <name>` / `instanceName` answers `400`, and a package with no `_meta.slug` (and no `--onto` target) answers `400` instead of minting a second space.

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

**The brief comes with the workspaces.** A workspace package's `onboarding` is
the space's BRIEF — steady state (`purpose`, `framing`, `expertise`, `anchors`,
`fetch`) plus its onboarding mode (`goal`, `collect`, `openingQuestions`,
`doneWhen`) — stored on that workspace's `settings.onboarding`; the package's
top-level `rules[]` install as the space's rules. A template update reaches an
installed space without overwriting what its owner edited (conflicts are
reported), and `synap_update_space_brief` proposes a change. The `onboard` skill runs the
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

## Template updates — where a space stands, and whose step it is

Read it with MCP `synap_template_health` (or `synap templates` in a terminal).
Each space's row says what is left to do; act on these fields, not on
`drifted` alone (`drifted: true` means "there is a step", not "apply now"):

| Field | Means | Your move |
|---|---|---|
| `state: "active"`, `drifted: true` | a newer version is out | the update path below |
| `state: "awaiting-approval"` + `awaitingApproval: [ids]` | the last update filed proposals | point the person to them; **do not re-apply** |
| `state: "partial"` / `"layer-2-not-run"` / `"failed"` | the last update did not finish | `synap templates update <slug>` finishes it |
| `pendingDataChanges: {count, sentences, needsPodAdmin}` | the update changes existing data and waits for a **person** to agree | tell them the sentences; they run `synap templates update <slug>` themselves (a pod owner/admin when `needsPodAdmin`) |
| `updateProposal: {id}` | an update of this space is already proposed | point the person to that proposal; **never file another** |
| `applyWarning` | the pod's one sentence for what is left | relay it as is |

The update path is `synap templates update <slug>` (the person's door). Run
with an agent key it becomes a proposal the person approves. **Agreeing to data
changes is never an agent's**: the door answers `409
DATA_CHANGES_NEED_CONSENT` with `needsPerson: true` for any agent, whatever it
lists in `acceptDataChanges`. The version stamp (`settings.template.version`) is
written only when an update converged, so a space never reads "up to date" over
an update that did not land.

## Locked / tier-gated packages

A package can declare a `requiredTier`. Installing one your account's plan
doesn't cover fails a pre-check (`assertPackageTierAccess`) BEFORE any
proposal or provisioning — tell the user which tier is required rather than
retrying.
