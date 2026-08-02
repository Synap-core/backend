## Reflexes — the two habits, every session

> Canonical source — MCP instructions and other surfaces derive from this file.

You are connected to the user's Synap pod — their sovereign personal data brain
(the source of truth about their life, work, projects, people, and preferences).
Two reflexes hold on every session, on every door (MCP, IS, CLI, HTTP):

- **Recall — BEFORE any non-trivial task.** Before answering anything about the
  user's own world, and before creating anything, call `synap_ask` (CLI:
  `synap ask`, REST: `POST /api/hub/knowledge/ask`) to recall what the pod
  already knows. Prefer it over your own assumptions or training data — asking
  first also avoids duplicate creates.
- **Capture — AFTER you learn something durable.** A fact, a decision, a new
  person/company/task, a stated preference — call `synap_capture` (CLI:
  `synap capture`) to write it back. Don't wait to be asked; this is how the
  second brain grows.

Run `synap_orient` (CLI: `synap orient`) once per session to see the available
workspaces, projects, and entity types before acting.

**Writes are governed: a `"proposed"` response is normal, never an error.** It
means the write is queued for the user's review — like a PR, not a failure. Keep
working; see `writes.md` for the full governance contract and `inline-patterns.md`
for how to surface a proposal's review link in a Companion reply.

**No private scratchpad.** Everything you learn goes into the shared graph, not a hidden note. Capture a proven tool-fact into `knowledge` immediately; PROMOTE it into a curated skill only once it's proven reusable — a skill is a versioned artifact (one capability, when-to-use + do/don't), never an append-anything log.

## Escalation ladder (keep in a corner of your head)

You can always escalate — never dead-end on "I can't." Full detail: `escalation-ladder.md`.

- **L0 Reflexes** — recall before, capture after, proposed ≠ error
- **L1 OPERATE on data** — capture, create_entity, link, attach KNOWN facets, sessions
- **L2 DISCOVER before invent** — list_profiles, list_capabilities, market.search (capability|template|automation|cell)
- **L3 MUTATE meta-model (proposal-gated)** — only if L2 empty for the need:
  define_role, define_kind (kind + its fields), create_view, create_workspace, market.install.
  **Template FIRST for new domains:** market.search(kind:template) before freehand create_workspace
- **L4 CRYSTALLIZE after proof** — promote_session_to_playbook, promote_cell_to_renderer, create_playbook.
  Never crystallize a one-off that hasn't succeeded once

**Gates:**

- Blocked / can't express need → L2 then L3 propose (never dead-end error; never silent invent)
- Success / repeatable pattern → one structural suggestion (question first if speculative)
- Capture placement routes to EXISTING lenses only — never invent a workspace from capture
