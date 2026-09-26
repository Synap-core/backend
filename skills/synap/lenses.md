## Lenses — where you are vs. what you can reach

You don't work "inside a workspace" the way you'd work inside a folder. You operate **across the whole pod**, and you **focus** through up to three composable lenses. **Lenses narrow; they never silo.** Omitting them is legal and common — that's pod-wide.

Tool names below are stems; your door may prefix them.

What each word means (workspace, project, track, step, work): `concepts` — the one glossary. This file is only about scoping.

| Lens          | Scopes                                                     | Set it (MCP / CLI)                                                 |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| **Workspace** | a domain; a thing lives in exactly ONE; default write home | `set_workspace_focus` / `synap use <name-or-id>`                   |
| **Project**   | a commitment across workspaces; a thing can be in several  | `set_project_focus` or `projectId` / `synap project use <id>`      |
| **Session**   | the work room for the current goal; pass its id on writes  | `start_session` / `synap session start --goal "…"` / `attach <id>` |

**The project rule (one rule, every door):** a project is set ONLY when the user names it — declare it with `set_project_focus`, or pass `projectId` on the write. Filing into a project shares entities and documents with its members (a session is shared only through its room, never by filing), so never infer one from content, and never let a session decide it: a write without a `sessionId` is grouped into YOUR session — the one you started, else one opened for you, never another client's — and that door-picked session never sets the project. When nobody named a project, leave it unset. Guessing a workspace is merely untidy; guessing a project is not.

**Reads:** pod-wide by default; find by name, id or role, and pass `workspaceId` / `projectId` only to narrow a list.

**Writes:** name the kind (profile slug) and, when known, the roles as facets. Omit `workspaceId` unless you are deliberately pinning a domain — the server places the write from installed profile metadata. Never invent a workspace name. Focus sticks for the session; an explicit `workspaceId` / `projectId` on one call overrides it for that call.

**Empty domains:** a workspace holding 0 entities is a scaffold — prefer an active one unless the user names it (`orient` lists active domains; `detail:'full'` shows every one).

**Where the kinds are:** `orient` names the kinds in use, most-used first; the profile-listing tool lists every kind and role. A kind's property schema (fields, enums, required): over MCP, `get_entity` on any existing entity of that kind returns it as `effectiveProperties`; over HTTP, `GET /api/hub/discover?profileSlugs=<slug>`; CLI `synap discover`. A write that breaks the schema is rejected with the valid fields quoted.

**How they compose** (definitions: `concepts`):

- A **project spans workspaces** and a **workspace spans projects**.
- **Membership is per-entity, filed on write.** An entity belongs to a project because it was written **under that project lens** (`belongs_to_project`) — that is the data ACL/filing edge. Separately, provisioning with a `projectId` also stamps **`project --uses--> workspace`**: an INDEX of domains the engagement runs through. That index is **not** an ACL and does **not** replace entity filing — set the project lens before writing work so entities compose into the project from any workspace.
- A method inside a project is a **track**, never a child project or a workspace; a bounded piece of work is a **session** (`trackId` when it belongs to a track). There are no nested projects.

- **The connection is pod-wide by design.** Your MCP/CLI link is _not_ welded to a workspace — reads default pod-wide, writes default to a sensible workspace. Pass a lens to narrow a single call; the lens is a focus, not a fence.
- **These are per-Claude-session.** Two concurrent Claude sessions can sit on different projects/workspaces/sessions without colliding. `synap use` here rebinds **this** session only.
- **Inspect anytime:** `synap lens` → the project + workspace + session this session resolves to.

### The "am I in the right place?" reflex

**Before the FIRST write of a new unit of work**, check your lens and orient if you're unsure:

1. `synap lens` — am I scoped where this work belongs?
2. If unsure what exists → `synap orient` — it returns the **briefing**: pending review, open sessions, the kinds in use, then the projects and workspaces (names + ids), without a data dump. Never guess IDs. Drill into a workspace's profiles or a project's contents only when you actually need them.
3. **Connect or create:** if the right project / workspace / session doesn't exist yet, create it. A **session is the normal per-task move**. Creating a **workspace (a new operational domain) is a deliberate, expected move as the work grows** — not something to avoid. A **project, though, is a COMMITMENT WITH GRAVITY**: search existing projects first (`synap orient`) and prefer **linking into an existing one** via `belongs_to_project`. Only create a new project for a real initiative that ties work together — never for a task, plan, repo, or theme (those are entities), and **never for the pod owner's own company** (the company _is_ the pod, not a project inside it). An agent-created project must cite **≥5 existing entities** as evidence or the backend rejects it, and near-duplicate names are rejected with the existing candidates.

**Don't re-orient mid-flow.** Once you've oriented and you're in a run of related writes, keep going — re-check only when you **start a new piece of work** or switch domains. The reflex guards the _start_ of work, not every call.

### Notice a missing method or domain — and offer it

A project sometimes clearly needs something it lacks. Tell the two apart first:

- **A method is missing** (the talk is about how to run sales, content, the business model… and `list_tracks` shows no track for it) → offer a **track**: _"This project isn't running a Content track yet — want me to start one?"_ Find a project-scoped playbook (`list_playbooks` / `match_playbooks`) and `start_track`.
- **A domain is missing** (new kinds of things must be recorded that no workspace owns — e.g. you are logging deals and there is no CRM) → offer a **workspace**, provisioned with the project lens active (see the `agent-os` skill). Never a workspace to stand for a method.

Say it **once, at the end, in one line**. **Offer, don't auto-build.** One nudge per response, only when the gap is real — never a checklist of everything the project "could" have. **If the user has already declined it (this session or before), drop it — don't re-offer.**
