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
