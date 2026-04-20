# Synap Skills

Three skills make up the Synap agent surface. Install all three for the full experience; they are designed to be used together.

## The three skills

| Skill          | Purpose                                                    | Trigger                                                           |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `synap`        | Core data operations — read, write, link, search, remember | "Save this", "Find my X", "Who is Y", "Remind me to Z"            |
| `synap-schema` | Extend the data model — new profiles, new properties       | "I need a type for X", "Add a field to tasks"                     |
| `synap-ui`     | Build views, dashboards, workspaces, bento layouts         | "Make me a dashboard", "Build a kanban", "Create a CRM workspace" |

Each skill has its own SKILL.md with a trigger-first description. The harness loads only the skills whose descriptions match the user's intent — so a data-fetch turn doesn't load the UI skill, and vice versa.

## File layout

```
skills/
├── synap/                    ← core data operations
│   ├── SKILL.md
│   ├── linking.md            ← auto-sync + explicit relations reference
│   ├── governance.md         ← proposal semantics + whitelist
│   ├── capture.md            ← multi-entity capture pipeline
│   └── scripts/
│       └── orient.sh         ← deterministic startup: users/me + workspaces + profiles
│
├── synap-schema/             ← extend the data model
│   ├── SKILL.md
│   └── property-types.md     ← valueType reference + constraints + uiHints + scope
│
├── synap-ui/                 ← build interface over data
│   ├── SKILL.md
│   ├── view-types.md         ← the 12 implemented view types + configs
│   ├── widget-catalog.md     ← cells/widgets reference
│   └── bento-recipes.md      ← ready-to-adapt dashboard layouts
│
└── README.md                 ← this file
```

## How progressive disclosure works

Per Anthropic's Agent Skills spec, each skill has three loading levels:

1. **Metadata (always loaded, ~100 tokens/skill).** The frontmatter `name` + `description`. Determines whether the harness surfaces this skill to the model at all.
2. **SKILL.md body (loaded when skill triggers, ≤5k tokens).** The authoritative instructions. Kept concise and action-oriented.
3. **References + scripts (loaded on demand).** Deeper docs the model reads only when the current task calls for them. Scripts run via bash — their source never enters context.

So the total always-on cost of all three Synap skills is ≈300 tokens. The full content (≈15k tokens across all files) only enters context when genuinely needed.

## Authentication (shared by all three)

All skills talk to a Synap Data Pod over HTTP:

```
Authorization: Bearer {SYNAP_HUB_API_KEY}
X-Workspace-Id:  {SYNAP_WORKSPACE_ID}      (optional; can pass in body/query)

Required scopes:
  hub-protocol.read   → GET endpoints
  hub-protocol.write  → writes + GET /channels/personal (get-or-create)
```

Provision a key via `npx @synap-core/cli connect --target=<client>` or directly at `POST /api/hub/setup/agent`.

## Supported clients

Each skill is portable and works unchanged in:

- **OpenClaw** — drop into the standard skill directory, env vars pick up the pod URL and key
- **Claude Code** — install to `~/.claude/skills/synap/` (strip `metadata.openclaw` block if desired)
- **Claude Desktop** — does NOT read local skill folders. Skills in Claude Desktop sync from claude.ai — upload the three skill directories there (Settings → Skills → Upload). Claude Desktop CAN still use the pod via an MCP bridge — see `synap-cli/src/lib/targets.ts` `installClaudeDesktop` for the stdio-bridge config.
- **Raycast** — the Raycast extension is a separate package with its own tool bindings; it reads these skills as context

The OpenClaw-specific metadata block is namespaced under `metadata.openclaw` so consumers that don't recognize it will ignore it cleanly.

## When to install which

- **Read-only memory agent** (just wants to recall facts) → `synap`
- **General-purpose assistant** (reads + writes + captures) → `synap`
- **Data model architect** (user asked to design a new schema) → `synap` + `synap-schema`
- **Interface builder** (user wants dashboards and views) → `synap` + `synap-ui`
- **Full co-founder agent** → all three

Installing a skill the user doesn't need costs ~100 tokens of always-on metadata. Installing all three by default is fine; being selective is an optimization.

## Reference

- Anthropic's Agent Skills overview: https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills/overview
- Best practices: https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills/best-practices
- Open spec: https://agentskills.io
- Synap Hub Protocol reference: see `synap-backend/packages/api/src/routers/hub-protocol-rest.ts`
