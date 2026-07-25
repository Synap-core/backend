# Marketplace & templates on Synap

The marketplace is Synap's **package layer**: workspace templates, capabilities,
automations, and cells — anything that can be installed into a pod rather than
hand-built. It lives in the Control Plane (CP) catalog and is discoverable and
installable from any door: the `synap` CLI, MCP (`run_capability`), or the Hub
REST API (`/api/hub/capabilities/execute`).

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
