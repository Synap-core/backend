## Lenses — where you are vs. what you can reach

You don't work "inside a workspace" the way you'd work inside a folder. You operate **across the whole pod**, and you **focus** through up to three composable lenses. **Lenses narrow; they never silo.** Omitting them is legal and common — that's pod-wide.

| Lens          | What it is                                                                                                                       | How to set (this session)                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Project**   | a **company or initiative** — the thing that ties the work together (Synap, a client, a launch). The lens you usually enter through. | `synap project use <id>` / `clear`               |
| **Workspace** | an **operational domain** within the work (Foundation, CRM, Marketing, Finance, Builder) — how a company separates its operations | `synap use <name-or-id>`                         |
| **Session**   | the **work room** for the current goal (holds goal, deliverables, progress)                                                     | `synap session start --goal "…"` / `attach <id>` |

**How they compose — this is the whole model:**
- A **project spans workspaces**: one company/initiative has a Foundation, a CRM, a Marketing, a Finance… each a different operational lens on the *same* project.
- A **workspace spans projects**: the Marketing workspace can hold work for several clients/projects at once.
- Compose either way, or both. That's why they're lenses, not folders: **workspaces exist so that development, finance, marketing, and operations don't pile into one undifferentiated place** — they're the separation that makes the work legible.

- **The connection is pod-wide by design.** Your MCP/CLI link is _not_ welded to a workspace — reads default pod-wide, writes default to a sensible workspace. Pass a lens to narrow a single call; the lens is a focus, not a fence.
- **These are per-Claude-session.** Two concurrent Claude sessions can sit on different projects/workspaces/sessions without colliding. `synap use` here rebinds **this** session only.
- **Inspect anytime:** `synap lens` → the project + workspace + session this session resolves to.

### The "am I in the right place?" reflex

**Before the FIRST write of a new unit of work**, check your lens and orient if you're unsure:

1. `synap lens` — am I scoped where this work belongs?
2. If unsure what exists → `synap orient` — it returns a **light lens map**: the projects and the workspaces (names + ids), so you see the shape without a data dump. Never guess IDs. Drill into a workspace's profiles or a project's contents only when you actually need them.
3. **Connect or create:** if the right project / workspace / session doesn't exist yet, create it. A **session is the normal per-task move**. Creating a **workspace (a new operational domain) is a deliberate, expected move as the work grows** — not something to avoid.

**Don't re-orient mid-flow.** Once you've oriented and you're in a run of related writes, keep going — re-check only when you **start a new piece of work** or switch domains. The reflex guards the _start_ of work, not every call.

### Notice a missing domain — and offer it

Because workspaces are how a company separates its operations, a project is sometimes **missing an operational domain it clearly needs**. If the conversation is squarely about an area — sales, content, finance, hiring, ops — and the active project has **no workspace for it**, say so **once, at the end, in one line**, and offer to set it up:

> _"This project doesn't have a Marketing workspace yet — want me to spin one up and capture the essentials?"_

If they say yes, provision that **one** domain, link it to the project, and run its onboarding interview (see the `agent-os` skill — it handles both the whole-company setup and adding a single domain to an existing project). **Offer, don't auto-build.** One nudge per response, and only when the gap is real — never a checklist of everything the project "could" have.
