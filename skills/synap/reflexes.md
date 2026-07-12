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
