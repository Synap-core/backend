# Governance Phase 2 — from scattered to converged (research synthesis)

**Status:** PLAN — needs founder decisions. Written 2026-07-27, after the 0→D governance system shipped + deployed (`2511c96b`). Three read-only research dossiers (capability-gov, gov-ux, dedup), every claim `file:line`-verified, plus a live-pod dogfood pass. Nothing here is built yet.

---

## The three workstreams

### 1. Capability governance — the phase-3 axis (research-capability-gov)

**Current state:** Two governance axes are disjoint by construction. Data writes → `decideAgentPolicy` rung 2.8 (`governance_rules`). Capability runs → `gateCapabilityExecution` (`packages/capability-gate/src/index.ts:168`) which composes approval-state + `vault_grants` existence + `exec_mode` (auto/propose/dry-run), and only THEN calls `decideAgentPolicy` at rung 2.7. The gate **never** consults `resolveGovernanceRule`, and `scoreRuleTarget` no-ops `target_kind:"capability"` — so a stored capability rule is **read by nothing** (the hidden UI granularity).

**Key correction:** "just thread `capabilityId` into the engine" **does not work** — rung 2.7 always returns before 2.8 on the capability path, and the two verdicts a capability rule most needs to override (no-grant → propose; dry-run) **never reach the engine at all** (they return inside the gate). The consultation must live **inside the gate**.

**Recommended — Option B (no migration):** keep `vault_grants` for what it uniquely does (grant _existence_, consumable `max_uses`, `dry-run`, secret decrypt). Inside `gateCapabilityExecution`, at each point it would return `propose`, first resolve a capability rule for `(agentUserId, workspaceId, capabilityId)`; a `verdict:"auto"` rule **widens propose→run**. Never overrides the `approved===false` deny floor; never mints secret access (rule branch scoped to tool/skill/command, not `secret`).

- _Rejected A_ (retire vault_grants into governance_rules): high-risk, forces the store to swallow consumable/existence/secret semantics — a strictly worse store.
- **Smallest first step:** `capabilityId` param + capability branch in `resolveGovernanceRule`; consult it at the gate's two propose-return points; a gate tripwire (unapproved + auto rule → still deny). Data-write path byte-identical.

### 2. Governance UX convergence (research-gov-ux)

**The sharpest gap in the whole system:** `governanceRules.list` and `.revoke` have **zero consumers anywhere**. Every "always approve" toast promises _"Revocable in Governance rules"_ (`AlwaysApproveMenu.tsx:171`, `GovernanceMenu.tsx:175`) — **that surface does not exist.** The only way to undo a rule today is raw SQL. A write door with an advertised undo that 404s.

**Two more gaps:**

