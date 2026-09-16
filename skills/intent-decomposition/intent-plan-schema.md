# Intent Plan Schema

**Schema documentation** for the structured plan produced by intent decomposition.

---

## IntentPlan (Output of Decomposition)

```typescript
interface IntentPlan {
  // The original natural language intent
  intent: string;

  // Main project (created or reused)
  mainProject: {
    name: string;
    description: string;
    phase: string;
    intent: string;
    projectId?: string; // If reusing existing
    evidenceEntityIds: string[]; // For project gravity (≥5)
  };

  // Sub-projects (each becomes a separate project)
  subProjects: SubProjectSpec[];

  // Workspace provisioning plan
  workspacesToCreate: WorkspaceSpec[];
  workspacesToReuse: WorkspaceReuseSpec[];

  // Capability installation plan
  capabilitiesToInstall: CapabilitySpec[];

  // Confidence and assumptions
  confidence: number; // 0-1
  assumptions: string[]; // What we assumed
  clarificationsNeeded: string[]; // Questions for user
}

interface SubProjectSpec {
  name: string;
  description: string;
  workspaceHint: string; // Domain: "shopping" | "builder" | "crm" | etc.
  templateHint?: string; // Specific template: "crm", "builder-workspace", etc.
  blockerFor: string[]; // Sub-project names this blocks
  blockedBy: string[]; // Sub-project names this waits on
  entities: EntitySpec[]; // Entities to create in this sub-project's workspace
  capabilities: string[]; // Capabilities needed
}

interface WorkspaceSpec {
  name: string;
  subtype: string; // "shopping" | "builder" | "crm" | etc.
  templateHint: string; // Template slug from CP catalog
  consumes: string[]; // Workspace edges: what it reads from
  provides: string[]; // Workspace edges: what it provides
  capabilities: string[]; // Capabilities to install
}

interface WorkspaceReuseSpec {
  workspaceId: string;
  domain: string; // "builder" | "crm" | etc.
  reason: string; // Why reuse (already has data, user confirmed, etc.)
}

interface EntitySpec {
  profileSlug: string; // "item" | "deal" | "task" | "project" | etc.
  title: string;
  properties?: Record<string, unknown>;
  workspaceHint: string; // Which workspace this belongs to
  projectHint: string; // Which sub-project this belongs to
  facets?: FacetSpec[]; // Roles to attach
}

interface FacetSpec {
  slug: string; // "client" | "partner" | "investor" | etc.
  contextEntityId?: string; // Context for the role
}

interface CapabilitySpec {
  templateKey: string; // Capability slug from CP
  workspaceHint: string; // Which workspace to install in
  params?: Record<string, unknown>;
}

interface WorkspaceEdgeSpec {
  domain: string;
  role: "provider" | "consumer" | "provider-consumer";
  targetWorkspaceId?: string;
}
```

---

## Example: "I want to create my own AI server"

### Input

```json
{
  "intent": "I want to create my own AI server"
}
```

### Output IntentPlan

