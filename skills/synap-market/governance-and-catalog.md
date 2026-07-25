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