- **Widen-lane proposals have no home** — they render as "Untitled"/"Change governance" (no `targetName`; falls through `useProposalPresentation`'s kind chain to a generic "create"), and the `evidence` scorecard (the one thing a reviewer needs) shows as an unlabeled "3 fields." Needs a `governance_widen` presentation kind (precedented — mirrors `MergePreview`/`FacetPreview`).
- **The old JSONB forms are shadow-writers** — `governance-tab.tsx` (pod-admin) + `AiGovernanceSection`→`GovernancePanel` (browser) still READ `settings.aiGovernance.autoApproveFor` (JSONB), so rules created via proposal-approval are **invisible** in Settings even though live/enforced. Their writes mirror into rules via `syncAutoApproveRules` (REPLACE scoped to `sourceProposalId IS NULL` — preserves proposal-authored rules). Note: only `autoApproveFor` is a rules candidate; `writesRequireProposal`/`proposalApprovalPolicy`/etc. have NO rules equivalent and stay JSONB. Provenance is a clean binary: `sourceProposalId NULL` = settings-authored, non-NULL = proposal-authored.

**Recommended sequence:**

1. **Ship the "Governance rules" list+revoke panel** — API 100% ready, zero backend work, closes the broken promise. Highest leverage. (browser Settings + pod-admin.)
2. **Add the `governance_widen` presentation kind** — a `WidenLanePreview` showing agent + evidence scorecard + pattern + scope.
3. **Defer JSONB-form retirement** — genuine open design decision (read-merge vs cross-link), decide AFTER users can see the drift via #1.

### 3. Duplicate-proposal leak (research-dedup + live dogfood)

**Two mechanisms that disagree by construction:** preventive `dedup_hash` + partial unique index `WHERE status='pending' AND agent_user_id IS NOT NULL` (0208, deployed — confirmed live), and detective `computeProposalFingerprint` clustering (looser: `proposalType×targetType×name`, what `diagnose` surfaces).

**Live-row classification of the 6 clusters:**

- **`import.graph / entity` ×5** — `agentUserId` NULL → `dedup_hash` NULL → **bypasses dedup entirely** (the "humans/non-attributed aren't deduped" design). REAL gap.
- **`knowledge_facts` idempotency (the [DOGFOOD TEST] dup)** — CONFIRMED bug: `rememberFact` has a race-prone read-then-write guard with **no unique constraint** (`remember-fact.ts:180-214`) — the exact anti-pattern 0208 fixed for proposals but `knowledge_facts` never got.
- **`create / playbook` clusters** (the automation-named ones) — agent-attributed, **distinct hashes** → genuinely different payloads (a volatile field varies per attempt, or truly different) grouped only by the loose fingerprint → **diagnostic FALSE POSITIVE**, not a governance bug.

**Recommended:**

1. **Fix the `knowledge_facts` race** — unique index on `(user_id, fact)` (non-expired) + catch-23505 + return-prior, mirroring `insertPendingProposal`. Small, isolated, proven-broken.
2. **Reframe the `diagnose` "duplicate" signal** — it's a review-_grouping_ tool ("N proposals want to set industry"), not a literal duplicate detector; the health section reads as a governance-bug alarm when it's working as designed. Naming/doc pass.
3. **Decide the non-attributed gap** (import.graph ×5): widen attribution vs drop the index's agent-only condition vs accept — touches the deliberate "humans aren't deduped" tradeoff.

---

## Cross-cutting: reuse, secondary effects, no redundancy

- **Reuse:** the `governanceRules` CRUD API is 100% ready for the panel (zero backend). The `useProposalPresentation` discriminated union is the exact seam for widen-lane. The granularity→input mapping already exists in both menus (reference, not directly importable across the repo boundary — acceptable duplicate).
- **Secondary effects to respect:** (a) `syncAutoApproveRules`' REPLACE-scoped-to-`sourceProposalId IS NULL` is the ONLY thing preventing a settings save from clobbering proposal-authored rules — any redesign must preserve it. (b) A capability rule must stay BELOW the approval-deny floor and never touch secret decrypt. (c) The lane scanner's `hasCoveringRule` only checks `action` targets — if capability rules go live, it must also check capability rows or it'll propose already-covered widens. (d) Widening dedup to humans reverses a conscious product decision — not a quiet fix.
- **The cap display nit** (from fix-cap): the scorecard's `approveRate` is over the recent 500; the cap is over lifetime — they can visibly disagree (this misled us). Either compute the cap on the recent window (trust = earnable-back) or label the display "recent 500."

---

## Decisions — RATIFIED (founder, 2026-07-27)

- **D1 = Option B + authorize no-grant runs.** Gate consults `governance_rules`; a `verdict:"auto"` capability rule widens propose→run AND can authorize a run with NO grant — for `tool`/`skill`/`command` only, NEVER `secret`, NEVER past the `approved===false` deny floor or dry-run. No migration.
- **D2 = Ship the rules panel; pod-admin FIRST; make it a SHAREABLE package so the browser gets it too.** Defer JSONB-form retirement. Also add the widen-lane presentation card.
- **D3 = Widen attribution.** Widen the `createProposal` AI-source agent backfill so more agent writes resolve an `agentUserId` → dedup engages. Genuine human writes stay exempt (do NOT drop the index's agent-only condition).
- **D4 = Fix both.** Compute the trusted-agent cap on the recent window (matches the displayed scorecard rate; trust = earnable-back) AND reframe the `diagnose` "duplicate" signal as review-grouping.
- Plus (D3): fix the confirmed `knowledge_facts` race (unique index + catch-23505).
