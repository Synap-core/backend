# Agent governance: one engine, one rules store, attributed writes

> Verified against code on 2026-10-20 (backend@c31e261a). Condensed from the
> governance convergence and phase-2 plans (ratified 2026-07-27, amended
> 2026-08-13), which were removed from the repository on 2026-10-20.

- **Status:** Accepted 2026-07-27. Amended 2026-08-13 (agent identity). Built.
- **Scope:** how the pod decides whether an agent's write or capability run
  executes or becomes a proposal. Human writes are out of scope.

## Context

In July 2026 one decision engine and one call site already existed, but three
problems compounded:

1. **Attribution gap.** An agent write was governed only when its key carried a
   `linkedUserId`. A bare personal key handed to an agent fell to the human path
   and, for default auto-approved verbs, executed directly with no proposal.
2. **Three stores.** "Always approve" state lived in
   `workspaces.settings.aiGovernance.autoApproveFor`,
   `users.agentMetadata.autoApproveFor` and `vault_grants`, plus code constants.
   Nothing was revocable, audited or ranked by specificity in one place.
3. **A flat shared cap.** The daily proposal cap was per human, shared by all of
   their agents, and blind to unattributed writes.

## Decisions

Convergence (2026-07-27):

1. **D1. Unattributed agent writes over `/mcp` are refused** with a
   self-service error (run `synap init`). Human keys on Hub REST stay anonymous.
   _Amended 2026-08-13:_ "is an agent" is the key principal's
   `users.userType === 'agent'`, not `linkedUserId`; pod-wide agents (no
   `linkedUserId` by design) are admitted as governed machine principals. One
   identity door serves every transport.
2. **D2.** `DEFAULT_AUTO_APPROVE` stays a code floor consulted when no rule
   matches; it is not seeded as rows.
3. **D3.** The automation door threads the subject profile, like the chat door.
4. **D4.** Build the whole sequence: attribution, the `governance_rules` store,
   backfill to one store, retire the JSONB as a decision source, then a
   self-widening trusted lane and a per-agent cap.

Phase 2 (2026-07-27):

1. **D1. Capability rules live inside the capability gate.** A `verdict: "auto"`
   capability rule widens propose to run, and may authorize a run with no grant,
   for tools, skills and commands only. Never for secrets, never past the
   `approved === false` deny floor or dry-run. `vault_grants` keeps grant
   existence, consumable uses, dry-run and secret decryption.
2. **D2.** Ship a rules list with revoke (pod-admin first), and a presentation
   for widen-lane proposals. Retiring the old JSONB settings forms is deferred.
3. **D3.** Widen agent attribution so more agent writes carry an
   `agentUserId` and proposal dedup engages; human writes stay exempt.
4. **D4.** Compute the trusted-agent cap on the same recent window the
   scorecard displays, and present `diagnose` "duplicates" as review grouping.
   Fix the `knowledge_facts` dedup race with a unique index.

## Invariants

- A rule only ever says `auto` or `propose`, never `deny`; deny stays with CBAC
  and the floors.
- Every floor (admin, human-gate and schema rungs, forced propose, destructive)
  resolves above rung 2.8, so no rule can auto-approve a delete, an admin
  action or a scope change.
- New axes are tighten-only and follow the rung-2.8 pattern: the I/O caller
  resolves a verdict, the pure engine consumes it.

## State on 2026-10-20

| Decision                          | Where                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure engine, ladder in its header | `packages/governance-policy/src/index.ts` (`decideAgentPolicy`)                                                                                    |
| The one call site                 | `packages/database/src/utils/resolve-agent-governance-decision.ts`                                                                                 |
| Identity door, reject rule        | `packages/api/src/access/key-identity.ts` (`resolveKeyIdentity`), `packages/api/src/routers/mcp/http-handler.ts` (`shouldRejectUnattributedWrite`) |
| Rules store                       | migration `0215_governance_rules.sql`; backfill `packages/database/src/utils/backfill-governance-rules.ts`                                         |
| Trusted lane                      | `packages/jobs/src/workers/governance-lane-scanner.ts` (total ≥ 100, approve rate > 0.95, duplicate rate < 0.15)                                   |
| Capability rules in the gate      | `packages/capability-gate/src/index.ts`                                                                                                            |
| Rules panel                       | `apps/pod-admin/app/(admin)/workspaces/[id]/_lib/governance-rules-panel.tsx`                                                                       |
| Ceilings (rung 2.56)              | migrations `0236_governance_ceilings.sql`, `0330_governance_ceiling_axes_fold.sql`                                                                 |
| Untrusted origin (rung 2.55)      | `decideAgentPolicy`; the resolver takes a `channelId`                                                                                              |
| `knowledge_facts` dedup           | migration `0216_knowledge_facts_dedup.sql`                                                                                                         |

The `GOVERNANCE_MODES` presets named in the plan as dead code are gone. A
pod-wide agent key is minted server-side with `podWide: true` on
`POST /setup/agent` (`packages/api/src/routers/hub-protocol/rest/setup.ts`). The
2026-08 round listed as not built: a user-facing way to mint those keys, and
rate, tool and cost axes for ceilings. Those two were not re-checked here.
