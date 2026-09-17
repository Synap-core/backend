## Lenses — where you are vs. what you can reach

You don't work "inside a workspace" the way you'd work inside a folder. You operate **across the whole pod**, and you **focus** through up to three composable lenses. **Lenses narrow; they never silo.** Omitting them is legal and common — that's pod-wide.

Tool names below are stems; your door may prefix them.

| Lens          | What it is                                                                                                                                        | Set it (MCP / CLI)                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Workspace** | an **operational domain** (CRM, Builder, Marketing). A thing lives in exactly ONE. How the work is separated; the default home for writes.        | `set_workspace_focus` / `synap use <name-or-id>`                   |
| **Project**   | a **cross-cutting engagement** (a client mandate, a venture, a product line) that runs THROUGH several workspaces; a thing can belong to several. | `set_project_focus` or `projectId` / `synap project use <id>`      |
| **Session**   | the **work room** for the current goal (goal, deliverables, progress). Pass its id on writes that belong to it.                                   | `start_session` / `synap session start --goal "…"` / `attach <id>` |

**The project rule (one rule, every door):** a project is set ONLY when the user names it — declare it with `set_project_focus`, or pass `projectId` on the write. Filing work into a project grants its members access, so never infer one from content, and never let a session decide it: a write without a `sessionId` is attributed to your newest open work session (the response says so), and that guessed session never sets the project. When nobody named a project, leave it unset. Guessing a workspace is merely untidy; guessing a project is not.

**Reads:** pod-wide by default; find by name, id or role, and pass `workspaceId` / `projectId` only to narrow a list.

**Writes:** name the kind (profile slug) and, when known, the roles as facets. Omit `workspaceId` unless you are deliberately pinning a domain — the server places the write from installed profile metadata. Never invent a workspace name. Focus sticks for the session; an explicit `workspaceId` / `projectId` on one call overrides it for that call.

**Empty domains:** a workspace holding 0 entities is a scaffold — prefer an active one unless the user names it (`orient` lists active domains; `detail:'full'` shows every one).

**Where the kinds are:** `orient` names the kinds in use, most-used first; the profile-listing tool lists every kind and role. A kind's property schema (fields, enums, required): over MCP, `get_entity` on any existing entity of that kind returns it as `effectiveProperties`; over HTTP, `GET /api/hub/discover?profileSlugs=<slug>`; CLI `synap discover`. A write that breaks the schema is rejected with the valid fields quoted.

**How they compose — this is the whole model:**

- A **project spans workspaces**: one engagement has a CRM, a Marketing, a Finance… each a different operational lens on the _same_ project.
- A **workspace spans projects**: the Marketing workspace can hold work for several clients/projects at once.
- **Membership is per-entity, filed on write.** An entity belongs to a project because it was written **under that project lens** (`belongs_to_project`) — that is the data ACL/filing edge. Separately, provisioning with a `projectId` also stamps **`project --uses--> workspace`**: an INDEX of domains the engagement runs through. That index is **not** an ACL and does **not** replace entity filing — set the project lens before writing work so entities compose into the project from any workspace.
- **User-speech "sub-project" = session, never a child project.** Phases, blockers, and work streams are `start_session` with `parentSessionId` / `blockedBySessionIds` under the same project lens. There are no nested projects.
- Compose either way, or both. That's why they're lenses, not folders: **workspaces exist so that development, finance, marketing, and operations don't pile into one undifferentiated place** — they're the separation that makes the work legible.

- **The connection is pod-wide by design.** Your MCP/CLI link is _not_ welded to a workspace — reads default pod-wide, writes default to a sensible workspace. Pass a lens to narrow a single call; the lens is a focus, not a fence.
- **These are per-Claude-session.** Two concurrent Claude sessions can sit on different projects/workspaces/sessions without colliding. `synap use` here rebinds **this** session only.
- **Inspect anytime:** `synap lens` → the project + workspace + session this session resolves to.

### The "am I in the right place?" reflex

**Before the FIRST write of a new unit of work**, check your lens and orient if you're unsure:

1. `synap lens` — am I scoped where this work belongs?
2. If unsure what exists → `synap orient` — it returns the **briefing**: pending review, open sessions, the kinds in use, then the projects and workspaces (names + ids), without a data dump. Never guess IDs. Drill into a workspace's profiles or a project's contents only when you actually need them.
3. **Connect or create:** if the right project / workspace / session doesn't exist yet, create it. A **session is the normal per-task move**. Creating a **workspace (a new operational domain) is a deliberate, expected move as the work grows** — not something to avoid. A **project, though, is a COMMITMENT WITH GRAVITY**: search existing projects first (`synap orient`) and prefer **linking into an existing one** via `belongs_to_project`. Only create a new project for a real initiative that ties work together — never for a task, plan, repo, or theme (those are entities), and **never for the pod owner's own company** (the company _is_ the pod, not a project inside it). An agent-created project must cite **≥5 existing entities** as evidence or the backend rejects it, and near-duplicate names are rejected with the existing candidates.

**Don't re-orient mid-flow.** Once you've oriented and you're in a run of related writes, keep going — re-check only when you **start a new piece of work** or switch domains. The reflex guards the _start_ of work, not every call.

### Notice a missing domain — and offer it

Because workspaces are how a company separates its operations, a project is sometimes **missing an operational domain it clearly needs**. If the conversation is squarely about an area — sales, content, finance, hiring, ops — and the active project has **no workspace for it**, say so **once, at the end, in one line**, and offer to set it up:

> _"This project doesn't have a Marketing workspace yet — want me to spin one up and capture the essentials?"_

If they say yes, provision that **one** domain and run its onboarding interview **with the project lens active** (so its entities file into the project) (see the `agent-os` skill — it handles both the whole-company setup and adding a single domain to an existing project). **Offer, don't auto-build.** One nudge per response, and only when the gap is real — never a checklist of everything the project "could" have. **If the user has already declined a domain (this session or before), drop it — don't re-offer.**
