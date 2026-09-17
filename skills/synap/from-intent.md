## From intent — conductor for a new area of work

Use this when the user states an **intent** to start or track something that may need structure (a project, domains, kinds, roles, deals-shaped things) — not when they only want to capture a fact into types that already exist (`synap` skill).

This skill does **not** provision Company OS. That is `system/agent-os/skill` (install **domains** from templates). This skill decides **what the graph should be**, asks until that is clear, then loads the specialist skill for each write.

Load: `system/synap/from-intent`.

### 0. Orient first (firewall)

Before proposing structure:

1. `synap_orient` — pending review first; projects; workspaces.
2. `synap_list_profiles` — kinds **and** roles (`profileKind`, `applicableKinds`, `parentProfileId`, `entityScope`).
3. `synap_ask` — does this intent already live as a project or a cluster of entities?

If a close project exists, **reuse it**. Do not mint a twin. Name-match is enough: if orient already lists a project whose description is this company or this commitment, that **is** the project. Ask "reuse «Launch The Architech»?" — do not invent «Architech Business Model» next to it.

**Pending review first.** If `startHere.pendingReview.count > 0`, offer to walk the queue before any new structure. Unreviewed work looks missing and gets duplicated.

### 1. Ask before you build (required)

Do not install templates, define kinds, or create a project until you can answer these. Ask only what is still unknown — one short pass, not a wizard. Never a 7-step implementation plan in the first reply.

| Question                                                                             | You are distinguishing                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| What is the **commitment** (the thing we are driving toward over weeks)?             | **Project** (optional; gravity). Not a folder.                                          |
| Which **kinds of work** does it need (sell, build, write, buy, hire…)?               | **Workspaces** (domains). Four-test + template-first. Missing domain → load `agent-os`. |
| What is the **thing** vs a **hat** vs a **relationship-with-a-life** vs a **stage**? | Kind vs **facet on any kind** vs deal-pattern kind vs status/view.                      |
| What already exists that we can **extend**?                                          | `extend-first` — never a twin slug.                                                     |

Hats are **not** limited to people and companies. A role is a hat on **whatever kind** `applicableKinds` lists (`item`, `task`, `deal`, …). “This item is an X” is a facet, not a new kind, until X has its own independent life.

### 2. Propose a MINIMAL graph — one question — ONE next write

After orient, your first user-facing message is:

1. **Reuse or not** — name the existing project(s) that already match. If none, say you would create one (human / capture-plan / ≥5 evidence). Stop if they must choose.
2. **What already covers the intent** — existing workspaces (do not onboard an **empty** domain unless this session's goal needs data there _now_). Existing kinds/roles (extend-first).
3. **Exactly one next write** you want confirmed. Examples of ONE: reuse+pin project lens; install one overlay template; start one session; widen one role. Not: project + template + onboard Finance + declare all edges + playbook.

Then **wait**. After that write lands (`proposed` is success), the _next_ turn may offer the next one move.

Do **not** declare every provides/consumes/trigger edge in the opening. Edges are a later turn, and only for the pair this work actually reads.

Do **not** invent CLI (`synap create project --evidenceEntityIds`, `synap marketplace install`, `synap declare workspace source`). Use the MCP/Hub tools this door actually exposes.

Empty workspace ≠ broken. An empty Finance is fine until this intent needs a revenue number.

### 3. Which skill to load next

| Need                                         | Skill                                                      |
| -------------------------------------------- | ---------------------------------------------------------- |
| Schema: facet, overlay, child kind, new kind | `system/synap-schema/extend-first` then `extend-vs-create` |
| Missing operational domain                   | `system/agent-os/skill`                                    |
| Views / cards once the model exists          | `system/synap-ui/skill`                                    |
| Lenses, gravity, sessions                    | `system/synap/lenses`                                      |
| Four-test for a workspace                    | `system/synap/workspace-design`                            |
| Index of everything                          | `catalog`                                                  |

### Firewalls (never)

- Twin **project**: orient already has this company/commitment under another name.
- Twin kind/role whose **slug or display name** matches `list_profiles`.
- A 7-step "right sequence" in the first confirm. One structural move per turn.
- Onboard or fill an empty workspace "because it is empty."
- Invent a workspace that fails the four-test.
- Nested projects. Phases = sessions.
- Invent CLI flags or tools this door does not list.
- A second entity for a hat (`kind_mismatch` → **widen** the role’s `applicableKinds`, then `attach_facet`).
- Company/person-only facets. If the hat belongs on `item` (or any kind), the role’s `applicableKinds` must include that kind.
- CRM `deal` (pre-sale pipeline) as a generic price timeline. A commercial snapshot with its own life uses the **deal precedent** (own kind), not a twin `deal` slug and not JSON on the thing.
- Encoding the pattern only as Knowledge and expecting every MCP agent to find it. Skills + this conductor are the all-pods path.

### After it works

Offer L4, one at a time: session → playbook; cell → renderer; **project → suite pack** (`synap_export_project_pack` / CLI `--from-project`). Export returns a thin suite **plus** full constituent workspace packages — publish constituents first, then the suite (CLI does both). Install with `projectName` (human) or `projectId` (agent) to mint/reuse a named engagement and stamp uses-edges. Optional `projectSurface` lands in `projects.settings.layout` (engagement UI). Not live entity rows. Never crystallize a guess. No `app` package type.
