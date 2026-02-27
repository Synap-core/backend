# Synap Backend — Security, Permissions & Validation

> **Status:** Current as of Feb 2026. All identified security gaps closed as of 2026-02-27.

---

## Overview: Three Distinct Layers

```
Request
  │
  ▼
Layer 1 — Authentication & Procedure Type   (trpc.ts + context.ts)
           "Who is this? Do they have a session?"
  │
  ▼
Layer 2 — Role-Based Access Control (RBAC)  (permissions.ts)
           "Is this user a member of the workspace? What role?"
  │
  ▼
Layer 3 — AI Governance                     (permission-check.ts)
           "Is this action from an AI agent? Does it need a proposal?"
  │
  ▼
DB Write  OR  Proposal created (pending human approval)
```

These layers are **additive**. A human user request only passes through layers 1 and 2. An AI agent request passes through all three.

---

## Layer 1 — Authentication & Procedure Type

### How identity is established

**Human users (browser):**

```
Browser → HTTP request
  cookie: ory_kratos_session=...
  X-Workspace-Id: <uuid>
  ↓
context.ts createContext()
  → validates Kratos session
  → userId = session.identity.id
  → workspaceId = X-Workspace-Id header
```

**AI agents / machine-to-machine (Intelligence Hub):**

```
Intelligence Hub → HTTP request
  Authorization: Bearer <api-key>
  ↓
api-key-auth.ts middleware (scopedProcedure)
  → validates API key in DB
  → loads scopes (e.g. ["hub-protocol.write"])
  → userId = API key owner OR resolved from thread
```

### Procedure types (trpc.ts)

| Procedure                                 | Requires                       | Context guaranteed                                   |
| ----------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `publicProcedure`                         | Nothing                        | `authenticated = false` possible                     |
| `protectedProcedure`                      | Valid Kratos session           | `ctx.userId: string`                                 |
| `workspaceProcedure`                      | Session + workspace membership | `ctx.userId`, `ctx.workspaceId`, `ctx.workspaceRole` |
| `scopedProcedure(["hub-protocol.write"])` | API key with matching scope    | `ctx.userId`, `ctx.scopes`                           |

**`workspaceProcedure`** is the most important for human users. It:

