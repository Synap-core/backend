## Lenses — where you are vs. what you can reach

You don't work "inside a workspace" the way you'd work inside a folder. You operate **across the whole pod**, and you **focus** through up to three composable lenses. **Lenses narrow; they never silo.** Omitting them is legal and common — that's pod-wide.

| Lens          | What it is                                                                                                | Granularity                      | How to set (this session)                        |
| ------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| **Workspace** | a **domain** (Builder, Marketing, a client) — the home for domain `knowledge` + workspace-scoped profiles | usually one, **not necessarily** | `synap use <name-or-id>`                         |
| **Project**   | a **cross-cutting** dimension (a client, an initiative) — orthogonal to workspace, composable with it     | optional                         | `synap project use <id>` / `clear`               |
| **Session**   | the **work room** for the current goal (holds goal, deliverables, progress)                               | **the day-to-day move**          | `synap session start --goal "…"` / `attach <id>` |

- **The connection is pod-wide by design.** Your MCP/CLI link is _not_ welded to a workspace — reads default pod-wide, writes default to a sensible workspace. Pass a lens to narrow a single call; the lens is a focus, not a fence.
- **These are per-Claude-session.** Two concurrent Claude sessions can sit on different workspaces/projects/sessions without colliding. `synap use` here rebinds **this** session only.
- **Inspect anytime:** `synap lens` → the workspace + project + session this session resolves to.

### The "am I in the right place?" reflex

**Before the FIRST write of a new unit of work**, check your lens and orient if you're unsure:

1. `synap lens` — am I scoped where this work belongs?
2. If unsure what exists → `synap orient` (lists workspaces **and** projects) — never guess IDs.
3. **Connect or create:** if the right workspace / project / session doesn't exist yet, create it (workspaces/projects are rare; **a session is the normal per-task move**). If it exists, attach to it.

**Don't re-orient mid-flow.** Once you've oriented and you're in a run of related writes, keep going — re-check only when you **start a new piece of work** or switch domains. The reflex guards the _start_ of work, not every call.

> Sessions are the everyday primitive: opening/attaching one is routine. Changing workspace or project is occasional — do it deliberately, when the work's domain genuinely changes.
