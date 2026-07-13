## Workspace design — is this concern a WORKSPACE, or something smaller?

Before you create a workspace, run the decision rule. A workspace (an operational **domain**) is the heaviest structure in the pod — it owns kinds, confers roles, carries its own team and automations. Most new concerns are NOT domains; they are a **hat**, an **initiative**, or a **stage**. Creating a workspace for one of those is the anti-pattern that fragments the graph. Decide first, then create.

## The decision rule — a concern earns a workspace ONLY if ALL FOUR hold

1. **Owns kinds** — it is source-of-truth for a noun nothing else owns (CRM owns `person`/`company`; Operations owns `engagement`/`deliverable`). If it only _reads_ or _annotates_ another domain's kinds, it is not a domain.
2. **Own team** — a distinct set of operators/collaborators works it (separation of _who_, not just _what_).
3. **Native automations/tools** — it runs behavior its neighbors don't (its own capabilities, playbooks, triggers).
4. **Stable** — it persists across clients and campaigns. If it is per-client or per-campaign, it is time-bound, not a domain.

**All four, or it is not a workspace.** Then fork it to the right lighter structure:

| If the concern is…                                          | It is a…       | Substrate                              | Example                                     |
| ----------------------------------------------------------- | -------------- | -------------------------------------- | ------------------------------------------- |
| a **role/hat** an existing entity wears in a domain         | **Facet**      | `attach_facet` (`profileKind: "role"`) | `client`, `sponsor`, `prospect`, `investor` |
| a **cross-cutting, time-bound initiative** spanning domains | **Project**    | `create_project` (a lens)              | a campaign, an engagement, a launch         |
| a **stage/filter WITHIN a domain**                          | **State/View** | a `status` property def + a view       | pipeline stage, "active"/"archived"         |

## The decision procedure (follow in order)

1. **Name the source-of-truth noun.** What kind would this workspace _own_ that no existing workspace owns? Run `list_profiles` — if the noun already lives in another domain, you have a facet or a project, not a domain. STOP.
2. **Test all four conditions.** Owns kinds AND own team AND native automations AND stable. Any one fails → fork below.
3. **If it's a hat** (a status/role on an entity that already exists elsewhere) → resolve the entity, `attach_facet`. Never a workspace, never a second entity.
4. **If it's time-bound work across domains** → `create_project` and set it as the lens; the work files into it from whatever workspace holds the data.
5. **If it's a stage inside a domain** → add a `status` property def (`create_property_def`) and a view; don't split the stage into its own space.
6. **Only if all four held** → `create_workspace` (propose it — workspace creation is a deliberate move, offer it to the user; see `lenses.md`). Then declare how it lives in the graph (see `workspace-edges.md`).

## The CRM corollary — the load-bearing example

Operational state — **prospect → client → delivered** — is a **FLOW across domains**, expressed as **facets + a triggered project**, NEVER as workspaces and NEVER by bolting delivery onto the identity domain.

- CRM = **who** (owns `person`/`company`, confers the `lead`/`client` facets).
- Operations = **what we do for them** (owns `engagement`/`contract`/`deliverable`).
- The bridge: attaching the `client` facet in CRM **triggers** an engagement project in Operations (see the _triggers_ edge in `workspace-edges.md`).

Bolting delivery-ops onto CRM was the anti-pattern: it made one workspace own two unrelated source-of-truth concerns and blurred _who_ the entity is with _what work_ is happening. Split by ownership; bridge by facet + trigger.

## Why this matters

A workspace is a boundary; a facet/project/state is a connection. Boundaries fragment the graph — they should be rare and earned. When you catch yourself about to create a workspace, check the four conditions: nine times out of ten the honest answer is a facet on an entity that already exists, a project that spans what's already there, or a status field on a kind you already own.
