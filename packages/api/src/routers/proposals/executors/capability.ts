import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  skills,
  knowledgeRepository,
  capabilities,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import { emitAiDecision } from "../../../utils/ai-feedback-events.js";
import {
  runResolvedSkill,
  assertApprovalTargetResolves,
} from "../../../services/capabilities/execute-capability.js";
import { applyMarketInstall } from "../../../services/capabilities/marketplace-install.js";
import { setCapabilityRenderer } from "../../../services/capabilities/set-capability-renderer.js";
import type { CapabilityRendererPage } from "@synap/database";
import {
  triggerProviderAction,
  type ConnectionSelector,
} from "../../../connectors/external-dispatch.js";
import type { CatalogKind } from "@synap/jobs";
import type { Context } from "../../../context.js";
import {
  registerProposalExecutor,
  attachFailureMeta,
} from "../execution-registry.js";
import {
  assertApplied,
  reportApproved,
  dispatchExternalOnce,
} from "./shared.js";

const logger = createLogger({
  module: "proposal-approve-executors-capability",
});

/** Register the capability.run / capability.install / capability.enable / capability/run approve executors. */
export function registerCapabilityExecutors(): void {
  // ── capability.run (proposalType-only) — AGNOSTIC CAPABILITY LAST-MILE ───────
  // Re-entry for a `propose` verdict from POST /capabilities/execute (and any
  // other capability launcher): approve → run the backing skill through the SAME
  // post-gate runResolvedSkill the door uses (ONE kind-branch, two doors) so an
  // approved declarative/builtin verb routes to its correct tier. The gate
  // already ran when the proposal was created, so this does NOT re-gate.
  // Idempotent: skip if already APPROVED.
  registerProposalExecutor({
    key: "capability.run",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      // Stale-target preflight — before any at-most-once dispatch. Blocks
      // approving into a workspace the approver has left (phantom/lost-membership)
      // → the P1 recovery chip, no wasted provider call. See
      // assertApprovalTargetResolves.
      const targetFail = await assertApprovalTargetResolves(
        proposal.workspaceId ?? null,
        userId
      );
      if (targetFail) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Couldn't apply — ${targetFail.message}.`,
          }),
          { errorClass: targetFail.errorClass }
        );
      }
      const skillId = data.skillId as string | undefined;
      const parameters = (data.parameters ?? {}) as Record<string, unknown>;

      if (!skillId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "capability.run requires skillId in proposal data",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Route through the SAME post-gate runner the door uses, so an approved
      // `declarative`/`builtin` verb is executed by its correct tier instead of
      // being blindly shipped to the IS isolate. Load the row the runner needs.
      const [skillRow] = await db
        .select({
          id: skills.id,
          name: skills.name,
          kind: skills.kind,
          providerSpec: skills.providerSpec,
        })
        .from(skills)
        .where(eq(skills.id, skillId))
        .limit(1);
      if (!skillRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `capability.run skill "${skillId}" not found`,
        });
      }

      // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
      // not_found / deny are DEFINITE not-run → { delivered: false } releases the
      // claim so Retry re-runs; a throw from runResolvedSkill is ambiguous → the
      // claim is kept (no resend).
      let runResult: unknown;
      await dispatchExternalOnce(input.proposalId, async () => {
        const runOutcome = await runResolvedSkill(skillRow, parameters, {
          userId,
          workspaceId: proposal.workspaceId ?? null,
          connectionSelector:
            (data.connectionSelector as ConnectionSelector | null) ?? null,
        });
        if (runOutcome.kind === "not_found") {
          logger.warn(
            {
              proposalId: input.proposalId,
              skillId,
              reason: runOutcome.message,
            },
            "capability.run executor: skill not found"
          );
          return { delivered: false, reason: runOutcome.message };
        }
        if (runOutcome.kind === "deny") {
          logger.warn(
            {
              proposalId: input.proposalId,
              skillId,
              reason: runOutcome.reason,
            },
            "capability.run executor: run denied"
          );
          return { delivered: false, reason: runOutcome.reason };
        }
        if (runOutcome.kind === "error") {
          // The run REACHED its handler and FAILED (code sandbox success:false, or
          // a provider verb error envelope). This is a DEFINITE not-delivered →
          // release the at-most-once claim so Retry re-runs. Previously this rode
          // through as a `kind:"run"` carrying success:false, which BURNED the claim
          // (delivered:true) and left the failed send stuck as "delivered".
          logger.warn(
            {
              proposalId: input.proposalId,
              skillId,
              reason: runOutcome.message,
            },
            "capability.run executor: run failed"
          );
          return {
            delivered: false,
            reason: runOutcome.message,
            errorClass: runOutcome.errorClass,
            providerRef: runOutcome.providerRef,
          };
        }
        runResult = runOutcome.result;
        return { delivered: true };
      });

      // Workstream 1 (capability-run observability contract): a delivered run
      // reaching this point was, until now, unobservable — no correlationId,
      // no run-ledger row, no recall deposit. Stamp a correlationId (the join
      // key `listCapabilityRuns`/getRun's "capability" branch read) so the run
      // becomes listable + diagnosable, mirroring the capture pattern exactly.
      const correlationId = randomUUID();

      const materializedPayload = {
        ...payload,
        runResult,
      } as unknown as typeof payload;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: materializedPayload,
          correlationId,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Emit the run's ONE timeline entry — correlationId-keyed, exactly like a
      // capture's ai_decision — so `diagnose(runId)`/getRun renders a timeline
      // instead of an empty activity list. Best-effort (emitAiDecision never
      // throws): a telemetry hiccup must not undo the already-delivered run.
      void emitAiDecision({
        action: "capability_run",
        userId,
        workspaceId: proposal.workspaceId,
        correlationId,
        data: {
          kind: "capability_run",
          skillId,
          verbId: (data.verbId as string | null) ?? null,
        },
      });

      // Recall deposit — the SAME door `remember_fact` uses to index a fact for
      // `ask`'s episodic substrate (`knowledgeRepository.saveFact`), not a
      // bespoke insert, so a capability run's result is recallable and shaped
      // like every other recall-indexed fact. Best-effort: embedding/index
      // failure must not undo the already-delivered run.
      try {
        let embedding: number[];
        try {
          const { generateEmbedding } = await import("@synap/ai-embeddings");
          embedding = await generateEmbedding(
            `Ran capability "${(data.verbId as string | null) ?? skillId}" → ${JSON.stringify(runResult).slice(0, 1000)}`
          );
        } catch {
          embedding = new Array(1536).fill(0);
        }
        await knowledgeRepository.saveFact({
          userId,
          fact: `Ran capability "${(data.verbId as string | null) ?? skillId}" → ${JSON.stringify(runResult).slice(0, 1000)}`,
          confidence: 0.9,
          embedding,
        });
      } catch (err) {
        logger.warn(
          { err, proposalId: input.proposalId, skillId },
          "capability.run executor: recall deposit failed (run kept delivered)"
        );
      }

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── capability.install (Wave 3b) — MARKETPLACE INSTALL LAST-MILE ────────────
  // Materializes an agent-initiated `market.install` (always proposed — see
  // runMarketInstall's doc). Approval runs `applyMarketInstall` — the SAME
  // kind-routed applier the operator-direct path in the builtin verb handler
  // calls — so an approved agent install can never diverge from an operator's
  // own install. Idempotent per kind (each door's own natural key: capability
  // name+workspace, template packageSlug/proposalId, cell typeKey+workspaceId,
  // automation name+workspace) — re-approving a stale proposal converges.
  registerProposalExecutor({
    key: "capability.install",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const slug = data.slug as string | undefined;
      const kind = data.kind as CatalogKind | undefined;
      if (!slug || !kind) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "capability.install requires slug and kind in proposal data",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const installResult = await applyMarketInstall({
        kind,
        slug,
        version: data.version as string | null | undefined,
        params: (data.params ?? {}) as Record<string, unknown>,
        userId,
        workspaceId: proposal.workspaceId ?? null,
      });

      const materializedPayload = {
        ...payload,
        installResult,
      } as unknown as typeof payload;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: materializedPayload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── capability.enable (Wave 3b) — DRAFT → APPROVED, via the EXISTING gate ───
  // (P2.2-b): approver scope mirrors `skills.setApproved` exactly (workspace
  // owner, or pod-admin for a pod-wide skill) — this executor is a thin call
  // through that already-gated path, no new authority model. The CREATION call
  // site (e.g. the DRAFT-deny error hint proposing "enable this capability") is
  // a different wave's concern; this registers the proposal TYPE + its executor
  // so that wiring has somewhere to land.
  registerProposalExecutor({
    key: "capability.enable",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const skillId = data.skillId as string | undefined;
      if (!skillId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "capability.enable requires skillId in proposal data",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Reuse setApproved AS-IS: it re-derives the approver's role from the
      // skill's OWN workspace, so the proposal review IS the gate — the
      // approving user must already be able to call setApproved directly.
      const { skillsRouter } = await import("../../skills.js");
      const caller = skillsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: proposal.workspaceId ?? null,
      } as unknown as Context);
      await caller.setApproved({ id: skillId, approved: true });

      const materializedPayload = {
        ...payload,
        enabled: true,
      } as unknown as typeof payload;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: materializedPayload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // NOTE (W3b): the `connector.action.trigger` executor (Nango named-action 3rd
  // path) was RETIRED. The agnostic `provider.action` executor below + the shared
  // `triggerProviderAction()` dispatcher (Nango `proxyRequest`) is the ONE governed
  // external-action door — there is no separate named-action path to keep in sync.

  // ── capability/run — CAPABILITY-EXECUTION LAST-MILE (Wave 3a) ────────────────
  // Materializes a `propose`/`propose-each` verdict from rung 2.6: on approval,
  // RE-ENTER the same execute path the auto-path uses, so approve-path and
  // auto-path share ONE execution impl. Mirrors provider.action: idempotent
  // (skip if already APPROVED), flips APPROVED + emitProposalReviewed.
  //
  // ── The `alreadyApproved` bypass contract (for Wave 3b) ──────────────────────
  // The chokepoint Wave 3b wires (triggerProviderAction / skill-execute /
  // automation nodes) calls `gateCapabilityExecution()` FIRST. On the auto path
  // the gate returns `{ decision: "run" }` and the chokepoint dispatches inline.
  // On the propose path the gate returns `{ decision: "propose", … }`, a
  // `capability/run` proposal is created, and THIS executor runs on approval —
  // re-entering the SAME dispatch. To stop the re-entry from proposing a SECOND
  // time, the chokepoint's execute input MUST carry an `alreadyApproved: true`
  // (a.k.a. `bypassGovernance`) flag that SHORT-CIRCUITS the gate to `run`. The
  // contract Wave 3b must honor:
  //   • input field name: `alreadyApproved?: boolean` on the capability-execute
  //     call (and `sourceProposalId?: string` for audit).
  //   • when `alreadyApproved === true`, the chokepoint SKIPS
  //     `gateCapabilityExecution()` entirely and dispatches directly — exactly
  //     once — so an approved proposal never loops back into a new proposal.
  //   • only THIS executor (and the auto `run` decision) may set it true; no
  //     external caller may supply it.
  registerProposalExecutor({
    key: "capability/run",
    async execute({ proposal, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      // Stale-target preflight — before any at-most-once dispatch. Blocks
      // approving into a workspace the approver has left (phantom/lost-membership)
      // → the P1 recovery chip, no wasted provider call. See
      // assertApprovalTargetResolves.
      const targetFail = await assertApprovalTargetResolves(
        proposal.workspaceId ?? null,
        userId
      );
      if (targetFail) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Couldn't apply — ${targetFail.message}.`,
          }),
          { errorClass: targetFail.errorClass }
        );
      }
      const capabilityKind = data.capabilityKind as
        "tool" | "skill" | "command" | undefined;
      const capabilityId = data.capabilityId as string | undefined;

      if (!capabilityKind || !capabilityId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "capability/run proposal requires capabilityKind and capabilityId in proposal data",
        });
      }

      // Guard: only execute once (the run may be an irreversible external write).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Captures the skill/command result so it can be materialized below —
      // only set on the "skill"/"command" branch; the "tool" branch's own
      // result handling is untouched (this executor does not persist a `data`
      // field for it, unchanged from before this wave).
      let skillRunResult: unknown;

      // Re-enter the SAME execute path the auto path uses. The `alreadyApproved`
      // bypass (documented above) is set so the chokepoint does NOT re-propose.
      if (capabilityKind === "tool") {
        const provider = (data.provider as string | undefined) ?? capabilityId;
        const method = (data.method as string | undefined) ?? "POST";
        const path = (data.path as string | undefined) ?? "/";

        // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
        await dispatchExternalOnce(input.proposalId, async () => {
          const {
            success: executed,
            error: providerError,
            errorClass,
            providerRef,
          } = await triggerProviderAction({
            userId,
            provider,
            method,
            path,
            body: data.body as Record<string, unknown> | undefined,
            accountHint: data.accountHint as string | undefined,
            baseUrlOverride:
              (data.baseUrlOverride as string | undefined) ?? undefined,
            workspaceId: (data.workspaceId as string | undefined) ?? undefined,
            // Replay the caller's run-time connection pick so the approved run
            // uses the SAME credential that was selected at propose time (not the
            // capability's default). Persisted into proposal.data at propose time.
            connectionSelector:
              (data.connectionSelector as
                | { connectionId?: string; contextObjectId?: string }
                | null
                | undefined) ?? undefined,
            // BYPASS the capability-execution gate: a human already approved THIS
            // proposal, so this is the governed Door-2 re-entry — dispatch directly,
            // exactly once, without re-proposing (Wave 3a `alreadyApproved` contract).
            alreadyApproved: true,
            sourceProposalId: input.proposalId,
          });
          if (!executed) {
            logger.warn(
              {
                proposalId: input.proposalId,
                provider,
                method,
                path,
                providerError,
              },
              "capability/run executor failed"
            );
            return {
              delivered: false,
              reason: providerError,
              errorClass,
              providerRef,
            };
          }
          return { delivered: true };
        });
      } else if (capabilityKind === "skill" || capabilityKind === "command") {
        // Was: flip to APPROVED with NO execution ("wired by Wave 3b" never
        // landed) — an approved skill/command run silently did nothing. Wire
        // it to the SAME post-gate runner the door + `capability.run` executor
        // use, so this shape can no longer diverge from either. A distinct
        // branch from "tool" above — no shared code path, no double-execute.
        const [skillRow] = await db
          .select({
            id: skills.id,
            name: skills.name,
            kind: skills.kind,
            providerSpec: skills.providerSpec,
          })
          .from(skills)
          .where(eq(skills.id, capabilityId))
          .limit(1);

        if (!skillRow) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `capability/run ${capabilityKind} "${capabilityId}" not found`,
          });
        }

        // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
        await dispatchExternalOnce(input.proposalId, async () => {
          const runOutcome = await runResolvedSkill(
            skillRow,
            (data.input as Record<string, unknown> | undefined) ?? {},
            {
              userId,
              workspaceId: (data.workspaceId as string | undefined) ?? null,
            }
          );
          if (runOutcome.kind !== "run") {
            const reason =
              runOutcome.kind === "deny"
                ? runOutcome.reason
                : runOutcome.kind === "error" || runOutcome.kind === "not_found"
                  ? runOutcome.message
                  : "unknown";
            logger.warn(
              {
                proposalId: input.proposalId,
                capabilityKind,
                capabilityId,
                reason,
              },
              "capability/run executor: skill/command run not delivered"
            );
            return {
              delivered: false,
              reason,
              // P1: an `error` outcome from a provider verb carries the scalars.
              errorClass:
                runOutcome.kind === "error" ? runOutcome.errorClass : undefined,
              providerRef:
                runOutcome.kind === "error"
                  ? runOutcome.providerRef
                  : undefined,
            };
          }
          skillRunResult = runOutcome.result;
          return { delivered: true };
        });
      }
      // Only the "skill"/"command" branch materializes a result (the "tool"
      // branch's own result handling is unchanged, pre-existing behavior).
      const materializedPayload =
        capabilityKind === "skill" || capabilityKind === "command"
          ? ({ ...data, runResult: skillRunResult } as unknown as Record<
              string,
              unknown
            >)
          : null;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          ...(materializedPayload ? { data: materializedPayload } : {}),
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── capability / renderer.set ───────────────────────────────────────────────
  // Materializes an approved "bind a capability renderer page-set" proposal via
  // the SAME shared write path the governed tRPC route uses on operator
  // auto-apply. Without this the proposal would fall to the `*/*` catch-all,
  // which emits a `.validated` event but never writes the renderer. The gate
  // (capabilities.setRenderer) stores `{ capabilityId, scope, pages }` under
  // `proposal.data.data`, so approval has EVERYTHING it needs to apply the
  // binding — not a `{id}`-only gate that no-ops. Clone of profile/renderer.set.
  registerProposalExecutor({
    key: "capability/renderer.set",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const capabilityId = innerData.capabilityId as string | undefined;
      const pages = innerData.pages as CapabilityRendererPage[] | undefined;
      const scope =
        (innerData.scope as "workspace" | "capability" | undefined) ??
        "workspace";
      if (!capabilityId || !Array.isArray(pages)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Renderer proposal is missing capabilityId/pages",
        });
      }

      // Idempotency: skip if already materialized.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      await setCapabilityRenderer({
        userId,
        workspaceId: proposal.workspaceId,
        capabilityId,
        pages,
        scope,
      });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── capability / attach ──────────────────────────────────────────────────
  // `capabilityContainers.addPart` (routers/capability-containers.ts:377) —
  // attaching a tool/skill/playbook/automation into a Capability container.
  //
  // WHY IT PROPOSES: `capability.attach` is not in DEFAULT_AUTO_APPROVE, so an
  // agent asking to join a part to a bundle falls to rung 9. The router's own
  // comment names that path explicitly ("the 'agent asks to join' proposal
  // path"), so this door is reached BY DESIGN, not by accident.
  //
  // WHAT APPROVAL USED TO DO: nothing. `capability` is not a materializer
  // subject, so the `*​/*` catch-all's honesty gate threw NOT_IMPLEMENTED and
  // the reviewer could never apply the attach at all.
  //
  // PAYLOAD (checked at the gate, not assumed): it stores the COMPLETE
  // argument set — `{ capabilityId, partType, partId }` — which is exactly the
  // required half of `addPart`'s input. Nothing needed is missing.
  //
  // ⚠️ targetId IS NOT THE SUBJECT. The gate stamps no `data.id`, so
  // `permission-check.ts` falls back to `randomUUID()` for `targetId`. Reading
  // it would attach nothing, or the wrong thing. Deliberately not read.
  //
  // WHY REPLAY THE ROUTER rather than insert the `links` row here: `addPart`
  // is not one insert. Before it writes it re-runs (a) the POD-SCOPE FLOOR —
  // a pod-wide container (`workspaceId === null`) not created by the caller
  // requires `requirePodAdmin` — and (b) the PART VISIBILITY check
  // (`userVisibleWhere(partTable.workspaceId, …)`). Both are authorization,
  // and both must be evaluated for the APPROVER at APPROVAL TIME: the approver
  // is a different principal than the requester, and the part may have been
  // deleted or re-scoped since the proposal was filed. A hand-written insert
  // here would step past both floors — the exact widening this codebase's
  // `governance-gate-is-not-an-authz-floor` lesson records.
  //
  // IDENTITY: acts as the APPROVER, deliberately. `agentUserId` is NOT
  // forwarded: passing it would re-enter the agent branch of
  // `checkPermissionOrPropose` and file a SECOND proposal, which
  // `assertApplied` would then convert into a FORBIDDEN. The approver is the
  // authority here; the proposal row still records the real author.
  registerProposalExecutor({
    key: "capability/attach",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const capabilityId =
        (inner.capabilityId as string | undefined) ??
        (raw.capabilityId as string | undefined);
      const partId =
        (inner.partId as string | undefined) ??
        (raw.partId as string | undefined);
      const partType =
        (inner.partType as string | undefined) ??
        (raw.partType as string | undefined);
      if (!capabilityId || !partId || !partType) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Capability attach proposal is missing the capability, part type " +
            "or part id — it cannot be applied.",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch. (The insert
      // is itself `onConflictDoNothing` on the link's unique tuple, so a re-run
      // is harmless — the guard keeps the shape identical to every sibling.)
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { capabilityContainersRouter } =
        await import("../../capability-containers.js");
      const capCaller = capabilityContainersRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        ...(proposal.workspaceId ? { workspaceId: proposal.workspaceId } : {}),
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await capCaller.addPart({
          capabilityId,
          partId,
          partType: partType as Parameters<
            typeof capCaller.addPart
          >[0]["partType"],
        })
      );

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── capability / create ───────────────────────────────────────────────────
  // Before the payload widening this gate stored `{ name }` alone, losing
  // `description` AND the workspace SCOPE — so an approved proposal would have
  // materialized the documented "empty shell": an unscoped, undescribed
  // capability. It now carries the full insert shape.
  //
  // NO PROCEDURE TO REPLAY: the direct path is a bare `db.insert(capabilities)`
  // with NO side effects — no `emitSideEffects`, no `recordDomainMutation`, no
  // grant seeding (unlike `tool/create`, which seeds one). Mirroring the insert
  // is therefore complete, not a shortcut. Deliberately NOT adding an emit here
  // that the direct path does not fire: an approval must reproduce the direct
  // write, not improve on it, or the two paths diverge.
  //
  // ⚠️ targetId trap: this gate stores NO `id`, so `permission-check.ts` fell
  // back to `randomUUID()` for `proposal.targetId`. That id names NOTHING. The
  // reflexive `inner.id ?? raw.id ?? proposal.targetId` would hand a random uuid
  // to the insert. It is a CREATE, so no id is read at all — the row mints its
  // own, exactly as the direct path does.
  //
  // AUTHOR: `createdBy: proposal.agentUserId ?? userId` mirrors the direct
  // path's `input.agentUserId ?? userId` — the agent wrote it, the human only
  // approved it.
  registerProposalExecutor({
    key: "capability/create",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;
      const name = inner.name as string | undefined;
      if (!name || typeof name !== "string" || name.trim() === "") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Capability proposal is missing name",
        });
      }

      // Idempotency: the insert mints a fresh id each run, so a re-approve
      // without this guard would double-create.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Workspace lens from the STORED payload (`null` = pod-wide, which is a
      // legitimate reviewed value here — not a missing one).
      const wsLens =
        (inner.workspaceId as string | null | undefined) ??
        proposal.workspaceId ??
        null;

      await db.insert(capabilities).values({
        workspaceId: wsLens,
        createdBy: proposal.agentUserId ?? userId,
        name,
        description: (inner.description as string | null) ?? undefined,
      });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
}
