---
name: synap-market
description: >
  Use this skill when the user (or an agent driving the CLI/MCP/HTTP) wants to
  DISCOVER, INSTALL, or AUTHOR/PUBLISH marketplace & template data on Synap —
  workspace templates, capabilities, automations, and cells. Triggers: "find a
  template for X", "is there a marketplace package for Y", "install this
  template/capability", "create a new template", "publish this as a
  workspace/capability", "scaffold a template", "share my workspace as a
  template", "make this private/public". NOT the `synap` skill (capture/recall
  data INSIDE a workspace) nor `synap-schema` (extending the data model of an
  existing workspace) nor `synap-ui` (building views/dashboards) — this skill is
  about the PACKAGE layer: finding, installing, and publishing reusable
  templates/capabilities/automations/cells to/from the Control Plane catalog.
metadata:
  openclaw:
    requires:
      env: []
    optional_env: [SYNAP_POD_URL, SYNAP_WORKSPACE_ID, SYNAP_HUB_API_KEY]
    primaryEnv: null
    homepage: https://synap.live
    capabilities:
      [market-search, market-install, template-author, template-publish]
    os: [macos, linux, windows]
    userInvocable: true
---

# Marketplace & templates on Synap

Synap is **configuration-first**: a feature is _stored, user-editable config_
published to one catalog and installed through shared substrate — not hardcoded in
the pod backend. The marketplace is that **package layer**, and the catalog
(`synap_packages`) is **kind-agnostic** — one door serves every kind:

| Kind                      | Configures                                                       | Tier                                       |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| **workspace**             | a whole domain (profiles + views + bento + its caps/automations) | ✅ first-class                             |
| **capability**            | a credentialed tool pack (+ embedded skills/playbooks)           | ✅ first-class                             |
| **cell**                  | a renderer — the code that draws an entity/widget                | ✅ first-class                             |
| **view**                  | a saved view/layout                                              | 🟡 publish yes; standalone-install pending |
| **skill**                 | agent know-how                                                   | 🟡 embedded in a capability today          |
| **workflow / automation** | a WHEN→ACTION flow                                               | 🟡 publish yes; standalone-install pending |

First-class = author → publish → install standalone → compose. 🟡 = accepted +
composable, but the standalone _install_ applier isn't wired yet (the system is
honest about this — it accepts the kind rather than faking install).

It lives in the Control Plane (CP) catalog and is discoverable and installable from
any door: the `synap` CLI, MCP (`market_search` / `run_capability`), or the Hub REST
API. **Everything that is config, not code, can be a template** — workspaces, entity
profiles/views, renderers (cells), capabilities, skills, automations.

## The two reflexes

1. **DISCOVER before you invent.** Before scaffolding a new template or
   capability, search the catalog — `synap market --search "<query>"` or the
   `market.search` verb. Someone may have already published what you need.
   Reinventing a workspace that already exists as a template is wasted work
   AND fragments the catalog.
2. **One catalog, never a second one.** Every package — public or private —
   lives in the CP's `synapPackages` table, reached through
   `GET/POST /api/packages`. There is no side channel: don't write a
   template to a random file and call it "published," and don't stand up a
   local list of "known templates" — search the real catalog every time.

## The four things this skill teaches

| Task                                                      | Doc                         |
| --------------------------------------------------------- | --------------------------- |
| Search/browse/fetch a package (any kind)                  | `discover-and-fetch.md`     |
| Install a package into a pod                              | `install.md`                |
| Author a new template and publish it (the ONE write door) | `author-and-publish.md`     |
| Governance rules + the one-catalog principle              | `governance-and-catalog.md` |

## Package kinds

- **workspace / template** — a full workspace definition (profiles, views,
  entity links) you can spin up as a new workspace, or reconcile onto an
  existing one.
- **capability** — a tool + skill bundle (an integration or verb pack).
- **automation** — a trigger + action definition.
- **cell** — a custom UI renderer.

The CLI's browse filter (`market --type`) uses
`workspace|capability|skill|workflow|view|cell`; the pod-native install verb
(`market.install`) and its catalog use the narrower
`capability|automation|template|cell` (workspace ≡ template there). Match
whichever surface you're calling.

## Visibility

Every package is **public** or **private** (owner-only). Default on publish is
**private** — you opt in to sharing with `--public`. A private package 404s
(not 403) to anyone who isn't its author or an active member of its owning pod
— see `governance-and-catalog.md`.

---

# Discover & fetch

Three doors reach the same catalog. Pick the one that matches where you're
running.

## CLI — `synap market`

```bash
synap market                              # browse/list (the default action)
synap market --search "crm"               # filter by name/description/slug
synap market --type capability            # filter by type: workspace|capability|skill|workflow|view|cell
synap market --search "crm" --type workspace --json
```

