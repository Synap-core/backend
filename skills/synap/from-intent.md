## From intent — conductor for a new area of work

Use this when the user states an **intent** to start or track something that may need structure (a project, domains, kinds, roles, deals-shaped things) — not when they only want to capture a fact into types that already exist (`synap` skill).

This skill does **not** provision Company OS. That is `system/agent-os/skill` (install **domains** from templates). This skill decides **what the graph should be**, asks until that is clear, then loads the specialist skill for each write.

Load: `system/synap/from-intent`.

### 0. Orient first (firewall)

Before proposing structure:

1. `synap_orient` — pending review first; projects; workspaces.
2. `synap_list_profiles` — kinds **and** roles (`profileKind`, `applicableKinds`, `parentProfileId`, `entityScope`).
3. `synap_ask` — does this intent already live as a project or a cluster of entities?

If a close project exists, **reuse it**. Do not mint a twin.

### 1. Ask before you build (required)

Do not install templates, define kinds, or create a project until you can answer these. Ask only what is still unknown — one short pass, not a wizard.

| Question                                                                             | You are distinguishing                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| What is the **commitment** (the thing we are driving toward over weeks)?             | **Project** (optional; gravity). Not a folder.                                          |
| Which **kinds of work** does it need (sell, build, write, buy, hire…)?               | **Workspaces** (domains). Four-test + template-first. Missing domain → load `agent-os`. |
| What is the **thing** vs a **hat** vs a **relationship-with-a-life** vs a **stage**? | Kind vs **facet on any kind** vs deal-pattern kind vs status/view.                      |
| What already exists that we can **extend**?                                          | `extend-first` — never a twin slug.                                                     |

Hats are **not** limited to people and companies. A role is a hat on **whatever kind** `applicableKinds` lists (`item`, `task`, `deal`, …). “This item is an X” is a facet, not a new kind, until X has its own independent life.

### 2. Propose the graph — confirm — then write

Propose in this order, then wait:

1. Project: reuse / create (human or capture-plan / ≥5 evidence) / skip.
2. Domains: use existing → market template → (rare) create. Confirm each install.
3. Schema: **extend-first** (`system/synap-schema/extend-first`). Confirm any `define_role` / `define_kind` / overlay.
4. Instances + links + facets, under the project lens.
5. Sessions for short work / blockers — **never** nested projects.

`proposed` is success. Do not retry. Do not auto-install.

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

- Invent a kind or role whose **slug or display name** matches something `list_profiles` already returned.
- Invent a workspace that fails the four-test.
- Nested projects. Phases = sessions.
- A second entity for a hat (`kind_mismatch` → **widen** the role’s `applicableKinds`, then `attach_facet`).
- Company/person-only facets. If the hat belongs on `item` (or any kind), the role’s `applicableKinds` must include that kind.
- CRM `deal` (pre-sale pipeline) as a generic price timeline. A commercial snapshot with its own life uses the **deal precedent** (own kind), not a twin `deal` slug and not JSON on the thing.
- Encoding the pattern only as Knowledge and expecting every MCP agent to find it. Skills + this conductor are the all-pods path.

### After it works

Offer L4: session → playbook, cell → renderer, lived setup → package. Never crystallize a guess.
