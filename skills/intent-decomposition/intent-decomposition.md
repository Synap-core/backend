# Intent Decomposition Skill

**System Skill** — Auto-seeded on every pod via `ensureSystemSkills()`. Provides the playbook logic for decomposing natural language intent into structured project plans.

---

## Purpose

When a user expresses an intent like "I want to create my own AI server", this skill provides the framework for:

1. **Understanding the intent** — clarifying the bigger picture
2. **Inferring domains** — which workspace templates fit (Shopping, Builder, CRM, etc.)
3. **Proposing structure** — main project + sub-projects + workspaces + entities
4. **Executing via primitives** — using existing Synap tools (no hardcoded backend)

---

## The Playbook: `intent-first-project-creation`

This playbook is discoverable via `synap_match_playbooks` and executable via `synap_run_playbook`.

### Parameters

```yaml
params:
  - name: intent
    type: string
    required: true
    description: "User's natural language intent (e.g., 'I want to create my own AI server')"
  - name: projectId
    type: string
    required: false
    description: "Existing project to reuse (optional)"
  - name: workspaceIds
    type: object
    required: false
    description: "Existing workspaces to reuse keyed by domain (optional)"
```

### Stages

#### Stage 1: `understand_intent`

**Category:** `started`
**Goal:** Clarify what the user wants to build and infer domains

**Suggested Tasks:**

1. Ask clarifying questions about the bigger picture
2. Infer which workspace templates fit (CRM, Builder, Marketing, Shopping, Finance, etc.)
3. Identify if a main project exists or needs creation

**Agent Behavior:**

- Use `synap_ask` to recall existing projects/workspaces
- Present inferred domains as options, not assumptions
- Ask: "Based on 'AI server', I see: Shopping (hardware), Builder (software), CRM (monetization). Want to add/remove any?"

#### Stage 2: `propose_structure`

**Category:** `started`
**Goal:** Present the proposed project + sub-projects + workspaces + entities

**Suggested Tasks:**

1. Present: Main Project (e.g., "AI Server Build") — reuse existing or create new
2. Present: Sub-projects with workspace mapping:
   - "Buy Hardware" → Shopping workspace (create)
   - "Build Software" → Builder workspace (reuse/create)
   - "Monetize" → CRM workspace (create)
3. Show which entities will be created in each workspace
4. Show blocker relationships between sub-projects

**Output Format (for UI):**

```json
{
  "mainProject": {
    "name": "AI Server Build",
    "phase": "planning",
    "intent": "Build personal AI server"
  },
  "subProjects": [
    {
      "name": "Buy Hardware",
      "workspaceHint": "shopping",
      "blockerFor": ["Build Software"],
      "entities": ["GPU (item)", "Supplier (company)", "PurchaseOrder (deal)"]
    },
    {
      "name": "Build Software",
      "workspaceHint": "builder",
      "blockedBy": ["Buy Hardware"],
      "entities": [
        "Repository (project)",
        "ArchitectureDecision (decision)",
        "Task (task)"
      ]
    },
    {
      "name": "Monetize",
      "workspaceHint": "crm",
      "blockedBy": ["Build Software"],
      "entities": ["PricingPlan (item)", "Lead (deal)", "Campaign (campaign)"]
    }
  ],
  "workspacesToCreate": ["shopping"],
  "workspacesToReuse": ["builder", "crm"],
  "capabilitiesToInstall": [
    "synap_create_project",
    "synap_create_workspace",
    "synap_capture"
  ]
}
```

#### Stage 3: `confirm_and_create`

**Category:** `started`
**Goal:** Execute the approved structure via existing primitives

**Suggested Tasks:**

1. If no `projectId`: create main project via `synap_create_project` with `evidenceEntityIds` from plan
2. For each sub-project: provision workspace template via `packages/apply` with `projectId`
3. Create seed entities in each workspace via `synap_capture` plan
4. Install declared capabilities per workspace via `synap_run_capability`

**Execution Primitives (Composed, Not Hardcoded):**

| Need                 | Primitive                   | How                                                                 |
| -------------------- | --------------------------- | ------------------------------------------------------------------- |
| Create project       | `synap_create_project`      | `evidenceEntityIds` from plan entities                              |
| Create workspace     | `market.install` (template) | `projectId` passed → auto-links via `belongs_to_project`            |
| Create entities      | `synap_capture` (plan)      | `projects[]`, `sessions[]`, `entities[]`, `relations[]` in one call |
| Link to project      | `synap_capture` plan        | `projectRef` on sessions/entities                                   |
| Install capabilities | `synap_run_capability`      | Per workspace                                                       |

---

## Intent Classification Guide

### Domain Inference Rules

| Intent Keywords                          | Inferred Domains   | Workspace Templates               |
| ---------------------------------------- | ------------------ | --------------------------------- |
| hardware, parts, buy, purchase, supplier | Procurement        | `shopping`                        |
| code, build, software, dev, repository   | Development        | `builder`, `dev-dashboard`        |
| sell, monetize, price, customer, lead    | Sales/CRM          | `crm`, `marketing-campaign`       |
| content, write, publish, audience        | Content            | `content-studio`, `brand-library` |
| plan, sprint, task, okr                  | Project Management | `project-management`              |
| finance, budget, invoice, revenue        | Finance            | `finance`                         |
| legal, contract, compliance              | Legal              | `legal`                           |
| hire, team, role, policy                 | HR                 | `hr`                              |
| process, vendor, asset, sop              | Operations         | `operations`                      |

