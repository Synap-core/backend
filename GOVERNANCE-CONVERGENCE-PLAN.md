# Governance Convergence Plan — one engine, one store, attributed & self-widening

**Status:** DECISIONS RATIFIED 2026-07-27 — ready to build. Written 2026-07-27.
**Research:** two read-only deep-dives, every claim `file:line`-verified against `synap-backend/` HEAD
(`gov-attribution`, `gov-rules-lane-cap`). Nothing below is built yet.

**Update 2026-08-13:** a real convergence round shipped against this plan — see
**§6 "SHIPPED 2026-08 (this convergence round)"** at the bottom for what's actually landed
(uncommitted; needs redeploy). It **supersedes D1 / Phase 0's per-transport hard-reject** with a
correct identity signal (`users.userType==='agent'`, not `linkedUserId`/`keyType`), and adds two new
rungs to `decideAgentPolicy` — **2.55 provenance** and **2.56 ceilings** (first slice) — that follow
the same rung-2.8 pattern this doc already established (I/O caller resolves a pre-computed
tighten-only verdict, the pure engine consumes it, floors stay supreme). Read §6 before treating
anything below as the current state of the system.

### Ratified decisions (founder, 2026-07-27)

- **D1 = Hard-reject.** A `linkedUserId==null` key writing over `/mcp` → loud 403 ("not an agent key — run `synap init`"). Human PATs on Hub REST stay anonymous.
  **⚠️ SUPERSEDED 2026-08-13 — see §6.** The per-transport reject used `linkedUserId==null` as the
  "is this an agent" signal; the correct signal is the key principal's `users.userType==='agent'`.
  Gating on `linkedUserId` alone would hard-reject legitimate **pod-wide agents** (no `linkedUserId`
  by design), which this round explicitly set out to support as governed machine principals. Fixed at
  identity resolution, not at the `/mcp` transport boundary — see §6 item #1.
- **D2 = Keep `DEFAULT_AUTO_APPROVE` as code floor.** Consulted when no rule matches; not seeded into the table.
- **D3 = Wire automation profile-granularity NOW.** Thread `subjectProfileSlug` through the automation door (`automation-governance.ts:154`) this wave — full parity with the chat door.
- **D4 = Full 0→D in scope.** Attribution → store → collapse → retire → trusted lane + per-agent cap. Build in sequenced, committed, gate-green waves (files overlap across phases — NOT parallel).

---

## 0. Where we are (verified, corrected from the brief)

**ONE engine, ONE call site — already true.**

- Pure decision engine `decideAgentPolicy` — `packages/governance-policy/src/index.ts:711`. A 9-rung
  ladder: `1 CBAC → 2 ADMIN → 2.1 forcePropose → 2.5 DESTRUCTIVE floor → 2.6 user_observation-by-kind
→ 2.7 per-capability → 3 owned-ws → 4 explicit autoApproveFor → 5 writesRequireProposal → 6
agent-owned+destructive → 7 per-channel → 8 DEFAULT_AUTO_APPROVE → 9 default-propose`.
- Single call site `resolveAgentGovernanceDecision` — `packages/database/src/utils/resolve-agent-governance-decision.ts:133`,
  reached from exactly two live doors (chat `permission-check.ts:765`, automation
  `packages/jobs/src/utils/automation-governance.ts:154`) + one dry-run preview.

**The real problems (three, compounding):**

1. **Attribution gap → ungoverned writes.** `agentUserId` is set iff the authenticating key carries a
   non-null `linkedUserId` (`http-handler.ts:406-407`, Hub REST `hub-protocol-rest.ts:403-407`). When
   it's null, the write does **not** just skip the trusted lane — the _entire_ agent-governance ladder
   sits inside `if (agentUserId)` (`permission-check.ts:740`), so a null write falls to the **human**
   path and, for `DEFAULT_AUTO_APPROVE` verbs, **executes directly as the operator, no proposal**.
   `setup.ts:618-650` documents this verbatim as a "SILENT GOVERNANCE BYPASS." Anonymous-agentic isn't
   unattributed — it's **ungoverned**.

