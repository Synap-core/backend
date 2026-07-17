---
name: agent-os
description: >
  Use this skill when the user wants to set up a complete company operating
  system in Synap — multiple connected workspaces (CRM, Marketing, Builder,
  Project Management, etc.) under one project. Triggers: "set up my company",
  "launch agent OS", "create a workspace for my business", "I need a CRM and
  a content workspace", "build my company OS", "onboard my company", "set up
  marketing + sales + dev workspaces". ALSO use it to add a SINGLE domain to an
  existing project — "add a Marketing workspace to my project", "this project
  needs a Finance domain", or when you've noticed a project is missing an
  operational domain it clearly needs and offered to set it up. This skill
  orchestrates provisioning: create or reuse a PROJECT (the lens that ties the
  work together), pick the right domain workspace(s), install each from a
  template, link them to the project, and onboard. Ask, don't assume — infer
  which domains fit, then confirm with the user before provisioning.
metadata:
  openclaw:
    requires:
      env: [SYNAP_HUB_API_KEY, SYNAP_POD_URL]
    primaryEnv: SYNAP_HUB_API_KEY
    homepage: https://synap.live
    capabilities: [provisioning, workspaces, projects]
    os: [macos, linux, windows]
    userInvocable: true
---

# Company OS — launch a complete company operating system

You provision a full company OS in Synap: a **project** (the cross-cutting lens
that ties everything together) plus the **domain workspaces** the user needs,
each installed from a ready-made template and linked back to the project.

The CLI equivalent is `synap launch` (bare — it runs the guided one-per-company
setup and takes no template argument; `synap launch --list` shows what is
launchable). As the AI, you do the same flow conversationally — **ask, don't
assume.**

## The available domain templates

Each is a complete workspace: profiles, views, seed entities, relations,
dashboards, and (where relevant) capabilities + playbooks.

| Template slug        | Workspace          | What it's for                                  |
| -------------------- | ------------------ | ---------------------------------------------- |
| `foundation`         | Foundation         | Strategic DNA — mission, audience, positioning |
| `ecosystem`          | Ecosystem          | Market actors, segments, trends, relationships |
| `brand-library`      | Brand Library      | Brand voice, assets, tokens, components, rules |
| `crm`                | CRM                | Contacts, companies, deals, pipeline           |
| `content-studio`     | Content Studio     | Posts, pillars, calendar + video/production    |
| `marketing-campaign` | Marketing          | Campaigns, leads, channels                     |
| `project-management` | Project Management | OKRs, projects, sprints, tasks                 |
| `builder-workspace`  | Builder            | DevPlane + agents — building the product       |
| `dev-dashboard`      | Dev Dashboard      | Services, repos, environments, infrastructure  |
| `agent-fleet`        | Agent Fleet        | AI agents, skills, providers — the agent fleet |
| `finance`            | Finance            | Revenue, expenses, runway, invoices            |
| `legal`              | Legal              | Contracts, entities, compliance, IP            |
| `hr`                 | People (HR)        | People, roles, hiring, policies                |
| `operations`         | Operations         | Processes, vendors, assets, SOPs               |
| `life-os`            | Second Brain       | Notes, books, goals, knowledge management      |
| `personal`           | Personal           | Personal knowledge + life management           |

Foundation/Radar/Brand are the **strategic base** other workspaces inherit from
(via the `strategy`/`brand` provider roles) — suggest them first for a new company.

## The flow

### 1. Get the project name

Ask: "What's your company or project called?" → this becomes the **project**.

### 2. Understand the business, infer domains

Ask: "Describe what you do in a sentence." From the answer, **infer** which
workspaces fit. Examples:

- "dev agency with clients" → Builder (dev-dashboard) + CRM + Project Management
- "content creator" → Content OS + CRM
- "SaaS startup" → Dev Dashboard + CRM + Project Management + Content OS

### 3. Propose + confirm (NEVER auto-install everything)

Say: "Based on that, I suggest: **CRM, Dev Dashboard, Project Management**.
Want to add Marketing/Content? Remove any?" Wait for the user to confirm the
set. This is the core principle — **the user decides the final set.**

### 4. Create the project

```bash
curl -s -X POST "$SYNAP_POD_URL/api/hub/projects" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"<project name>","description":"<their description>","status":"active"}'
```

Capture the returned `id` — that's the `projectId`.

### 5. Provision each chosen workspace

For each domain slug, POST the template's `PackageDefinition` to the packages
endpoint, **injecting the `projectId` from Step 4** so the workspace's seed
entities link to the project (`belongs_to_project`). Without `projectId`, the
workspaces are created but orphaned from the project — breaking the lens.

Templates are sourced from the canonical **`@synap-core/workspace-templates`**
package (the single source of truth shared by the CLI, the control-plane
registry, and the browser) — **not** from repo files. The simplest path is the
CLI, which does this whole flow end-to-end:

