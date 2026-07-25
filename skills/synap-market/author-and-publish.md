# Author & publish — the ONE write door

`synap market <verb>` is the only supported authoring path today (human or AI
driving the CLI). There is no agent-native "publish a template" MCP verb —
`market.install` only ever CONSUMES the catalog. Authoring is a human/CLI
action; if you're an agent helping the user author one, drive the CLI on
their behalf and always tell them what you ran.

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