### Entity Templates by Domain

| Domain   | Profile Slugs                                         | Example Entities                                         |
| -------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Shopping | `item`, `company` (supplier), `deal` (purchase order) | GPU, NVIDIA, PO-001                                      |
| Builder  | `project`, `decision`, `task`, `document`             | AI-Server-Repo, ArchitectureDecision, Implement-Training |
| CRM      | `deal` (lead), `campaign`, `person` (contact)         | Enterprise-Lead, Launch-Campaign, CTO-Contact            |

---

## Execution Rules (Critical)

### DO

- Use `synap_ask` first to recall existing projects/workspaces
- Present options, let user confirm final set
- Reuse existing project (`projectId` param) when available
- Reuse existing workspaces (`workspaceIds` param) when available
- Create sub-projects as **separate projects** linked via `blockedBySessionIds` + `sub_project_of` relation
- Execute via `synap_capture` plan (atomic, governed, all-or-nothing)

### DON'T

- Auto-install everything without confirmation
- Create company project on team pod (pod IS the company)
- Hardcode domain mappings — infer via LLM reasoning
- Create workspace without `projectId` when a project exists
- Skip capability installation — offer, confirm, then install

---

## MCP Tool Interface

### `synap_intent_first_project`

**Wrapper** that composes existing tools:

1. Calls `synap_match_playbooks({ profileSlug: "project", intentText: <intent> })`
2. If playbook found, calls `synap_run_playbook({ playbookId, params: { intent, projectId, workspaceIds } })`
3. Returns playbook run result

**Input:**

```json
{
  "intent": "I want to create my own AI server",
  "projectId": "optional-existing-project-id",
  "workspaceIds": { "builder": "existing-builder-ws-id" }
}
```

**Output:** Playbook run result with created project/workspace/entity IDs

---

## UI Integration (No New Primitives)

**Uses existing spatial-ui components:**

- `SpatialCard` for project/sub-project cards
- `SpatialButton` for confirm/modify/cancel
- `SpatialAnchoredPopover` for entity previews
- `SpatialBadge` for workspace type indicators
- `synap://open/...` chips for results

**Screen Flow:**

```
User: "I want to create my own AI server"
    ↓
synap_intent_first_project → matches playbook, runs it
    ↓
Playbook asks clarifying questions via chat
    ↓
Playbook presents structure using SpatialCard/SpatialButton
    ↓
User clicks [Confirm] → playbook executes
    ↓
Results surfaced via synap://open/entity/... chips
```

---

## Global Guidelines (Auto-Loaded)

These are captured as global runbooks so ANY AI finds them via `synap_ask`:

```bash
synap capture --global --type reference \
  --claim "When user asks to create something, first understand the intent" \
  --why "Intent drives workspace/project/entity selection" \
  --key "guideline:intent-first"

synap capture --global --type reference \
  --claim "Use agent-os skill flow: orient → infer domains → confirm → provision workspaces" \
  --key "guideline:agent-os-flow"

synap capture --global --type reference \
  --claim "Sub-projects are modeled as separate projects linked via blockedBySessionIds or sub_project_of relation" \
  --key "guideline:sub-project-modeling"
```

---

## Sub-Project Modeling (Using Existing Primitives)

Since projects table has no hierarchy, model sub-projects as **separate projects** linked via:

| Approach          | How                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| **Blocker links** | `blockedBySessionIds` on focus sessions (already in session schema) |
| **Relation**      | `sub_project_of` relation type in `links` table (polymorphic)       |
| **Project path**  | `synap_get_project_path` for tree visualization                     |

The playbook uses `blockedBySessionIds` for execution ordering and `sub_project_of` relations for visualization.

---

## IS-Side Proprietary Additions

**For Intelligence Service agents:**

1. **Agent Prompt Addition** — Pre-loaded context about intent decomposition
2. **Project Creator Persona** — Specialized persona for project creation conversations
3. **Pre-loaded Grants** — Playbook declares grants for `synap_create_project`, `synap_create_workspace`, `synap_capture`, `synap_run_capability`

---

## Verification Checklist

After implementation, verify on fresh pod:

```bash
# 1. Fresh pod init
synap init

# 2. Verify auto-installed
synap mcp call synap_list_capabilities '{"query":"intent first project"}'
synap mcp call synap_load_skill '{"ref":"system/intent-decomposition/intent-decomposition"}'
synap mcp call synap_match_playbooks '{"profileSlug":"project", "intentText":"I want to create my AI server"}'

# 3. Test end-to-end
synap mcp call synap_intent_first_project '{"intent":"I want to create my own AI server"}'

# 4. Verify results
synap ask "show me the AI server build project and its workspaces"
```