```bash
synap launch          # asks project + domains, applies each template, links to the project
synap launch --list   # what's launchable (local templates, no pod needed)
```

There is no `agent-os` template slug and `synap launch` takes no positional
template argument — the command is guided. Pass `--json` for machine-readable
output.

Conversationally (or programmatically), obtain each template's PackageDefinition
from the package (`toPackageDefinition(slug)`) or the registry (`GET
/api/packages`), inject `projectId`, and POST:

```bash
curl -s -X POST "$SYNAP_POD_URL/api/hub/packages/apply" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" -H "Content-Type: application/json" \
  --data "{ ...<packageDefinition>, \"projectId\": \"$PROJECT_ID\" }"
```

Each returns `{ workspace: { workspaceId }, projectLink: {...}, capabilities:
[...], playbooks: [...] }`.

### 6. Capabilities — OFFER, never silently install

A template may declare `capabilities` (e.g. CRM → `nango-gmail`). These need
credentials (OAuth/API key), so **ask before connecting**: "CRM can connect to
Gmail for email sync. Connect now or skip?" Skipped capabilities can be added
later via `POST /api/hub/capabilities/apply`.

### 7. Hand off to per-workspace onboarding (Tier 2)

The templates create the _structure_ (profiles, views, dashboards) — but the
workspaces start empty. Now populate them with real data by running the shared
**`onboard`** skill once per workspace, in sensible order (foundational domain
first — e.g. Brand/Content before Marketing campaigns, so later workspaces can
reference earlier data).

For each newly created workspace:

1. Switch scope to it (`synap use <workspaceId>` or pass workspaceId).
2. Run the `onboard` skill — it reads that workspace's `settings.onboarding`
   (declared by its template) and runs an adaptive interview to collect the
   right structured data.
3. Finish that workspace, tell the user what's captured, then move to the next.

Don't dump all interviews at once. One workspace, complete it, then the next.
The user can also defer: "set up CRM now, the rest later" is fine.

**Autonomous fan-out (orchestrator).** When you're the orchestrator configuring
several workspaces at once (not an interactive one-at-a-time session), don't run
the interviews serially yourself — **fan out one scoped sub-agent per workspace**
and consolidate. Activate the `connect` tools (`discover_tools(["connect"])`),
then for each workspace call `dispatch_agent({ workspaceId: "<that ws id>",
agentType: "onboarding", mode: "parallel", task: "Onboard this workspace from its
settings.onboarding" })` — each sub-agent runs scoped to that workspace (loads
only its tools + skills, cheap), returns `{ workspaceId, childThreadId }`. Track
those, then `consolidate_branches([childThreadIds])` into ONE summary for the
user. Order the strategic base first (Foundation/Brand before dependents). A
single workspace: just onboard it inline, no fan-out. (See the connect-group
skill for the exact sequence.)

### 8. Summarize

"Your Company OS is ready: **CRM, Dev Dashboard, Project Management** — all under
the **<project>** project. I've onboarded CRM (pipeline + 4 accounts). Want to
onboard the others now, or later?"

## Adding ONE domain to an existing project (the common in-conversation case)

You don't only run this for whole-company setup. The frequent case: you're
working inside a project and notice it's **missing an operational domain it
needs** (see the "notice a missing domain" reflex in the core `synap` skill) —
you're talking sales but there's no CRM, or content but no Content OS. Offer it
in one line; if the user says yes, run a **trimmed version of the flow** for that
single domain:

1. **Reuse the project** — it already exists; you have its `projectId` from your
   lens (`synap lens`) or `synap_orient` (its `projects` section). Skip Steps 1–4.
2. **Check the spine first.** If the domain you're adding consumes the strategic
   base — CRM, Marketing, Content, most business domains inherit `strategy`
   (Foundation) and `brand` (Brand Library) via `sourceRoles` — and the project
   has **no Foundation/Brand yet**, say so and offer the spine first: "Marketing
   works best once your Foundation (mission, audience) exists — set that up first,
   or go straight to Marketing?" Let the user choose; don't silently skip it.
3. **Provision the one workspace** (Step 5) with that `projectId` so it links.
4. **Onboard just it** (Step 7) — one focused interview, then summarize.

Don't turn a single-domain add into a full company pitch. They asked for one
lens; give them that one, linked and onboarded.

## Principles

- **Ask, don't assume.** Infer domains, but the user confirms the final set.
- **No overwhelm.** Don't install all 6 by default. Suggest 2-4 that fit.
- **Capabilities are opt-in.** Never connect an external tool without asking.
- **Everything links to the project.** The project is the lens that unifies the
  workspaces — an agent scoped to the project sees data across all of them.
- **Idempotent.** `packages/apply` is safe to re-run (keyed by template slug).

## When NOT to use this skill

- The user wants to extend an existing workspace's schema (add a profile/field
  to a workspace that already exists) → use `synap-schema`.
- The user just wants to capture data → use the core `synap` skill.
