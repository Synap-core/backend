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

4. `synap_start_session` — **name the unit of work before you build it.** Title + goal, nothing else; the session is the room the rest of this happens in, not a form to fill. Every write you make afterwards is attributed to it automatically, so the user can open ONE object and see the whole arc instead of loose proposals with no shared story. Reuse an open session that already covers this intent (`synap_list_sessions`) rather than starting a second one. If the intent is a single fact with no structure behind it, skip the session and use the `synap` skill instead — this whole conductor is the wrong door for that.

**Propose its `criteria` — do not grade yourself without them.** Two to five binary, observable statements the person can validate or rewrite ("`list_profiles` returns the `grp-run` kind"), not "the pack is good". They may equally be written by the person; what is not allowed is neither. A session with no criteria leaves you nothing to report against but your own opinion, which is how "85% complete" gets said about work nobody can check. Criteria are declarable at `synap_start_session` and replaceable later with `synap_update_session` — a session created inside a plan carries `expectedOutputs`, not criteria, so set them on the session once it exists.

**A detour is a CHILD session, not an abandoned intent.** If the intent turns out to need infrastructure built first, start the detour with `parentSessionId` (the intent's session) plus `suspendedIntent` — one line naming what you were about to do — so popping back restates the goal instead of relying on memory. The parent stays open.

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
3. **Exactly one next write** you want confirmed. Examples of ONE: reuse+pin project lens; install one overlay template; widen one role; **or one connected PLAN** (below). Not: project + template + onboard Finance + declare all edges + playbook filed as five separate proposals.

Then **wait**. After that write lands (`proposed` is success), the _next_ turn may offer the next one move.

#### ONE write may be a whole connected PLAN

`synap_capture` accepts `projects[]` / `sessions[]` / `documents[]` / `links[]` / `entities[]` / `relations[]` — and `skills[]` / `automations[]` / `rules[]` — in a **single call** that files **ONE proposal**. Steps reference each other by `ref`; ids exist only after approval. A plan carrying a session or project applies **all-or-none**, compensated if any step fails.

This is the difference between a reviewer seeing one graph and deciding once, and seeing fourteen cards with no visible relationship. **Prefer the plan whenever the structure is connected.** It is not a 7-step sequence — it is one decision about one shape.

**The trigger is countable, so count.** The moment you are about to make a second `create_*` call for objects that reference each other — a kind and the playbook that uses it, a project and its sessions, a skill and the automation that calls it — stop: that is ONE plan, not N proposals. This is the check that was missing when an agent filed fourteen.

**Name what the work will produce.** Each `sessions[]` step takes `expectedOutputs` — the documents, entities and decisions this session owes. List them at plan time: the plan's own object list IS the expected outputs, so "done" is derivable from slots the person can see rather than announced as a percentage. Every slot filled means the work is finished **pending the person's review** — never silently closed.

It also resolves ordering that separate proposals cannot: an `automations[]` step whose flow names a skill created by a `skills[]` step in the SAME call resolves, because the skill is materialized before the automation is validated. Filed separately, the second proposal fails — the first has not been approved yet.

Refs, not ids. To change a pending plan, **revise it** (full updated operations, re-validated). Never file a second proposal pointing at items still pending in the first.

**Budget is per proposal, not per object.** An agent has a cap on how many proposals may sit pending at once. Fourteen objects as fourteen proposals can exhaust it and get the next write refused; the same fourteen as one plan costs one slot. If a write is ever refused for the cap, that refusal carries a link to raise it — follow the link, do not retry the write. Retrying is worse than waiting: a refused write that you re-send through another door is how the same playbook ends up in the pod twice.

Do **not** declare every provides/consumes/trigger edge in the opening. Edges are a later turn, and only for the pair this work actually reads.

Do **not** invent CLI (`synap create project --evidenceEntityIds`, `synap marketplace install`, `synap declare workspace source`). Use the MCP/Hub tools this door actually exposes.

Empty workspace ≠ broken. An empty Finance is fine until this intent needs a revenue number.

### 2b. When the work needs a CAPABILITY (a verb an automation calls)

A plan creates instruction skills, automations and rules. **A plan never installs a capability.** Installing one fetches a template from the Control Plane mid-apply, writes secrets and vault grants, and has no undo path — none of which belongs inside an all-or-none batch. Capability access is its own decision, on purpose.

Walk this ladder instead. Every rung is a door that exists; do not invent one.

| Situation                               | Do this                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not sure the verb exists                | `synap_list_capabilities` (a `query` reaches the folded builtin verbs too)                                                                                                                                            |
| Verb exists but is **not enabled**      | **Just run it** — `synap_run_capability`. The refusal files ONE enable request covering your whole pack and hands it back as `enableProposal`, and tells you the action did NOT run. There is no enable tool to call. |
| Verb is not installed                   | `market.search` to find it, then `market.install` — both builtin verbs through `synap_run_capability`. For an agent this ALWAYS files a `capability.install` proposal; that is success, not refusal.                  |
| The tool does not exist at Synap at all | `tool.request` (builtin verb) — records a `tool_request` so the gap is visible instead of silently blocking you                                                                                                       |
| Authoring a reusable PACK               | Declare the need as a package dependency (`relation: "require"`) rather than installing inside the pack                                                                                                               |

**Author the automation LAST.** An automation whose `capability` node names a verb that is not in the catalog is rejected at author time (`capability_unknown_verbId`) — the write never lands, so there is nothing half-built to clean up. Get the verb enabled or installed first, then file the plan that uses it.

A skill your plan creates IS resolvable in the same batch: the automation door looks a verb up by **skill name**, and skills materialize before automations. That is why a fact + a behaviour can ride in one proposal.

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
- **Splitting one coherent structure into N proposals.** If the objects reference each other, they are ONE plan through `synap_capture`, not one `create_*` call each. N cards the reviewer must mentally re-join is the failure this conductor exists to prevent.
- Building structure with no session open. The unit of work is named first (§0.4) or the work arrives as orphan proposals.
- Grading yourself. "85% complete" against no criteria and no declared outputs is an opinion, not a status — propose criteria (§0.4) and expected outputs (§2) so the person can check the claim.
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