`market` with no subcommand lists; `--list` is accepted explicitly too. It
merges: your OWN packages (public + private, via `GET /api/packages/mine`)
with the PUBLIC catalog (`GET /api/packages`) — logged out, you only see the
public/bundled set.

Companion commands:

```bash
synap market installed             # what's already installed on THIS pod (pure read)
synap market installed --tree      # composition graph: package → templates → workspaces
synap market update                # check installed packages for drift against the catalog
```

## Pod verb — `market.search` (MCP / agent / automation)

The pod-native verb, run via MCP `run_capability` or
`POST /api/hub/capabilities/execute` with `{ verbId: "market.search", parameters }`:

```json
{ "query": "crm", "kind": "template", "limit": 20 }
```

- `kind` ∈ `capability | automation | template | cell` (omit to search all).
- Reads the pod-local `cp_catalog_cache` — fast, no live CP round-trip.
- Returns `{ entries: [{ slug, kind, name, description, version, tier, installed }], count }`.
- `installed` is `true`/`false` for capability/cell (cheap natural-key check);
  `undefined` for automation/template — that's an HONEST unknown, not a bug,
  never read it as "not installed."
- Empty result → say so plainly ("nothing matched") — never fabricate a
  package that doesn't exist. Offer to capture the gap as a note for later.

This is the verb an agent should reach for first — it's read-only (auto-runs,
no approval needed) and mirrors exactly what `synap market --search` shows a
human.

## Fetching one package's full definition

- **CLI (authoring path):** `synap market publish --from-workspace <id>` reads
  a LIVE workspace via the pod's own `to-template` serializer — see
  `author-and-publish.md`.
- **CP directly:** `GET /api/packages/:slug` returns the full row **with**
  `definition` — the install payload. Auth is required to see a private
  package (author-only). No auth → public only, and a private slug 404s.
- **From an install:** you don't normally need the definition yourself —
  `market.install` (see `install.md`) resolves and applies it for you.

---

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

---

# Author & publish — the ONE write door