```json
{
  "intent": "I want to create my own AI server",
  "mainProject": {
    "name": "AI Server Build",
    "description": "Personal AI server: hardware procurement → software build → monetization",
    "phase": "planning",
    "intent": "Build personal AI server",
    "evidenceEntityIds": []
  },
  "subProjects": [
    {
      "name": "Buy Hardware",
      "description": "Procure GPUs, chassis, power, cooling",
      "workspaceHint": "shopping",
      "templateHint": "shopping",
      "blockerFor": ["Build Software"],
      "blockedBy": [],
      "entities": [
        {
          "profileSlug": "item",
          "title": "GPU",
          "properties": { "model": "RTX 4090", "quantity": 4 },
          "workspaceHint": "shopping",
          "projectHint": "Buy Hardware"
        },
        {
          "profileSlug": "company",
          "title": "NVIDIA",
          "properties": { "type": "supplier" },
          "workspaceHint": "shopping",
          "projectHint": "Buy Hardware",
          "facets": [{ "slug": "partner" }]
        },
        {
          "profileSlug": "deal",
          "title": "GPU Purchase Order",
          "properties": { "dealStage": "lead", "estimatedValue": 8000 },
          "workspaceHint": "shopping",
          "projectHint": "Buy Hardware"
        }
      ],
      "capabilities": ["synap_create_entity", "synap_capture"]
    },
    {
      "name": "Build Software",
      "description": "OS, drivers, containers, orchestration, models",
      "workspaceHint": "builder",
      "templateHint": "builder-workspace",
      "blockerFor": ["Monetize"],
      "blockedBy": ["Buy Hardware"],
      "entities": [
        {
          "profileSlug": "project",
          "title": "AI Server Software",
          "properties": { "repo": "github.com/user/ai-server" },
          "workspaceHint": "builder",
          "projectHint": "Build Software"
        },
        {
          "profileSlug": "decision",
          "title": "Container Orchestration",
          "properties": {
            "decisionStatus": "exploring",
            "options": ["k8s", "docker-swarm", "nomad"]
          },
          "workspaceHint": "builder",
          "projectHint": "Build Software"
        },
        {
          "profileSlug": "task",
          "title": "Set up GPU drivers",
          "properties": { "status": "todo", "priority": "high" },
          "workspaceHint": "builder",
          "projectHint": "Build Software"
        }
      ],
      "capabilities": [
        "synap_create_project",
        "synap_create_entity",
        "synap_run_capability"
      ]
    },
    {
      "name": "Monetize",
      "description": "Offer API access, hosted models, fine-tuning",
      "workspaceHint": "crm",
      "templateHint": "crm",
      "blockerFor": [],
      "blockedBy": ["Build Software"],
      "entities": [
        {
          "profileSlug": "item",
          "title": "API Access Tier",
          "properties": { "price": 99, "unit": "month" },
          "workspaceHint": "crm",
          "projectHint": "Monetize"
        },
        {
          "profileSlug": "deal",
          "title": "Enterprise Lead",
          "properties": { "dealStage": "lead", "estimatedValue": 5000 },
          "workspaceHint": "crm",
          "projectHint": "Monetize"
        },
        {
          "profileSlug": "campaign",
          "title": "Launch Campaign",
          "properties": { "channels": ["twitter", "linkedin", "dev-to"] },
          "workspaceHint": "crm",
          "projectHint": "Monetize"
        }
      ],
      "capabilities": ["synap_create_deal", "synap_run_capability"]
    }
  ],
  "workspacesToCreate": [
    {
      "name": "Shopping",
      "subtype": "shopping",
      "templateHint": "shopping",
      "consumes": [],
      "provides": ["procurement"],
      "capabilities": ["synap_create_entity"]
    }
  ],
  "workspacesToReuse": [
    {
      "workspaceId": "<existing-builder-id>",
      "domain": "builder",
      "reason": "Already provisioned with dev tools"
    },
    {
      "workspaceId": "<existing-crm-id>",
      "domain": "crm",
      "reason": "Already has pipeline and contacts"
    }
  ],
  "capabilitiesToInstall": [
    { "templateKey": "shopping-procurement", "workspaceHint": "shopping" },
    { "templateKey": "builder-devtools", "workspaceHint": "builder" },
    { "templateKey": "crm-pipeline", "workspaceHint": "crm" }
  ],
  "confidence": 0.85,
  "assumptions": [
    "User wants to buy hardware (not rent cloud)",
    "User has or will create Builder and CRM workspaces",
    "Monetization is via API access tiers"
  ],
  "clarificationsNeeded": [
    "Cloud vs on-premise hardware?",
    "Which GPU models preferred?",
    "Existing Builder/CRM workspaces to reuse?"
  ]
}
```

---

## Schema Validation Rules

| Rule                                                        | Enforcement                               |
| ----------------------------------------------------------- | ----------------------------------------- |
| `mainProject.evidenceEntityIds` length ≥ 5 for new projects | `assessEvidenceGravity` in project create |
| `subProjects[].blockerFor` / `blockedBy` form valid DAG     | Checked at playbook execution             |
| `workspaceHint` must match known template slugs             | Validated against CP catalog              |
| `profileSlug` must exist in pod                             | Validated via `list_profiles`             |
| `capabilities[].templateKey` must exist                     | Validated via `list_capabilities`         |

---

## Playbook Execution Mapping

| IntentPlan Field           | Execution Primitive                                                   |
| -------------------------- | --------------------------------------------------------------------- |
| `mainProject`              | `synap_create_project` (if no `projectId`)                            |
| `subProjects[]`            | Each → `synap_create_project` + `blockedBySessionIds`                 |
| `workspacesToCreate[]`     | `market.install(kind:"template", slug:templateHint, projectId)`       |
| `workspacesToReuse[]`      | Pass `workspaceIds` to subsequent steps                               |
| `subProjects[].entities[]` | `synap_capture` with `plan` (projects, sessions, entities, relations) |
| `capabilitiesToInstall[]`  | `synap_run_capability` per workspace                                  |

---

## Confidence Scoring

| Factor                             | Weight |
| ---------------------------------- | ------ |
| Domain keywords matched            | 0.3    |
| Template availability confirmed    | 0.2    |
| Existing workspaces to reuse       | 0.2    |
| Entity profile existence confirmed | 0.15   |
| Capability availability confirmed  | 0.15   |

**Thresholds:**

- `confidence ≥ 0.8` → Present with "Recommended" badge
- `0.6 ≤ confidence < 0.8` → Present with "Review assumptions" note
- `confidence < 0.6` → Ask more clarifying questions first
