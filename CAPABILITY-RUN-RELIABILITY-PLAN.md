# Capability-run + MCP reliability — plan (research synthesis)

**Status:** PLAN — needs founder decisions. Written 2026-07-27, after the external-agent closing report + a live test (approved exa run vanished). Two read-only dossiers (`research-caprun` opus, `research-noapproval`) + one investigation (`fix-userstated`), every claim `file:line`-verified. Nothing here is built yet.

---

## Workstream 1 — the capability-run observability contract ("le dernier maillon")

**Root cause (verified):** MCP `run_capability` → `executeCapability` builds a `proposalType:"capability.run"` proposal (execute-capability.ts:179-199). On approval, `applyProposalApproval` → dispatch → the `capability.run` executor (approve-executors.ts:3194-3316) **DID execute** the skill (`runResolvedSkill`, result in `proposals.data.runResult`). But it persists **nothing observable**:

- ❌ `correlationId` never stamped (the `.set()` at :3295-3304 writes status/data/reviewedBy only) → stays null.
- ❌ no run-ledger row → the run feed's `FlowType` union (runs/types.ts:18) has **no "capability"**, so `listRuns` can't see it.
- ❌ no recall deposit → `ask` finds nothing.
- ❌ `diagnose(capabilityId)` probes only the `capabilities` table (resolve-object-kind.ts:101-116) → "no diagnosable object."

So the exa result is real but unreachable by every surface. Confirms prior memory: "executeCapability writes NO run ledger."

**Fix (additive, no migration, reuse the capture-run pattern):**

1. Stamp a `correlationId` on the proposal (generate at creation or in the executor before the `.set()`) — column already exists, diagnose already reads it.
2. Add `"capability"` to `FlowType` + a `listCapabilityRuns` synthesiser mirroring `listCaptureRuns` (runs/index.ts:336-405, reads `proposalType="capability.run"` proposals), wire into `listRuns` + `getRun` (whose capture branch already joins `events` on `correlationId`). Emit correlationId-keyed events from the execute so `diagnose runId` shows a timeline.
3. Deposit the result into recall via the **same door captures use** (not a bespoke insert) so `ask` finds it + it matches capture shape.
4. (Optional) `resolveObjectKind` also probes `skills`/`tools` so `diagnose(capabilityId)` explains the capability.

**Blast radius:** all additive writes happen AFTER the existing single `dispatchExternalOnce`-guarded run → no re-invocation, no double-execute. Reuse `listCaptureRuns` + capture's correlationId-events (proven, no table).

**⚠️ Separate, possibly-worse latent bug (Shape B):** the OTHER executor `capability/run` (:3591, `proposalType:"run"`, from external-dispatch/skills.ts) handles tool-provider actions but for `capabilityKind:"skill"|"command"` **flips status to done with NO execution** (:3667, "wired by Wave 3b"). So an approved **`skills.run` skill** proposal via that door **never runs**. Different door than the exa path (which executed), but it means "approve → nothing happens" for that surface. Do NOT merge the two executors (risks double-execute / changes the tool-provider path).

---

## Workstream 2 — direct-write dedup (the "No approval received" damage)

**Root cause (verified):** the string "No approval received" is **not in any of our repos** — it's claude.ai's own client UI flattening our already-typed responses. The CP→pod work lands durably; the client's own confirmation window gives up first (a latency race — cold vs warm, matches the transience) → the model retries → dupe. We cannot patch Anthropic's client message.

**What we own:** our content-hash dedup (`insertPendingProposal`, Wave-A) covers **agent-authored proposal** writes, but **auto-approved/direct writes with no identity signal** (a plain note/task create) bypass it → dupe on retry.

**Fix:** extend the proven content-hash dedup pattern to the direct/auto-approved write paths, **server-derived** (no client `idempotencyKey` needed), same short window. Closes the actual damage (dupes) regardless of why the client retried. Touches a new dedup helper (mirroring `insertPendingProposal`'s hash) + the direct-create call sites. No CP/client changes.

**Not ours:** disambiguating the message itself (refused / not-presented / executed) is client-side — flag as a known Anthropic-client UX gap, raise with them if it keeps costing time.

---

## Workstream 3 — userStated / uo_validated governance

**Finding (`fix-userstated`, no in-file defect):** `remember_fact` with `userStated:true` → `uo_validated:true` → rung 2.6 returns `execute` **when `agentUserId` is set** (the pod `/mcp` door guarantees it). So the design is correct. The reported "userStated still proposes" must come from a **different door**:

- Most likely the **CP-relay `pod__remember_fact` tool doesn't forward the `userStated` param** → can't reach `uo_validated:true` → everything proposes. (CP repo fix: expose/forward the param.)
- Or a `forceProposeWrites` session (playbook/CRM-hygiene) — correct behavior, just needs the doc to say so.
- **Inverse gap:** the legacy-AI/no-`agentUserId` path (permission-check.ts ~850-880) never consults `uo_validated` → an AI-_inferred_ observation could auto-execute there (pre-existing, low-frequency under-governance).

**Fix candidates:** confirm the door first (cheap), then (a) forward `userStated` on the CP-relay tool if that's the gap; (b) optionally close the inverse gap.

---

## Decisions (see the questions put to the founder)

- **D1** Capability-run contract scope: observable+diagnosable only, or +recall deposit (full end-to-end), or +resolveObjectKind?
- **D2** The Shape-B "approved skill run never executes" bug: fix in this wave or separate follow-up?
- **D3** userStated: confirm the CP-relay door + forward the param, and whether to also close the legacy-AI inverse gap.
- Workstream 2 (direct-write dedup) is a recommended ship (proven pattern); confirm scope.