Every kind (workspace, capability, cell, view, …) publishes through the SAME door:
`POST /api/packages` → `publishPackageCore`. `synap market <verb>` is the CLI front
end (human, or an AI driving the CLI on the user's behalf — always say what you ran).

**Two distinct AI paths — don't conflate them:**

- **Publish to the MARKET (the shared catalog)** = human / CLI / browser only.
  Publishing a template to the CP catalog needs the user's CP session; an agent
  in the pod holds no CP credential (founder-gated trust boundary). So an agent
  _authors + drives the CLI_, or the user publishes from the browser wizard.
- **Author + PROPOSE an install** = agents CAN do this natively. The IS tool
  **`propose_workspace_template`** authors a full workspace definition and routes it
  through the pod's governed `/packages/apply` → a **reviewable proposal** carrying
  the whole definition (the user sees a live preview and approves). This is NOT a
  market publish — it installs the AI-authored template into the user's pod, governed.
  Use it when the user wants a whole workspace set up as a reviewable proposal.

## The loop

```bash
synap market scaffold my-thing              # writes my-thing.template.yaml (refuses to overwrite)
# ...edit the file...
synap market validate my-thing.template.yaml
synap market publish my-thing.template.yaml            # PRIVATE by default
synap market publish my-thing.template.yaml --public    # opt in to sharing
```

### `scaffold <slug>`

Writes a minimal valid `<slug>.template.yaml` — `meta` (slug/name/description/
icon/color), `workspace` (name/description), and one starter profile. Refuses
to clobber an existing file — create-then-configure, never silently overwrite
an author's work.

### `validate <file>`

Runs the ONE shared validator (`validateTemplate` from
`@synap-core/workspace-templates`) locally — fast feedback before any network
call. Fix every reported error before publishing; the CP re-runs the same
class of check server-side and will reject an invalid definition (400).

### `publish [file]`

```bash
synap market publish [file] [--public|--private] [--from-workspace <id>] [--json]
```

- Validates first — a failing template is never published.
- Default is **private**; pass `--public` to share. `--private` is accepted
  explicitly if a script wants to state intent.
- `--from-workspace <id>` serializes a LIVE, already-built workspace into a
  template via the pod's own `POST /workspaces/:id/to-template` door, then
  publishes that — the fastest way to turn something you already built into a
  reusable package. It runs through the SAME validator as a hand-authored file.
- Writes go to `POST /api/packages` (upsert by `(slug, authorId)`; version is
  a content hash, so republishing identical content is a safe no-op — you'll
  see `outcome: "no-op"` vs `"created"`/`"updated"`).
- Slugs `foundation`, `crm`, `operations`, `content-os`, `enterprise-os`,
  `research-base` are reserved bedrock templates — publishing under one of
  those 403s; pick a different slug.

### Standalone non-workspace kinds (`--kind`)

A lone **cell** (a renderer — the code that draws an entity/widget) or **view** can
be authored + published on its own, same door:

```bash
synap market scaffold --kind cell my-card   # → my-card.cell.json  {category, slug, displayName, definition}
# edit the cell's code/definition
synap market publish my-card.cell.json       # category:"cell", same publish client
```

`--kind view` works the same. `--kind skill` is refused today (no standalone skill
schema yet — author skills _inside_ a capability). The door is category-gated: only
`category:"workspace"` runs the WorkspaceYaml validator + lossless normalization;
every other kind is stored pod-native as-is (a capability/cell is NOT a WorkspaceYaml).

### Compose — ship a whole stack in one install

A template declares `dependencies[]` (`{kind, relation: compose|require}`) so
installing it installs its whole stack in one governed pass. The resolver
materializes **workspace / capability / cell** dependencies today; skill/view/workflow
are _accepted and composable but not yet installed standalone_ (pending appliers) —
so a workspace template can ship its cells + capabilities + a base workspace as ONE
install. Compose, don't inline.

### `unpublish <slug>`

Flips a published package back to private (owner-only). ⚠️ Known gap: the CP's
PATCH validator doesn't yet accept `isPublic` on every deploy — if it 400s,
that's a server-side TODO, not something to work around; report it honestly.

## Server-side validation scope (important honesty note)

`POST /api/packages` validates **self-contained** templates (no `dependencies`
declared) with the full referential-integrity check (dangling profile refs in
views/entityLinks, missing view scope, entityLink predicates). A template that
**declares `dependencies`** (compose/require another template) passes through
this HTTP door **without** that validation — composition-aware server-side
validation is not yet wired for ad-hoc publishes (only the seeded flagship
templates get validated at that level). Don't claim a composed publish was
fully validated; say what actually ran.

## What you're producing

A `PackageDefinition`: `_meta` (slug/name/description/icon/color/tags),
`workspaceName`, `description`, `profiles`, `views`, `entityLinks`, optional
`dependencies`. The scaffolded YAML and `--from-workspace` both produce this
shape — never hand-write JSON against the raw DB row shape.

---

# Governance & the one-catalog principle

## Writes are governed — "proposed" is success

Every mutating marketplace action an AGENT takes (`market.install` above all)
can come back `{ status: "proposed", proposalId, reviewUrl }` instead of
`{ status: "installed" }`. That is the write queued for the pod owner's
review — like opening a PR, not a failure and not an error to retry. Always:

- Surface `reviewUrl` to the user.
- Don't retry the same install hoping for "installed" — it won't change the
  outcome and may create a duplicate proposal.
- Remember an unreviewed proposal isn't live yet: `market.search`'s
  `installed` flag and any downstream read won't reflect it until approved.

An OPERATOR-driven install (the pod owner themself, via CLI with their own
credentials, no agent identity) executes directly — no proposal. The
distinction is WHO is acting, not which door they used.

## One catalog — never fork it

- The catalog is `synapPackages` in the Control Plane, reached through
  `GET/POST/PATCH /api/packages*`. `cp_catalog_cache` on the pod is a
  **read-through cache** of it (populated by sync), not a second source of
  truth — never write to it directly, and never treat a cache miss as "the
  package doesn't exist" without falling back to a live CP fetch (which
  `market.install` already does for automation/template kinds).
- Discovery happens on the CP (`market.search`, `synap market`); apply
  happens on the pod (`market.install`, workspace creation). Don't invent a
  parallel "known templates" list anywhere else in a workflow you're
  building — always search the real catalog.
- Publishing to anywhere other than `POST /api/packages` (e.g. hand-writing a
  file and calling it "published," or registering a template only in a local
  config) is NOT publishing — it produces something invisible to
  `market.search` and every other consumer.

## Visibility model

- **Public** (`isPublic: true`) — visible to everyone via `GET /api/packages`.
- **Private** (`isPublic: false`, the default) — visible only to its
  `authorId` (and, for non-workspace categories, active members of an
  `podId`-owned team). A private **workspace template** is stricter:
  owner-only, full stop, even for pod teammates.
- A private package a caller can't see **404s, never 403s** — this is
  deliberate (don't leak existence). If you get a 404 fetching a package by
  slug, don't assume it never existed — it may just be private to someone
  else.

## Tier gating

A public package can declare `requiredTier`. `GET /api/packages/available`
tells an authed caller which tiered slugs their subscription actually
unlocks; a slug missing from that list but present in the browse catalog is
locked for them — `market.install` pre-checks this and fails before touching
governance, so surface the tier requirement rather than treating it as a
generic install error.
