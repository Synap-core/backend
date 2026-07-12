## The Creative Loop — do once, then crystallize to reusable config

The core rhythm of real work in Synap: **do the thing once by hand, then crystallize what worked into reusable configuration.** You author; the user curates. Every crystallization is governed — a `proposed` result is the normal, successful outcome, never an error.

The loop has three moves that compound. Each takes a one-off act and, if it's worth repeating, turns it into standing structure:

| Do-once (author)                        | → Crystallize (curate)              | Tool                          |
| --------------------------------------- | ----------------------------------- | ----------------------------- |
| Work a multi-step goal in a **session** | → a **playbook** (the process)      | `promote_session_to_playbook` |
| Show a result in a **cell**             | → a **renderer** for an entity type | `promote_cell_to_renderer`    |

### 1. Open a session for real work

When the task is a unit of work with a deliverable — research, a build, an investigation, a sprint — and there's no active session, **`start_session`** with a clear `goal` and `expectedOutputs`. The session is the spine that accrues results (see the focus-sessions skill). Don't open one for a one-shot lookup or a casual reply.

### 2. Create a cell to REPORT — don't dump data into chat

When you have something to _show_ the user — a list of leads, a summary, a comparison, a chart — author a **cell** with `create_cell` instead of pasting rows into the message.

- **Declare the data intent in `rendererSource`; do NOT pre-fetch.** Cells use a dynamic data-binding SDK: you describe what the cell needs (e.g. "the open leads in this workspace"), and the runtime binds the live data at render time. Never fetch rows yourself and inline them — that snapshot goes stale and defeats the cell.
- Keep one cell to one job. A good, focused cell is the raw material for the next move.

### 3. Promote a good cell to a renderer — recurring presentation

When a cell is a _good, recurring way to present a whole entity type or step_ — e.g. every `bookmark`'s detail view, every `lead`'s list row — promote it with `promote_cell_to_renderer`:

- Pick the `profileSlug` (the entity type), the `slot` (`list` | `detail` | `dashboard`), and the `cellKey` from `create_cell`.
- This is **governed**: for you it returns `{ status: "proposed", proposalId }`. That is the point — you author the renderer, the user reviews and curates it before it becomes every entity's view. Surface the proposal plainly ("I've proposed this as the detail view for bookmarks — review it when you like"), don't treat it as a failure.
- Use `scope: "pod"` only when the presentation should apply in every workspace; default to workspace scope.

### 4. Promote a finished session to a playbook — recurring process

When the session is done **and the work was a repeatable process** (not a one-off), promote it with `promote_session_to_playbook({ sessionId })`. This captures the goal, tasks, expected outputs, and steps as a reusable session template — so next time the process starts pre-built instead of from scratch.

- Do this at the _end_, once the promised outputs are produced and verified.
- Judge repeatability honestly: a bespoke, never-again investigation is not a playbook. A "weekly competitor scan" or "new-client onboarding" is.
- Governed like the others — `promoted` (applied) or `proposed` (awaiting review) are both normal.

### The symmetry

Sessions and cells are the two things you _do_; playbooks and renderers are the two things you _keep_. The instinct to build: **first do it once concretely, watch it work, then offer to crystallize it** — and let the user decide what becomes standing config. Never crystallize speculatively before the one-off has proven itself.
