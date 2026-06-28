## CLI Data Operations (Bash tool)

When Claude Code (or any agent with Bash access) is using this skill, prefer the `synap` CLI over raw HTTP calls — auth is automatic, output is clean JSON, no spinners in `--json` mode.

**Session context — set once, never repeat:**

The CLI inherits your pod + lens automatically; set them once and every later command picks them up. Do NOT pass `--pod-url`, `--api-key`, or `--workspace` on every command. Inside a Claude session, `synap use` / `synap project use` bind **this session's lens** (`~/.synap/lenses/<session_id>.json`) — so concurrent sessions stay independent; outside one, they set the global default (`~/.synap/config.json`).

```bash
synap pods use <profile-name>          # switch active pod
synap use <workspace-id>               # focus a workspace (this session) — captures land here; it IS the domain
synap project use <id>                 # add the project lens (composable)
synap lens                             # inspect: workspace + project + session this session resolves to
```

**Always orient first:**

```bash
synap orient --json
# Returns: userId, podUrl, workspaces[{id, name, slug}]
# Never hardcode workspace IDs — discover them here.
```

**Ask (the one read verb — routes across all substrates):**

```bash
synap ask "project ideas" --json
synap ask "what did Antoine decide about auth" --workspace=<id> --json
synap ask "how do I deploy the backend" --json   # routes to procedural how-to docs
# Omit --workspace for pod-wide; include it to scope to one workspace.
# `ask` classifies intent and unions the right substrate(s) — it replaces search/recall.
```

**Read entities:**

```bash
synap list workspaces --json
synap list entities --workspace=<id> --json
synap list entities --profile=task --workspace=<id> --json
synap get entity <id> --json
```

**Capturing a decision (the AI structures — it never `note`s):**

```bash
synap capture --type decision --claim "Use Typesense for entity search" --json
# Retrieve later with the one read verb: synap ask "Typesense decision"
```

> `synap note` is the HUMAN's raw "dump now, structure later" inbox. As the AI, always `capture` into a lane — structuring is your job.

**Structured knowledge (durable, typed, searchable — preferred for engineering learnings):**

```bash
# Work lane (default): a domain gotcha/lesson/decision → knowledge entity in the ACTIVE workspace
synap capture --type gotcha --claim "Hono static routes must come before /:id" \
  --why "First-match routing; dynamic routes eat static ones" \
  --tags "repo:synap-backend,layer:routing" --json

synap capture --type lesson --claim "code-read ≠ runtime-true for library APIs" \
  --evidence "tldraw 2.4.6 binding API changed silently from props.start.boundShapeId"

# A quick decision-note is a typed knowledge entry (ek_type=decision):
synap capture --type decision --claim "Use Typesense for entity search" \
  --why "pgvector deferred to V1; Typesense ships now" --json

# Global lane: a runbook/best-practice that holds across ALL projects → pod-wide knowledge_keys
synap capture --global --type reference --claim "Always fix the canonical path, never a workaround" \
  --key "principle:root-cause" --json

# Retrieve any of it later with the one read verb (it spans every lane):
synap ask "hono routing gotcha" --json
```

`synap capture --type` writes a typed **`knowledge`** entity in the **active workspace** (the Work lane); `ek_type` (gotcha|lesson|decision|reference) discriminates the kind — **one store, type tags, not a residual dump**. It's workspace-scoped, so the active workspace supplies the domain — a Builder gotcha ≠ a marketing one (there is no `engineering_knowledge`). Add **`--global`** to write a pod-wide cross-cutting runbook to `knowledge_keys` instead. A formal **decision RECORD** (rationale, alternatives, superseded-by lifecycle) is a different artifact — use smart `synap capture "<free text>"` or `synap create entity --profile=decision`. Retrieve everything with `synap ask`.
Use `capture` for anything worth remembering across sessions and projects.

**Open (the one display door):**

```bash
synap open <id>                               # resolves type automatically, opens in browser
synap open entity <id>                        # open entity detail
synap open proposal <id>                      # open proposal review
synap open view <id>                          # open a view
synap open cell <typeKey>                     # open a registered cell by typeKey
synap open document <id>                      # open a document
```

The bare-ID form calls `GET /api/hub/resolve/:id` to determine the type before dispatching. Use this when you don't know what type a UUID is — `synap open <id>` always works.

**Write:**

```bash
synap create entity --profile=note --name="Meeting notes" --workspace=<id> --json
synap set entity <id> --props='{"status":"done"}' --json
```

**Multi-agent:** If `SYNAP_AGENT` env var is set, the CLI uses that named identity's API key from `~/.synap/config.json` instead of the default pod credentials. Use `synap agents list` to see configured identities.

**Rules:**

- Always use `--json` when calling from code — clean stdout, no spinners, machine-parseable
- Run `synap orient` first to discover workspace IDs — never hardcode them
- Omit `--workspace` to operate pod-wide; include it to scope to a specific workspace
- `synap ask` is the one read verb — it routes keyword + semantic + procedural automatically; you never choose a search backend.

---
