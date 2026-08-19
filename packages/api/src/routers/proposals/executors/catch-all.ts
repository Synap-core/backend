import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { auditLog } from "../../../utils/audit-log.js";
import {
  registerProposalExecutor,
  type ProposalEffect,
  type StoredProposalData,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/**
 * subjectTypes the MATERIALIZER WORKER (`packages/jobs/src/workers/materializer.ts`)
 * actually has a `case` for — i.e. the subjects for which emitting `.validated`
 * hands the write to a real writer instead of falling to that switch's
 * `default:` (which logs "Unknown subject type for materialization" and RETURNS).
 *
 * This is a MIRROR of a set that lives in another package, so it is kept honest
 * by a tripwire that parses the worker's switch and fails on drift
 * (`executors/__tests__/catch-all-effect-receipt.test.ts`). Do not edit this list
 * without running that test.
 *
 * `whiteboard` is DELIBERATELY EXCLUDED even though the worker has a `case` for
 * it: that case logs "not yet supported" and returns, so it is a no-op writer.
 * Counting a case label instead of its body is exactly how a severed door scores
 * as wired.
 */
const MATERIALIZED_SUBJECT_TYPES = new Set([
  "entity",
  "facet",
  "entity_facet",
  "profile",
  "relation_def",
  "view",
  "command",
  "cell",
  "workspace",
  "link",
  "relation",
  "projectMember",
]);

/**
 * Doors that legitimately reach this catch-all and legitimately write NOTHING.
 *
 * ACKNOWLEDGE, DON'T SYMMETRIZE — the same shape `__tripwires__/cross-door-verb-parity.test.ts`
 * uses. Making the catch-all throw for every unhandled key would break these on
 * purpose-built behaviour, so each is listed WITH A ONE-LINE REASON. An entry
 * here is a claim that "nothing was written" is the correct outcome; it is NOT a
 * place to park a severed door to silence the throw. Severed doors are tracked
 * (and ratcheted down) in `__tripwires__/governed-writes-have-approval-half.test.ts`,
 * and their honest outcome is the throw below.
 */
const ACKNOWLEDGED_NOOP_KEYS: Record<string, string> = {
  "proactive/recap":
    "DELIBERATE — the recap is already persisted when the proposal is filed " +
    '(services/session-recap/run-session-recap.ts: "approval is a no-op ' +
    'materialize"); approval records the human acknowledgement only.',
  "bento/arrange":
    "DELIBERATE — `bento.arrange` is in DEFAULT_AUTO_APPROVE, so the layout " +
    "write runs on the direct path. A pending proposal exists only in a " +
    "review-required workspace, where approval is the recorded ack, not the write.",
  "context/link":
    "DELIBERATE — `context.*` is in DEFAULT_AUTO_APPROVE; same shape as " +
    "bento/arrange. The link is written on the direct path.",
  "whiteboard/place":
    "DELIBERATE — whiteboard placement is applied inline by its own REST route; " +
    'the materializer\'s `case "whiteboard"` explicitly logs "not yet ' +
    'supported" and skips rather than hard-failing. Approval records the ack.',
};

/** Register the wildcard catch-all approve executor (must run LAST — see aggregator). */
export function registerCatchAllExecutor(): void {
  // ── Catch-all (generic request-shaped) — replaces silent NOT_IMPLEMENTED ─────
  // resolve() returns THIS for any unmatched key. The body is the verbatim
  // generic `.validated`-emit path PLUS the old shared tail (status flip +
  // reportProposalOutcome + emitProposalReviewed). Only a payload that ALSO
  // fails isRequestShapedProposalData throws — that throw is now EXPLICIT here,
  // no longer a forgotten-branch fallthrough.
  registerProposalExecutor({
    key: "*/*",
    async execute({ proposal, payload, userId, input, deps }) {
      const isRequestShaped = deps.isRequestShapedProposalData as (
        p: unknown
      ) => boolean;

      const doorKey = `${proposal.targetType}/${proposal.proposalType}`;
      const acknowledgedNoopReason = ACKNOWLEDGED_NOOP_KEYS[doorKey];
      let effect: ProposalEffect;

      if (isRequestShaped(payload)) {
        const {
          targetType,
          changeType,
          data: requestData,
          correlationId: proposalCorrelationId,
        } = payload as StoredProposalData & {
          targetType: string;
          changeType: string;
          data: unknown;
          correlationId?: string;
        };

        const eventPayload: Record<string, unknown> =
          typeof requestData === "object" && requestData !== null
            ? { ...(requestData as Record<string, unknown>) }
            : {};

        // Normalize entity payload fields
        if (targetType === "entity") {
          if (
            changeType === "update" &&
            eventPayload.entityId != null &&
            eventPayload.id == null
          ) {
            eventPayload.id = eventPayload.entityId;
          }
          if (
            changeType === "create" &&
            eventPayload.description != null &&
            eventPayload.preview == null
          ) {
            eventPayload.preview = eventPayload.description;
          }
        }

        const subjectId = (eventPayload.id as string) || proposal.targetId;

        // ── THE HONESTY GATE ────────────────────────────────────────────────
        // Reaching here means NO executor claimed this door. The only thing
        // this branch can do is append a `.validated` event, which the
        // materializer worker turns into a write — but ONLY for the subjects it
        // has a case for. For every other subject that event lands on the
        // worker's `default:` (warn + return) and NOTHING is ever written,
        // while this executor used to return `{ success: true }`.
        //
        // So: a subject the materializer writes → `deferred` (honest handoff).
        // A door listed as a deliberate no-op → `none` WITH ITS REASON.
        // Anything else → THROW. It is an unknown key, and silent success is
        // strictly worse than a throw: the throw is recorded as APPROVAL_FAILED
        // + rejectionReason by `dispatchProposalApproval`'s `onApprovalFailed`,
        // is retryable, and surfaces the missing approval half the FIRST time
        // anyone approves instead of never.
        if (
          acknowledgedNoopReason === undefined &&
          !MATERIALIZED_SUBJECT_TYPES.has(targetType)
        ) {
          throw new TRPCError({
            code: "NOT_IMPLEMENTED",
            message:
              `Approval for '${doorKey}' has no approval half: no executor is ` +
              `registered for it, and the materializer has no writer for subject ` +
              `'${targetType}'. Approving would have changed nothing. Register an ` +
              `executor for this door (or, if writing nothing is correct, add it ` +
              `to ACKNOWLEDGED_NOOP_KEYS with a reason).`,
          });
        }

        const validatedEvent = await auditLog({
          subjectType: targetType,
          action: changeType,
          phase: "validated",
          throwOnError: true,
          subjectId,
          userId,
          // The CHANGE was authored by the proposing agent (the human here is
          // only the APPROVER, kept in data.approvedBy). Stamp the agent so the
          // resulting activity attributes to it — "the agent did this, you
          // approved it" — instead of collapsing under the operator. Absent
          // (operator-authored proposal) → owner write, is_agent stays null.
          // This mirrors `batchApprove`'s inline emit, which always carried the
          // stamp; routing batch through this executor would otherwise DROP it.
          agentUserId: proposal.agentUserId ?? undefined,
          workspaceId: proposal.workspaceId ?? undefined,
          correlationId: proposalCorrelationId,
          data: {
            ...eventPayload,
            workspaceId: proposal.workspaceId,
            approvedBy: userId,
            approvedAt: new Date().toISOString(),
            approvalComment: input.comment,
            sourceProposalId: input.proposalId,
          },
          source: "api",
        });

        if (validatedEvent && payload) {
          (payload as { validatedEventId?: string }).validatedEventId =
            validatedEvent.id;
        }

        // The receipt comes from the EVENT APPEND, not from "we got here".
        // No event row ⇒ no handoff happened ⇒ nothing will ever be written.
        if (!validatedEvent) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              `Approval for '${doorKey}' could not record its .validated event, ` +
              `so no write was handed off. Nothing was applied.`,
          });
        }

        effect =
          acknowledgedNoopReason !== undefined
            ? { applied: "none", reason: acknowledgedNoopReason }
            : {
                applied: "deferred",
                validatedEventId: validatedEvent.id,
                subject: targetType,
              };
      } else {
        // Payload doesn't match any known request shape and targetType was not
        // handled by a specific executor above — throw rather than silently succeed.
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: `Proposal approval for type '${proposal.targetType}' is not yet implemented`,
        });
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          ...(isRequestShaped(payload) ? { data: payload } : {}),
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
      return { success: true, effect };
    },
  });
}