1. Extends `protectedProcedure` (session check first)
2. Reads `X-Workspace-Id` header → fails if absent
3. Checks `workspace_members` table for membership → fails if not a member
4. Adds `ctx.workspaceRole` (the user's role string) to context

This means any router using `workspaceProcedure` **already enforces workspace membership** before the handler runs. The handler doesn't need to re-check "is this user in the workspace."

---

## Layer 2 — Role-Based Access Control (RBAC)

**File:** `packages/database/src/utils/permissions.ts`

### Role permission matrix

| Role     | read | write | delete | manage | invite |
| -------- | :--: | :---: | :----: | :----: | :----: |
| `owner`  |  ✅  |  ✅   |   ✅   |   ✅   |   ✅   |
| `admin`  |  ✅  |  ✅   |   ❌   |   ✅   |   ✅   |
| `editor` |  ✅  |  ✅   |   ❌   |   ❌   |   ❌   |
| `viewer` |  ✅  |  ❌   |   ❌   |   ❌   |   ❌   |

- `owner` is the only role that can **delete** resources
- `admin` can manage workspace settings but cannot delete resources
- `editor` is the standard collaborative role — can create and update
- `viewer` is read-only

### How permission mapping works

When a router calls `checkPermissionOrPropose()`, it maps the action string to a permission level:

```typescript
action = "delete"                    → requiredPermission = "delete"
action = "create" | "update" | ...   → requiredPermission = "write"
action = anything else               → requiredPermission = "read"
```

### Three-level check inside `verifyPermission()`

```
1. Workspace membership check (ALWAYS required)
   └─ Is userId in workspace_members?
   └─ If not: denied

2. Project-first logic (when resource belongs to project)
   └─ Is userId in project_members for this project?
      └─ Yes: use project role (overrides workspace role)
      └─ No but workspace owner: owner can access all projects
      └─ No: denied

3. Workspace-only fallback (no project context)
   └─ Does workspace role satisfy required permission?
```

---

## Layer 3 — AI Governance

**File:** `packages/api/src/utils/permission-check.ts`

This layer sits **on top** of RBAC. It is NOT a global middleware — it must be explicitly called by each router mutation that handles AI-sourced writes.

### `checkPermissionOrPropose(opts)` return values

```typescript
{ granted: true }                    // Write immediately
{ granted: false, proposalId: str }  // Proposal created, return early — NO write
{ denied: true, reason: str }        // RBAC failed — throw FORBIDDEN
```

### When AI governance applies

The AI governance branch activates **only** when BOTH:

- `opts.source === "ai"` or `"intelligence"`
- `opts.agentUserId` is provided (an agent user ID)

Without both, it's a human user — Layer 2 RBAC is the only check.

### Agent user governance flow (P0-5: inverted logic, current)

```typescript
// 1. RBAC first — agent must have write permission in workspace
verifyPermission({ userId: agentUserId, workspace: { id: workspaceId }, requiredPermission })
  → if denied: return { denied: true }

// 2. Load workspace AI governance settings
const autoApproveFor = settings?.aiGovernance?.autoApproveFor ?? DEFAULT_AUTO_APPROVE;
// Default: ["search.*", "memory.recall", "entity.read", "document.read"]

// 3. Check if this action is whitelisted
const eventKey = `${subjectType}.${action}`;  // e.g. "entity.create"
const isAutoApproved = autoApproveFor.some(pattern =>
  pattern.endsWith(".*")
    ? eventKey.startsWith(pattern.slice(0, -2))  // glob match
    : eventKey === pattern                         // exact match
);

// 4. Decision
if (isAutoApproved) return { granted: true };    // Whitelist hit — write now
return createProposal(...)                        // DEFAULT: create pending proposal
```

**The key design principle: default is PROPOSAL, whitelist is TRUST.**

The default `autoApproveFor` allows read-only operations without proposals:

- `search.*` — all search operations
- `memory.recall` — knowledge retrieval
- `entity.read` — reading entities
- `document.read` — reading documents

Everything else (entity.create, entity.update, document.create, etc.) creates a proposal by default.

### Non-agent AI source (legacy path)

When `source === "ai"` but no `agentUserId` (old integration style):

- Falls back to `aiGovernance.autoApprove` boolean toggle
- Default: `false` → creates proposal
- This is the legacy path; the agent user system is preferred

---

## How a router uses all three layers

### Pattern (entities.create as canonical example)

```typescript
// entities.ts
create: workspaceProcedure          // Layer 1+2: session + workspace membership
  .input(z.object({
    source: z.enum(["user", "ai", "intelligence", "system"]).optional(),
    agentUserId: z.string().uuid().optional(),
    // ...
  }))
  .mutation(async ({ input, ctx }) => {
    // 1. Emit .requested audit event
    auditLog({ action: "create", phase: "requested", ... });

    // 2. Layer 3: AI governance (also re-checks RBAC with effective user)
    const perm = await checkPermissionOrPropose({
      userId: ctx.userId,
      agentUserId: input.agentUserId,     // agent's ID (or undefined for humans)
      workspaceId: ctx.workspaceId,
      subjectType: "entity",
      action: "create",
      source: input.source,               // "user" | "intelligence" | ...
      reasoning: input.reasoning,
      data: { ... },
    });

    // 3. Handle governance result
    if ("denied" in perm) throw new TRPCError({ code: "FORBIDDEN" });
    if ("proposalId" in perm) {
      // AI action → pending proposal → return early, NO DB write
      return { status: "proposed", proposalId: perm.proposalId };
    }

    // 4. Materialize — auto-approved (human or whitelisted AI action)
    await db.insert(entities).values({ ... });

    // 5. Emit .completed audit event + side effects
    auditLog({ action: "create", phase: "completed", ... });
    emitSideEffects({ ... });
  })
```

### Routers that follow this pattern correctly

| Router                               | `checkPermissionOrPropose` | Passes `agentUserId` + `source`  |
| ------------------------------------ | -------------------------- | -------------------------------- |
| `entities.ts` create, update, delete | ✅                         | ✅                               |
| `workspaces.ts` create, update       | ✅                         | ✅                               |
| `views.ts` create, update            | ✅                         | ✅                               |
| `profiles.ts` create                 | ✅                         | ✅                               |
| `skills.ts` create                   | ✅                         | ✅                               |
| `relations.ts` create                | ✅                         | ✅                               |
| `projects.ts` create                 | ✅                         | ✅ (source only, no agentUserId) |
| `api-keys.ts` create/delete          | ✅                         | Partial                          |

---

## Hub Protocol — How AI agents call the backend

**File:** `packages/api/src/routers/hub-protocol/`

The Intelligence Hub is a **separate Hono service** (different port). It cannot call tRPC directly. Instead, it calls Hub Protocol REST endpoints authenticated with an API key.

### Hub Protocol authentication

```
Intelligence Hub → POST /trpc/hub-protocol.entities.createEntity
  Authorization: Bearer <hub-protocol-api-key>
  ↓
scopedProcedure(["hub-protocol.write"])
  → validates API key
  → ctx.userId = API key owner
  → ctx.scopes = ["hub-protocol.write", ...]
```

### The delegation pattern (correct path)

Most Hub Protocol mutations **delegate to regular routers** via `createCaller()`. This means the regular router's permission check runs, including all three layers.

```typescript
// hub-protocol/entities.ts
createEntity: scopedProcedure(["hub-protocol.write"]).mutation(
  async ({ input, ctx }) => {
    // Build a caller context that looks like a regular user request
    const callerContext = await createHubProtocolCallerContext(
      ctx.userId, // agent user ID
      ctx.scopes,
      ctx.workspaceId // workspace from thread context
    );

    // Call regular entities router — ALL THREE LAYERS run
    const caller = regularEntitiesRouter.createCaller(callerContext);
    return caller.create({
      ...input,
      source: "intelligence", // triggers AI governance in Layer 3
      agentUserId: ctx.userId, // agent's user ID for RBAC + governance
    });
  }
);
```

`createHubProtocolCallerContext()` injects `userId`, `workspaceId`, `scopes`, and sets `authenticated: true` so `workspaceProcedure` and `protectedProcedure` are satisfied.

### Hub Protocol coverage table

| Route                              | Delegation                             | Layers 1+2+3 | Notes                                                                     |
| ---------------------------------- | -------------------------------------- | :----------: | ------------------------------------------------------------------------- |
| `entities.createEntity`            | Via `regularEntitiesRouter`            |    ✅ All    | Correct                                                                   |
| `entities.updateEntity`            | Via `regularEntitiesRouter`            |    ✅ All    | Correct                                                                   |
| `entities.getEntities`             | Via `regularEntitiesRouter`            |    ✅ All    | Read, no write                                                            |
| `branches.createBranch`            | Via `channelsRouter`                   | ✅ Layer 1+2 | channelsRouter doesn't call checkPermissionOrPropose                      |
| `branches.mergeBranch`             | Via `channelsRouter`                   | ✅ Layer 1+2 | Same                                                                      |
| `skills.createSkill`               | Via `regularSkillsRouter`              |    ✅ All    | Correct                                                                   |
| `backgroundTasks.*`                | Via `regularBgTasksRouter`             |    ✅ All    | Correct                                                                   |
| `documents.getDocument`            | Via `regularDocumentsRouter`           | ✅ Layer 1+2 | Read only                                                                 |
| `documents.createDocument`         | Governance check + direct DB           |    ✅ All    | Fixed: checkPermissionOrPropose, content in proposal JSONB until approved |
| `documents.createDocumentProposal` | **Direct DB**                          |   ❌ None    | Creates proposal (intentional — IS the governed action)                   |
| `branches.createBranch`            | Governance check + delegate            |    ✅ All    | Fixed: always proposal; executes via channelsRouter on approval           |
| `branches.mergeBranch`             | Governance check + delegate            |    ✅ All    | Fixed: always proposal; user must validate every merge                    |
| `linking.linkEntity`               | `checkPermissionOrPropose` + direct DB |    ✅ All    | Auto-approved via "context.\*" whitelist; workspace membership verified   |
| `linking.linkDocument`             | `checkPermissionOrPropose` + direct DB |    ✅ All    | Auto-approved via "context.\*" whitelist; workspace membership verified   |
| `context.updateThreadContext`      | **Direct DB**                          |   ❌ None    | Thread metadata only — low risk                                           |
| `proposals.updateProposal`         | **Direct DB**                          | Layer 1 only | Human RBAC gap — low risk                                                 |

---

## Proposal approval flow

When a proposal is created (AI action was not whitelisted), a human must approve it.

**File:** `packages/api/src/routers/proposals.ts`

```
Human → proposals.approve(proposalId)
  ↓
protectedProcedure (Kratos session)
  ↓
Ownership check using aiGovernance.proposalApprovalPolicy:
  "owner_and_admins" (default) → isOwner OR isAdmin
  "any_editor"                 → isEditor (includes admin)
  "admins_only"                → isAdmin only
  ↓
Execute materialization:
  document proposals → apply proposedContent to MinIO storage + DB
  entity proposals   → re-emit as *.validated event → worker materializes
```

---

## Human user vs AI agent: full comparison

### Human writing an entity

```
Browser request
  Kratos cookie → ctx.userId = "human-uuid"
  X-Workspace-Id → ctx.workspaceId = "ws-uuid"
  ↓
workspaceProcedure
  → validates membership
  → ctx.workspaceRole = "editor"
  ↓
entities.create handler
  input.agentUserId = undefined
  input.source = "user"
  ↓
checkPermissionOrPropose
  effectiveUserId = ctx.userId (no agentUserId)
  → verifyPermission(human, workspace) → allowed (editor can write)
  → source ≠ "ai" → skip AI governance
  → return { granted: true }
  ↓
db.insert(entities) ← immediate write
```

### AI agent writing an entity

```
Intelligence Hub request
  API key → ctx.userId = "agent-user-uuid"
  ctx.workspaceId = resolved from thread
  ↓
scopedProcedure(["hub-protocol.write"])
  → validates API key scope
  ↓
hub-protocol/entities.ts createEntity
  createHubProtocolCallerContext(agentUserId, scopes, workspaceId)
  → regularEntitiesRouter.createCaller(ctx)
     input.agentUserId = agentUserId
     input.source = "intelligence"
  ↓
workspaceProcedure
  → validates AGENT's workspace membership (agent is in workspace_members)
  ↓
checkPermissionOrPropose
  effectiveUserId = agentUserId
  → verifyPermission(agentUser, workspace) → allowed (agent has editor role)
  → source === "intelligence" + agentUserId → AI governance applies
  → eventKey = "entity.create"
  → autoApproveFor default = ["search.*", "memory.recall", "entity.read", "document.read"]
  → "entity.create" NOT in whitelist
  → return { granted: false, proposalId: "..." }
  ↓
entities.create returns early: { status: "proposed", proposalId }
NO db.insert — pending human approval
```

---

## Known gaps

### Gap 1: `hub-protocol/documents.ts createDocument` — no governance

**Severity:** Medium
**What happens:** AI can create a document without going through the proposal system. No RBAC check, no AI governance. Also contains a bug: `workspaceId` is set to `input.userId` (wrong).

**Fix:** Add `checkPermissionOrPropose()` directly in the hub-protocol route before the DB write. Also fix the workspaceId bug.

### Gap 2: `documents.ts` regular router — no `checkPermissionOrPropose`

**Severity:** Low for now
**What happens:** Human document creation goes through `workspaceProcedure` (membership check) but no per-operation governance layer. The regular router also doesn't accept `agentUserId` / `source` fields, so there's no path for AI-governed document creation via delegation.

**Implication:** Even if hub-protocol/documents.ts delegated to the regular router (like entities does), the regular router wouldn't apply AI governance. The fix for Gap 1 must be at the hub-protocol level until the regular documents router also adopts the pattern.

### Gap 3: `branches.createBranch` / `mergeBranch` — no AI governance

**Severity:** Low
**What happens:** Channels router doesn't call `checkPermissionOrPropose`. Branches can be created/merged by AI without a proposal.

### Gap 4: `linking.*` — direct DB, no checks

**Severity:** Low
**What happens:** Linking entities/documents to channels is metadata-only (writes to `channel_context_items`). No content changes. The risk is low but technically unaudited.

---

## AI governance settings (per workspace)

Stored in `workspaces.settings.aiGovernance` (JSONB, no migration needed):

```typescript
aiGovernance?: {
  // NEW (P0-5): Whitelist of event keys that bypass proposal requirement
  // Format: "subjectType.action" or "subjectType.*"
  // Default when absent: ["search.*", "memory.recall", "entity.read", "document.read"]
  autoApproveFor?: string[];

  // Who can approve AI proposals (default: "owner_and_admins")
  proposalApprovalPolicy?: "owner_and_admins" | "any_editor" | "admins_only";

  maxAgentsPerUser?: number;
  allowAgentCreation?: boolean;

  // Deprecated fields (kept for migration reference)
  requireReviewFor?: string[];   // Opposite semantics — was a blacklist
  autoApprove?: boolean;         // Legacy toggle
}
```

---

## Agent user system

**File:** `packages/database/src/schema/users.ts`, `packages/api/src/routers/agent-users.ts`

AI agents are **first-class users** in the `users` table:

```typescript
{
  id: "agent-uuid",
  userType: "agent",                               // not "human"
  email: "agent-default-abc123@synap.agent",       // synthetic email
  kratosIdentityId: null,                          // no Kratos identity
  agentMetadata: {
    agentType: "default",                          // meta | default | code | ...
    createdByUserId: "human-uuid",                 // linked to a specific human
    serviceId: "default",                          // which intelligence service
    description: "...",
  }
}
```

Agents are added to workspaces as members (in `workspace_members` table) with a role (typically `editor`). This means `verifyPermission()` can check their role just like any human user.

The `createdByUserId` link enables per-human AI attribution — each user's AI agent is distinct and traceable.

---

## Audit trail

**File:** `packages/api/src/utils/audit-log.ts`

All significant operations emit events to the `events` table:

- `.requested` phase: emitted before the permission check
- `.completed` phase: emitted after successful DB write
- `correlationId` links the two events together

The `events` table is append-only (no updates/deletes). Fields:

- `source`: `"api"` (default), `"ai"` (when AI agent — **currently not set, gap P0-6**)
- `userId`: who triggered it (human or agent user ID)
- `correlationId`: links .requested → .validated → .completed chain

---

## Proposal types and their materialization

| `targetType` | `proposalType`      | On approve                                             | Content storage                                   |
| ------------ | ------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `document`   | `ai_edit`           | Apply `proposedContent` to MinIO + version bump        | Inline in `data.proposedContent`                  |
| `document`   | `create`            | Upload `data.content` to MinIO + insert DB row         | Inline in `data.content` (JSONB)                  |
| `document`   | `user_suggestion`   | Same as `ai_edit`                                      | Inline                                            |
| `entity`     | `create` / `update` | Re-emit `.validated` event → materializer worker       | In `data` fields                                  |
| `channel`    | `create_branch`     | Call `channelsRouter.createThread()` with approver ctx | `data.parentThreadId`, `data.branchPurpose`, etc. |
| `channel`    | `merge_branch`      | Call `channelsRouter.mergeBranch()` with approver ctx  | `data.branchId`, `data.summary`                   |

**Document creation content strategy:** Rather than writing to MinIO at proposal time (which would require cleanup on rejection), the raw content is stored in the proposal's `data.content` JSONB field. MinIO upload happens only when the user approves. This keeps storage clean and makes rejection free.

---

## Quick reference: which procedure type for what

| Use case                                  | Procedure to use                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Public endpoint (health, public data)     | `publicProcedure`                                                                |
| User-authenticated, no workspace scope    | `protectedProcedure`                                                             |
| User write to workspace data              | `workspaceProcedure` + `checkPermissionOrPropose`                                |
| Machine-to-machine (hub, CLI)             | `scopedProcedure(["hub-protocol.write"])`                                        |
| Hub Protocol delegating to regular router | delegate via `createCaller(hubCtx)` with `agentUserId` + `source:"intelligence"` |
