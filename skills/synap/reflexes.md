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
  person/company/task — call `synap_capture` (CLI: `synap capture`) to write it
  back. Don't wait to be asked; this is how the second brain grows.
- **Remember — when what you learned is about the USER, not the work.** A
  preference, a habit, a working style, a standing constraint ("always run the
  gate before claiming done") — call `synap_remember_fact`, NOT `synap_capture`.
  It writes a `user_observation`, which is the ONE substrate the next agent is
  briefed from at `synap_orient`. Pass `userStated: true` only when the user
  told you directly; leave it off for your own inference and the write comes
  back `proposed` for review, which is correct — an unconfirmed guess about a
  person should not become fact silently.

  This is the difference between the pod knowing _what you worked on_ and
  knowing _how to work with you_. A preference filed as generic content is
  retrievable but never briefs anyone.

- **Scope — DECLARE which work this is, before you write.** The pod has TWO
  lenses and they compose. A **workspace** is a domain (Builder, CRM, Brand) —
  a thing has exactly one. A **project** is a cross-cutting engagement thread
  (a client mandate, a venture, a product line) that runs THROUGH several
  workspaces — a thing can belong to several. Read both from `synap_orient`.

  When the user says what they are working on, pin it: `synap_set_workspace_focus`
  and `synap_set_project_focus` make that choice sticky for the rest of the
  session, so every later write lands in the right place without repeating
  yourself. Pass `workspaceId` / `projectId` explicitly on a single call to
  override the pin for that call only. Filtering reads works the same way —
  pass either, or both, to narrow.

  **Never GUESS a project.** Filing work into one grants access to that
  project's members, so an inferred project is a silent access change, not a
  tidy-up. Declare it, ask the user, or leave it unset — the pod deliberately
  files work with NO project rather than the wrong one, and unset is always the
  safe answer. Guessing a workspace is merely untidy; guessing a project is not.

Run `synap_orient` (CLI: `synap orient`) once per session. It is a BRIEFING, not
an inventory: who the user is, the active projects and their state, the standing
write grammar, and anything awaiting review. Read it before acting — and if the
`who` block is thin, that is a signal to remember something at the end of the
session, not a reason to skip it.

**Writes are governed: a `"proposed"` response is normal, never an error.** It
means the write is queued for the user's review — like a PR, not a failure. Keep
working; see `writes.md` for the full governance contract and `inline-patterns.md`
for how to surface a proposal's review link in a Companion reply.

**No private scratchpad.** Everything you learn goes into the shared graph, not a hidden note. Capture a proven tool-fact into `knowledge` immediately; PROMOTE it into a curated skill only once it's proven reusable — a skill is a versioned artifact (one capability, when-to-use + do/don't), never an append-anything log.

## Escalation ladder (keep in a corner of your head)

You can always escalate — never dead-end on "I can't." Full detail: `escalation-ladder.md`.

- **L0 Reflexes** — recall before, capture after, proposed ≠ error
- **L1 OPERATE on data** — capture, create_entity, link, attach KNOWN facets, sessions,
  and SCOPE the work (`set_workspace_focus` / `set_project_focus`) so it lands where it belongs
- **L2 DISCOVER before invent** — list_profiles, list_capabilities, market.search (capability|template|automation|cell)
- **L3 MUTATE meta-model (proposal-gated)** — only if L2 empty for the need:
  define_role, define_kind (kind + its fields), create_view, create_workspace, market.install.
  **Template FIRST for new domains:** market.search(kind:template) before freehand create_workspace
- **L4 CRYSTALLIZE after proof** — promote_session_to_playbook, promote_cell_to_renderer, create_playbook.
  Never crystallize a one-off that hasn't succeeded once

**Gates:**

- Blocked / can't express need → L2 then L3 propose (never dead-end error; never silent invent)
- Success / repeatable pattern → one structural suggestion (question first if speculative)
- Capture placement routes to EXISTING lenses only — never invent a workspace from capture,
  and never infer a project at all (an unset project is correct; a guessed one widens access)
