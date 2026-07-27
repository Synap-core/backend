# Workspace placement + agent workspace-focus — plan (research synthesis)

**Status:** PLAN — needs founder decisions. Written 2026-07-27, after an agent's `import.graph` (SCF leads) landed pod-wide (`workspaceId: null`) instead of the CRM workspace. Two read-only dossiers (`research-ws-routing`, `research-agent-ws-scope` opus), every claim `file:line`-verified. Nothing built yet. (The immediate `/open` 403 is separately fixed — pod-admin bypass in `assertProposalVisibleTo`.)

---

## The problem, in one line

Agent-generated domain content (leads) has no workspace — so the CRM-workspace members who'd work it can't see it. Two root failures, one felt symptom.

## Two composable layers (they _complete_ each other)

### Layer 1 — canonical routing (the surgical fix) — `research-ws-routing`

A placement door already exists: **`resolveWorkspacePlacement`** (`database/src/services/workspace-resolution-service.ts:309`) — a 6-rung ladder: **explicit → ontology → context → relational → AI-tiebreak → default** — already wired into 5 write paths. **`import.graph`/`capture.graph` never call it**: both producers (`import-orchestrator.ts`, `submitCaptureGraph`) pass `workspaceId` straight through, and it's `null` because a hub write with no lens deliberately "lands pod-personal" (`_shared.ts:303-309`). The leads carried a `profileSlug` (the exact ontology signal) that was never looked at.

**Fix (mirror the existing pattern at `capture.ts:1195-1253`):** collect the graph's profile slugs → one `resolveWorkspacePlacement` call → land on the ontology workspace (tie-break/abstain only if ambiguous). Then thread the resolved workspace into `materializeCompositeGraph` as the per-op `targetWorkspaceId`/`resolvedWorkspaceId` (that persisted-placement pattern already exists at `entities.ts:1250-1266`) so entities materialize where the proposal implied. Scope: the two broken producers **only** — NOT the deliberately rung-1/6-restricted single-entity create.

**Open question this resolves-or-hands-off:** does `lead`/`person`/`company` have a _deterministic_ ontology signal on this pod? If `lead` is a `scope:'workspace'` CRM profile → rung 2 decides alone. If the entities are generic `person`/`company` at `scope:'system'` (pod-wide) → **no ontology signal → routing alone can't decide → falls to null anyway.** That's exactly where Layer 2 supplies the deterministic signal.

### Layer 2 — agent workspace-focus on identity — `research-agent-ws-scope`

**Today:** agent identity has NO workspace focus. Agent reads remap `ctx.userId` to the human and ride the human's **UNION floor** (pod-personal ∪ every member workspace); the workspace lens is **client-supplied** (dropped if unverified — `adapter.ts:663-669`), so no-lens = the human's whole pod. Not a scope, a leaky filter — same as the client-isolation debt.

**Design — `focusWorkspaceId[]` on the AGENT-USER identity (SSOT), two consumers:**

- **(a) Write-routing default (advisory):** the focus REPLACES the "first accessible workspace" fallback and is the TOP-priority placement signal: `explicit arg > agent-focus > ontology-resolved > membership fallback`. Threads through the _existing_ seam (`key.workspaceId → keyWorkspaceId → resolveConfinedWorkspace → write door`). Composes with Layer 1.
- **(b) Read-visibility scope (enforced):** the focus becomes a MANDATORY floor-narrowing the agent can't drop (identity-bound, not a header) — reusing the `exposureRelationTypes` floor-narrowing precedent (`context.ts:83-85,175-186`) via a `withAgentScope()`. Multi-workspace is free (`Lens = string[]`). The globals carve-out is free (`nullWorkspaceMeans: podGlobalConfig` keeps substrate/skills/runbooks visible; `ownerPrivate` excludes pod-personal entities) — so "CRM agent sees CRM + shared substrate, not the human's personal pod."

**SSOT placement:** on the agent-user identity (the pod-wide singleton), NOT the key (keys rotate). Provisioning stamps `api_keys.workspaceId` from it → the existing `keyWorkspaceId` thread carries it for free.

**Client-isolation connection:** an _enforced_ agent scope is the FIRST hard, non-client-supplied narrowing in the system — the exact fix-shape the `X-Project-Id`/UNION-floor debt needs. The agent surface is the natural place to prove the pattern before generalizing to human project-isolation.

---

## Options for Layer 2 (`research-agent-ws-scope`)

- **Option 1 — advisory only** (write-default; reads stay leaky). Tiny blast radius, no isolation.
- **Option 2 — enforced only** (hard read+write scope). Real isolation; larger blast radius; breaks pod-wide identity dedup unless a carve-out; back-compat needs existing agents UNBOUND.
- **Option 3 (RECOMMENDED) — `focusWorkspaceId[]` feeding both, with a per-agent MODE dial** (`advisory` = default/back-compat vs `enforced` = hard scope). One SSOT, both facets, soft-vs-hard is a per-agent setting. Ships advisory first, enforced later.

**Smallest correct first step (advisory, ~no read-path risk):** add `focusWorkspaceId` to the agent identity → `provisionSurfaceAgentKey` stamps the key → generalize `resolveConfinedWorkspace` to advisory-pin `hub_inbound` keys (default placement to the binding; no 403 on mismatch). One pure function + provisioning.

**Enforced read-scope = follow-on wave:** `withAgentScope()` on AccessContext + the **identity-dedup carve-out decision** — a hard-scoped agent still needs pod-wide reads to dedup a person/company across the pod (`IdentityResolutionService` strong-signal match). Either (a) a pod-wide "match-existence-only" resolve door, or (b) accept dedup-within-focus. Genuine product decision.

---

## Decisions — RATIFIED (founder, 2026-07-27)

- **D1 = Layer 1 + advisory Layer 2.** Routing fix + agent write-default focus. Enforced read-isolation is the NEXT wave.
- **D2 = Option 3.** `focusWorkspaceId[]` on the agent identity + a per-agent advisory/enforced mode dial.
- **D3 = pod-wide match-existence door** (for the enforced wave, deferred).
- **PS (founder) — RUNTIME STICKY FOCUS:** the agent must be able to be TOLD "use CRM until I say otherwise," resolve the workspace, and pin all its calls to it until cleared. Confirmed NOT present today. Design: the focus lives in `users.agentMetadata.focusWorkspaceId` (JSONB — no migration), read LIVE at request time, so it's settable at provisioning AND at runtime by a new set/clear-focus MCP tool. Clearing = unset the field.

## Implementation (this wave)

- **Priority ladder:** `ctx.workspaceId` (explicit-per-call OR the agent's live focus) > ontology-resolved > membership fallback. The focus flows via `ctx.workspaceId` — so the existing `input.workspaceId ?? ctx.workspaceId ?? null` lines pick it up for free; the only change is: when that's null, run the ontology resolver instead of persisting null.
- **W1 (routing):** `import-orchestrator.ts` + `submit-capture-graph.ts` — when the resolved workspaceId is null, call `resolveWorkspacePlacement` (collect graph profile slugs, mirror `capture.ts:1195-1253`); thread the resolved workspace into `materializeCompositeGraph`'s per-op `targetWorkspaceId`/`resolvedWorkspaceId`.
- **W2 (focus + tool):** `agentMetadata.focusWorkspaceId` read live at agent-request ctx resolution (set `ctx.workspaceId` = focus when no explicit lens, advisory — no 403); a new set/clear-focus MCP tool that resolves a workspace name→id and writes `agentMetadata`. Enforced read-scope deferred.
