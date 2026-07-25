# Install

## CLI — `synap market install <slug>`

```bash
synap market install crm                        # install as a new workspace
synap market install crm --dry-run               # preview: would-create / reuse / conflicts, writes nothing
synap market install crm --onto <workspaceId>     # reconcile ONTO an existing workspace (additive)
synap market install crm --project <id>           # tag seeded entities to a project (install stays pod-wide)
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