2. **Three de-facto stores** (the founder's concern, confirmed): (a) `workspaces.settings.aiGovernance.autoApproveFor: string[]`
   JSONB, (b) `users.agentMetadata.autoApproveFor: string[]` JSONB (per-agent), (c) `vault_grants`
   (capability exec-mode). Plus code constants. Governance state is scattered; no single revocable,
   audited, specificity-ranked home.

3. **Flat, shared, blind cap.** `countTodayAgentProposals` (`permission-check.ts:1166`) is per-**human**
   (10/user/day shared across all their agents) AND excludes null-`agentUserId` rows — so a good agent
   and a flooding agent share one budget, and anonymous writes are uncapped + invisible to analytics.

**Correction to the brief:** `GOVERNANCE_MODES` ("safe/normal/crazy" presets,
`governance-policy/src/index.ts:148`) is **dead code** — zero consumers repo-wide. It's a phantom store,
delete-eligible.

**Not a bug — correct as-is:** Anonymous is _right_ for genuinely human-direct / service surfaces —
`/setup/service` (auth-as-human by design), personal PATs a human curls with, connector/system service
creds syncing Gmail/Calendar. The fix is **not** "attribute everything."

---

## 1. Where we're going

**ONE engine (unchanged) · ONE store (`governance_rules`) · every AGENTIC write attributed · a lane that
widens itself on proof · a cap that scales with trust.** All feeding the single `decideAgentPolicy`, no
concurrent decision paths.

---

## 2. The plan, phased (each phase ships green + committed)

### Phase 0 — Attribution (PREREQUISITE; everything keys on `proposals.agentUserId`)

**⚠️ SUPERSEDED 2026-08-13 — see §6 item #1 for what actually shipped.** The per-transport
hard-reject below was never built as written; instead the round fixed the underlying identity
signal (`resolveKeyIdentity`, one door across all 3 transports) so `shouldRejectUnattributedWrite`
now keys on `isAgent` (from `users.userType`) OR `linkedUserId`, not `linkedUserId` alone — which
correctly admits pod-wide agents instead of hard-rejecting them.

The bug is a **misuse at the boundary**: a bare user PAT handed to an AI as `SYNAP_HUB_API_KEY`. The
minting surfaces are fine — `/setup/agent` (#7), mcp-redeem claude-web (#8), pod-OAuth (#9),
`createNamedAgent` (#10) all already set `linkedUserId`. The CLI already routes through `/setup/agent`.

**Fix (2 lines, the same two attribution sites):** when a `user_pat`/`hub_inbound` key with
`linkedUserId == null` drives a **write** over the **`/mcp` endpoint**, refuse it with a loud,
self-service error ("this key is not an agent key — run `synap init`"). A human doesn't speak MCP, so a
write arriving there on a bare key is by definition an un-provisioned agent. Human PATs curling Hub REST
stay anonymous (correct). → forces agentic writes through proper provisioning; **no migration of
existing agent keys** (they already attribute).

**Blast radius:** only the two write-attribution sites. Breaks exactly the case we _want_ to break, once,
loudly, self-service.

### Phase A — `governance_rules` store, additive (rung 2.8)

New table `governance_rules` (schema `packages/database/src/schema/governance-rules.ts`, migration
`0214_governance_rules.sql` hand-written + baseline + schema-coherence):

```
principal_kind  ('agent'|'any')      agent_user_id  (fk, when agent)
scope_kind      ('workspace'|'pod')  workspace_id   (when workspace)
target_kind     ('action'|'profile'|'capability')   target_pattern text   target_profile (nullable)
verdict         ('auto'|'propose')   -- NEVER 'deny' (deny stays CBAC/floors)
source_proposal_id  created_by  created_at  revoked_at  expires_at
```

Resolver `resolveGovernanceRule(...)` with **specificity ranking** (agent>any, workspace>pod, exact
action>profile>glob>`*`; ORDER BY score DESC, created_at DESC LIMIT 1). Active predicate mirrors
`findRedeemableGrant`. Glob matching reuses existing `matchesActionPattern` — don't re-implement.

**Engine wiring — NEW rung 2.8**, placed **after 2.7, before 3** — i.e. _above_ every autoApproveFor
path (rungs 4 & 8) but _below all four floors_ (2 ADMIN, 2.1 forcePropose, 2.5 DESTRUCTIVE, 2.6 by-kind):

```ts
// 2.8 GOVERNANCE_RULES — additive; fires ONLY when a rule matched.
if (input.governanceRuleVerdict) {
  return input.governanceRuleVerdict === "auto"
    ? { verdict: "execute" }
    : { verdict: "propose", reason: PROPOSE_REASON.GOVERNANCE_RULE };
}
```

Engine stays pure — the resolver runs in `resolveAgentGovernanceDecision` (has `db`) and passes the
resolved `"auto"|"propose"|undefined` in. **When no rule matches → undefined → rung falls through
byte-identical.** Zero behavior change for pods with no rules.

**SAFETY PROOF (a rule can NEVER auto-approve a delete/admin/scope-change):** rungs 2, 2.1, 2.5, 2.6 all
`return` _before_ 2.8. The worst a rule can do is turn a would-be-proposal into auto-execute for a
non-destructive, non-admin, non-scope-changing verb — exactly the autoApproveFor blast radius, but
revocable + audited + ranked. → add a `policy.test.ts` tripwire asserting floors-before-rules ordering.

### Phase B — backfill + read-shim (collapse to ONE store)

One-shot job seeds `governance_rules` from every existing `workspaces...autoApproveFor` (scope=workspace,
principal=any) and `users.agentMetadata.autoApproveFor` (principal=agent). Then flip
`resolveAgentGovernanceDecision` to compute autoApproveFor **from `governance_rules`** and stop reading the
JSONB in the engine. **Now one store.**

> **#1 must-fix for the one-store guarantee:** the legacy-AI-source path (`permission-check.ts:855-880`)
> reads `autoApproveFor` _outside_ the resolver. It MUST route through the resolver (or consult
> `governance_rules`) in this phase, or it's a genuine second concurrent store — the founder's hard-no.
> Also verify parity for `source:"ai"` no-`agentUserId` writes (Discord digest etc.).

### Phase C — retire the JSONB

Drop the autoApproveFor read from rungs 4/8, collapse them into 2.8, deprecate the JSONB fields (keep one
release for CP back-compat). `DEFAULT_AUTO_APPROVE` / `DESTRUCTIVE_ACTIONS` / `ADMIN_ACTIONS` / floors
**stay in code** (invariants, not user settings). Delete `GOVERNANCE_MODES` now (independent, dead).

### Phase D — trusted lane + per-agent cap

**Trusted lane (self-widening, human-approved):** HUGE reuse — `diagnose({type:"agent"})`
(`services/diagnose/index.ts:456`) already builds every agent's scorecard (approve/reject/duplicate/cap).
A daily pg-boss job reads the roster; for each agent where `total≥100 && approveRate>0.95 &&
duplicateRate<0.15` and no covering rule/pending widen exists → emits a proposal
(`proposalType="governance.widen_lane"`, no enum migration — proposals cols are text). The dominant
write-motif comes from `collapseProposalsToClusters` (already used by the scorecard). On approval, a
branch in `applyProposalApproval` (`proposals.ts:1606`) inserts one `governance_rules` row with
`source_proposal_id` lineage. Revocable, audited, **never silent** — the human approves the widen.
(Claude-code 500/96.6%/10.2% qualifies; orchestrator 31%/87.5% does not.) Exempt `governance.*`
proposalTypes from the daily cap (meta-action, not a data flood).

**Per-agent cap:** change `countTodayAgentProposals` from per-human to per-agent (add
`eq(proposals.agentUserId, agentUserId)`). Replace the flat `AGENT_PROPOSALS_PER_USER_PER_DAY=10` with a
scorecard-weighted ceiling (e.g. base 10, ×3 if approveRate≥0.95 & total≥100). Two touch points:
`createProposal` (`permission-check.ts:1289`) + the count query. Update the `diagnose` summary that says
"shared."

---

## 3. Blast radius & behavior-change-on-live-data flags

- **Per-agent cap flip is LOOSER** — an owner with 3 agents currently sharing 10/day gets 3×(weighted).
  Intended; naming it.
- **Backfill must run before the Phase B reader-flip** or pods lose their autoApproveFor mid-transition.
- **Legacy-AI reroute** changes effective governance for `source:"ai"` no-agentUserId writes — verify parity.
- **Capture agent's 7-verb autoApproveFor** (`ensure-capture-agent.ts`) is re-asserted every boot — the
  seed/backfill must be idempotent with that ensure-loop or they'll fight.
- `pod-hygiene-near-dup.ts:584` has its own separate deterministic-worker budget — leave it.

---

## 4. Decisions needed (options)

- **D1 — Attribution enforcement severity.** Hard-reject bare `linkedUserId==null` keys on `/mcp` writes
  (loud, self-service `synap init`) vs. soft-treat-as-agentic-and-warn. _Recommend hard-reject_ — the
  silent bypass is the worst failure mode; a loud one-time break is the correct direction.
  **⚠️ SUPERSEDED 2026-08-13 — see §6.** Decided differently in practice: reject stays, but re-keyed to
  the correct identity signal (`isAgent` from `users.userType`, OR `linkedUserId`) instead of
  `linkedUserId==null` alone, so pod-wide agents are admitted rather than rejected. Bare human
  `user_pat`/`hub_inbound` keys are still rejected; service keys are still allowed.
- **D2 — `DEFAULT_AUTO_APPROVE` home.** Keep as a code floor consulted when no rule matches vs. seed as
  pod-scope `any` rules. _Recommend keep-as-code_ — it's the safe default, not a user setting; avoids
  seeding churn.
- **D3 — Automation-door profile granularity.** Thread `subjectProfileSlug` into the automation door now
  (chat door already has it) vs. defer to phase-2 (automations rarely target one profile). _Recommend
  defer_ unless you want "note=auto, lead=propose" on automations immediately.
- **D4 — Where to start / how far this wave.** Phase 0 alone (attribution, unblocks everything) vs.
  0+A+B (attribution + store + one-store collapse) vs. full 0→D. _Recommend 0+A+B first_ — it delivers
  the one-store guarantee and is independently valuable; C+D (retire + self-widening) follow once A+B is
  dogfooded.

---

## 5. Doc updates for the AI (AFTER decisions + code)

Once ratified and built: update the AI-facing governance contract (`writes.md` skill, `prompt-sections.ts`
governance section) to describe `governance_rules` + the widen-lane proposal type, and the CLAUDE.md
"AI mutations → checkPermissionOrPropose()" note to reference the single store. Deferred — no doc drift
ahead of the code.

---

## Files (all absolute, for the implementer)

```
packages/governance-policy/src/index.ts                          (rung 2.8; delete GOVERNANCE_MODES)
packages/database/src/utils/resolve-agent-governance-decision.ts (resolver call + governanceRuleVerdict — the ONE wiring site)
packages/database/src/schema/governance-rules.ts                 (NEW)
packages/database/migrations/0214_governance_rules.sql           (NEW) + 0000_baseline_schema.sql + src/utils/schema-coherence.ts
packages/api/src/utils/permission-check.ts                       (per-agent cap :1166,:1289; legacy-AI reroute :855-880; attribution enforce)
packages/api/src/routers/mcp/http-handler.ts + hub-protocol-rest.ts (attribution enforcement, the 2 sites)
packages/api/src/services/diagnose/agent-scorecard.ts + index.ts:456 (trusted-lane data source — reader only)
packages/api/src/routers/proposals.ts:1606                       (widen_lane executor branch)
packages/jobs/src/... (NEW pg-boss trusted-lane scanner) + automation-governance.ts:154 (profileSlug plumbing, if D3=now)
Write surfaces: workspaces.ts:660, hub-protocol/rest/agent-users.ts:201, ensure-capture-agent.ts, browser AiGovernanceSection.tsx
```

---

## 6. SHIPPED 2026-08 (this convergence round) — verified, uncommitted

Everything below was built and gate-verified in this round. It is **uncommitted** and **not deployed**
— all runtime claims are NEEDS-DOGFOOD until redeploy. Where it revises a decision or phase above, that
section is annotated `SUPERSEDED` in place; nothing below duplicates deleted content, it records what
actually landed.

### #1 — Identity: `resolveKeyIdentity`, one door (supersedes D1 / Phase 0)

The real "is this an agent" signal is **`users.userType === 'agent'`** of the key's principal
(`keyRecord.userId`) — not `linkedUserId` (which encodes _delegation to a human_, not agent-ness) and
not `keyType` (defaults to `hub_inbound`, unreliable as a signal). Shipped:

- ONE `resolveKeyIdentity` — `packages/api/src/access/key-identity.ts` — adopted by all three
  transports that previously each computed this independently: `api-key-auth`, `hub-protocol-rest`,
  `mcp/http-handler`.
- `agentUserId = isAgent ? keyRecord.userId : undefined` (was: `linkedUserId`-gated).
- `effectiveUserId = linkedUserId ?? userId` — an own-principal data floor for pod-wide agents (no
  `linkedUserId` to fall back to), so a pod-wide agent's reads/writes scope to _itself_, never
  silently to an owner it isn't delegated from (no owner-impersonation).
- `shouldRejectUnattributedWrite` re-keyed to `(!isAgent && !linkedUserId && bare user_pat/hub_inbound)`
  — now **admits** real agents including pod-wide ones, still **rejects** bare human PATs speaking
  MCP, still **allows** service keys. This is the corrected, shipped form of D1/Phase 0's reject.
- Pod-wide agents are treated as governed machine principals (the GCP-service-account /
  GitHub-App-installation model) — never hard-refused outright; they still go through the full
  governance ladder like any other agent.
- New minting path: `podWide: true` opt-in on `provisionSurfaceAgentKey` / `POST /setup/agent`.
  **Default stays fail-closed** (`NO_LINKED_HUMAN`) — pod-wide is opt-in, not the new default.
- Regression coverage: `identity-one-door.test.ts` (new tripwire — one door, not three divergent
  computations).
- **Behavior-preserving** for every existing key: an already-attributed agent key resolves the same
  `isAgent`/`agentUserId`/`effectiveUserId` triple it did before.

**Deferred:** user-facing CLI/UI for minting or managing pod-wide agent keys is unbuilt — the door
exists server-side only.

### #2 — Kind/facet write-guard: closed the `skipValidation` bypass

The identity-shape guard against writing a role-profile as its own kind already lived in
`EntityRepository.create`. This round closed a bypass: `skipValidation: true` was skipping the
identity-shape adapter along with property validation. Now `skipValidation` skips **only** property
validation — the kind/facet adapter always runs. Additionally, `sync-materializer` now derives
`entities.type` from the authoritative `profileId` rather than trusting a separately-supplied type.

### #3 — Ceilings: rung 2.56, first slice (new axis, not in the original plan)

New `governance_ceilings` store (migration `0236`) plus a **per-agent daily executed-write ceiling**
(lazy count via `idx_events_ungoverned_agent`) feeding a new **tighten-only** rung **2.56** in
`decideAgentPolicy`. Resolves inside the existing shared `resolveAgentGovernanceDecision` call site —
so the automation door, which was previously uncapped on this axis, is now capped through the same
one door as chat.

**Deferred (explicitly out of scope this round):** rate-limiting axis, tool-level ceilings, hard
economic/cost budgets, and a scorecard-weighted-ceiling recommender (§2 Phase D's per-agent cap idea
is related but distinct — still open).

### #4 — Provenance: rung 2.55, dormant until wired (new axis, not in the original plan)

New **tighten-only** rung **2.55 `UNTRUSTED_ORIGIN`** in `decideAgentPolicy`. `resolveOriginTrust`
classifies the acting channel's origin (EXTERNAL / bridge / source-produced → untrusted → forces
propose). This activates the previously-dormant `config_settings.posture` knob referenced elsewhere in
the governance surface.

**DORMANT until a caller threads `channelId` into the gate** — the rung and classifier are built and
tested, but no live call site passes `channelId` yet, so this rung never fires in production today.
Wiring that is explicit follow-up work, not part of this round.

### #5 — Error-mapping: 19 hub-REST catch sites → `httpStatusForTrpcError`

19 hub-REST catch sites converted from ad-hoc status codes to the shared `httpStatusForTrpcError`
mapper, with a regression tripwire and 2 explicitly-excluded traps. Improves error-code fidelity for
Hub Protocol callers (including the identity/governance error paths above). **~235 remaining call
sites repo-wide are an explicitly deferred tail**, not part of this round's scope.

### Architecture invariant this round reinforces

**#3 and #4 both follow the rung-2.8 pattern this doc already established for `governance_rules`**:
the I/O caller (`resolveAgentGovernanceDecision`) resolves a pre-computed, tighten-only verdict from
a store or classifier; the pure `decideAgentPolicy` engine only ever _consumes_ an already-decided
value — it never reaches into the DB itself. Floors (2 ADMIN, 2.1 forcePropose, 2.5 DESTRUCTIVE, 2.6
by-kind) stay supreme; every new rung is placed below them and is additive/tighten-only, never
loosening. **#1 (`resolveKeyIdentity`) is the identity-layer analogue of the same discipline** — one
door computes the signal, every transport consumes it, no transport re-derives its own notion of
"is this an agent."

### Verification status

- **VERIFIED (gate-proven, this session):** migration 0236 SQL, `identity-one-door.test.ts`, ceiling
  and provenance rung unit coverage, hub-REST error-mapping tripwire — all green at time of writing.
- **NEEDS-DOGFOOD (runtime, requires redeploy):** all behavior above — identity resolution across
  live traffic, ceiling enforcement against real daily volumes, provenance classification once wired.
- **CI-gated, not yet run in this environment:** migration 0236 replay + `schema:check`.
- **Unbuilt:** pod-wide-agent CLI/UI surface; ceilings' rate/tool/economic axes; error-mapping tail
  (~235 sites); #4's `channelId` caller wiring.
