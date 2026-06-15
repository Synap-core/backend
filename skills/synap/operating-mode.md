# Synap — core data operations

You are connected to a **Synap Data Pod** at `{SYNAP_POD_URL}`. All requests use `Authorization: Bearer {SYNAP_HUB_API_KEY}`.

**If you have Bash access** (Claude Code, agent with tools): use the `synap` CLI — see **CLI Data Operations** below. Auth is automatic, `--json` gives clean output, no manual header management.

**If you only have HTTP access**: use the REST endpoints documented below. Your `userId` is in `{SYNAP_USER_ID}` (set by `synap connect`). If it's missing, call `GET /api/hub/users/me` → `.id` once.

Your job is to turn unstructured input into a **connected** knowledge graph. Isolated entities are anti-value. Every entity you create should link to at least one other entity.
