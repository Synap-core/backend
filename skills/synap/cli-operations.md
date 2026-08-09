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

**Recording a decision as its own graph entity:**

```bash
synap create entity --profile=decision --name="Use Typesense for entity search" \
  --props='{"summary":"Use Typesense for entity search","decisionStatus":"accepted"}' --json
# Retrieve later with the one read verb: synap ask "Typesense decision"
```

> `synap note` is the HUMAN's raw "dump now, structure later" inbox. As the AI, always `capture` into a lane — structuring is your job.

**Structured knowledge (durable, typed, searchable — preferred for engineering learnings):**

```bash
# Work lane: one explicit Knowledge form. Keep the Markdown body on the
# linked document; these properties remain compact/queryable metadata.
synap create entity --profile=knowledge --name="Hono static route ordering" \
  --workspace=<id> \
  --props='{"knowledgeForm":"caution","ek_claim":"Static routes must come before /:id","ek_tags":["repo:synap-backend","layer:routing"]}' \
  --content=$'## Why\\n\\nStatic routes must come before `/:id`.' --json

synap create entity --profile=knowledge --name="Verify library APIs at runtime" \
  --workspace=<id> \
  --props='{"knowledgeForm":"insight","ek_claim":"Code-read is not runtime-true for library APIs"}' \
  --content=$'Validate the installed version before depending on an API.' --json

# A Decision is its own lifecycle entity; link it to the supporting Knowledge.
synap create entity --profile=decision --name="Use Typesense for entity search" \
  --props='{"summary":"pgvector deferred to V1; Typesense ships now","decisionStatus":"accepted"}' --json

# A Reference is source material, not a Knowledge form. Create/use a source
# entity or document and link it as evidence; global runbooks remain knowledge_keys.
synap capture --global "Always fix the canonical path, never a workaround" \
  --key "principle:root-cause" --json

# Retrieve any of it later with the one read verb (it spans every lane):
synap ask "hono routing caution" --json
```

`knowledge` has exactly one canonical `knowledgeForm`: `insight` or `caution`. It is workspace-scoped, so the active workspace supplies the domain. The optional `ek_claim` is a short summary; readable long form belongs in the entity's linked Markdown document. A formal **Decision** has its own rationale/lifecycle entity, and a **Reference** is source material linked as evidence — neither is a Knowledge form. The legacy `synap capture --type gotcha|lesson|decision|reference` command is still accepted for compatibility, but new automation must use the canonical entity properties above. Retrieve everything with `synap ask`.
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
