# Governance Convergence Plan — one engine, one store, attributed & self-widening

**Status:** DECISIONS RATIFIED 2026-07-27 — ready to build. Written 2026-07-27.
**Research:** two read-only deep-dives, every claim `file:line`-verified against `synap-backend/` HEAD
(`gov-attribution`, `gov-rules-lane-cap`). Nothing below is built yet.

### Ratified decisions (founder, 2026-07-27)

- **D1 = Hard-reject.** A `linkedUserId==null` key writing over `/mcp` → loud 403 ("not an agent key — run `synap init`"). Human PATs on Hub REST stay anonymous.
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
