---
name: agent-os
description: >
  Use this skill when the user wants to set up a complete company operating
  system in Synap — multiple connected workspaces (CRM, Marketing, Builder,
  Project Management, etc.) under one project. Triggers: "set up my company",
  "launch agent OS", "create a workspace for my business", "I need a CRM and
  a content workspace", "build my company OS", "onboard my company", "set up
  marketing + sales + dev workspaces". This skill orchestrates the full
  provisioning: create a PROJECT (the cross-cutting lens), pick the right
  domain workspaces, install each from a template, and link them to the
  project. Ask, don't assume — infer which domains fit, then confirm with the
  user before provisioning.
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

# Agent OS — launch a complete company operating system

You provision a full company OS in Synap: a **project** (the cross-cutting lens
that ties everything together) plus the **domain workspaces** the user needs,
each installed from a ready-made template and linked back to the project.

The CLI equivalent is `synap launch agent-os`. As the AI, you do the same flow
conversationally — **ask, don't assume.**

## The available domain templates

Each is a complete workspace: profiles, views, seed entities, relations,
dashboards, and (where relevant) capabilities + playbooks.

| Template slug        | Workspace          | What it's for                                  |
| -------------------- | ------------------ | ---------------------------------------------- |
| `crm`                | CRM                | Contacts, companies, deals, pipeline           |
| `content-os`         | Content OS         | Posts, campaigns, content calendar, brand      |
| `project-management` | Project Management | OKRs, projects, sprints, tasks                 |
| `agent-os`           | Agent OS           | AI agents, skills, providers — the agent fleet |
| `dev-dashboard`      | Dev Dashboard      | Services, repos, environments, infrastructure  |
| `life-os`            | Life OS            | Notes, books, goals, knowledge management      |

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

For each domain slug, POST the template to the packages endpoint. The templates
live in `synap-backend/templates/packages/<slug>.package.json`:

```bash
curl -s -X POST "$SYNAP_POD_URL/api/hub/packages/apply" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" -H "Content-Type: application/json" \
  --data @synap-backend/templates/packages/crm.package.json
```

Each returns `{ workspace: { workspaceId }, capabilities: [...], playbooks: [...] }`.

### 6. Capabilities — OFFER, never silently install

A template may declare `capabilities` (e.g. CRM → `nango-gmail`). These need
credentials (OAuth/API key), so **ask before connecting**: "CRM can connect to
Gmail for email sync. Connect now or skip?" Skipped capabilities can be added
later via `POST /api/hub/capabilities/apply`.

### 7. Summarize

"Your Agent OS is ready: **CRM, Dev Dashboard, Project Management** — all under
the **<project>** project. Run `synap orient` to see them."

## Principles

- **Ask, don't assume.** Infer domains, but the user confirms the final set.
- **No overwhelm.** Don't install all 6 by default. Suggest 2-4 that fit.
- **Capabilities are opt-in.** Never connect an external tool without asking.
- **Everything links to the project.** The project is the lens that unifies the
  workspaces — an agent scoped to the project sees data across all of them.
- **Idempotent.** `packages/apply` is safe to re-run (keyed by template slug).

## When NOT to use this skill

- The user wants ONE workspace, not a company setup → use `synap-ui` / direct
  workspace creation.
- The user wants to extend an existing workspace's schema → use `synap-schema`.
- The user just wants to capture data → use the core `synap` skill.
