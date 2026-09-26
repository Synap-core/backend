import { TRPCError } from "@trpc/server";
import { db, eq, getDb, proposals } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../../routers/proposals/execution-registry.js";
import { reportApproved } from "../../routers/proposals/executors/shared.js";
import { applyShare, planShare, SHARE_AUDIENCES } from "./share-service.js";
import { SHARE_KINDS } from "./exposure-policy.js";
import { applyPublish, planPublish } from "./publish-service.js";

/**
 * Approve-executor for `share/create` — an AGENT's share (Sites W2 S3).
 *
 * REPLAY, never reconstruct: the stored payload is re-validated and re-planned
 * through the SAME `planShare` the direct door runs, re-floored NOW on the
 * proposal's SUBJECT (`proposals.subject_user_id` — the human the agent acted
 * for; never the approver, never anything in the payload), because a proposal
 * can sit for days. Then `applyShare` with `mintToken: false`: an approved link
 * row carries NO token — only a signed-in human mints the secret
 * (`shares.rotateLink`).
 *
 * WHY REGISTERED HERE and not from `routers/proposals/approve-executors.ts`:
 * that aggregator is being edited by another session (2026-09-26). It is
 * registered at module load of `routers/shares.ts`, which `root.ts` mounts, so
 * the approve path always has it; `registerShareExecutors` is idempotent so the
 * aggregator can adopt it later with one line and no double registration.
 */
let registered = false;

export function registerShareExecutors(): void {
  if (registered) return;
  registered = true;
  registerProposalExecutor({
    key: "share/create",
    async execute({ proposal, userId, input, deps }) {
      const refuse = (why: string) =>
        new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Approval for 'share/create' refused: ${why} Nothing was shared.`,
        });

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const resourceType = inner.resourceType;
      const audience = inner.audience;
      const ownerUserId = proposal.subjectUserId;

      // PUBLISH (W5a) files the same floored door with `audience: "public"`.
      // Replayed through the SAME `planPublish` the direct door runs, on the
      // proposal's SUBJECT, and published WITHOUT a token — the signed-in owner
      // publishes again to mint it (an agent never holds the public secret).
      if (audience === "public") {
        if (
          (resourceType !== "entity" && resourceType !== "document") ||
          typeof inner.resourceId !== "string"
        ) {
          throw refuse("the stored publish request is malformed.");
        }
        if (!ownerUserId) {
          throw refuse(
            "the proposal records no owner (subject_user_id), so whose publication this is cannot be established."
          );
        }
        const database = await getDb();
        const plan = await planPublish(database, ownerUserId, {
          resourceType,
          resourceId: inner.resourceId,
        });
        const published = await applyPublish(database, plan, {
          userId: ownerUserId,
          agentUserId: proposal.agentUserId ?? null,
          sourceProposalId: input.proposalId,
          mintToken: false,
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
        return {
          success: true,
          primaryId: published.shareId,
          effect: {
            applied: "verified" as const,
            rows: published.rowsWritten,
            subject: "share",
          },
        };
      }

      if (
        typeof resourceType !== "string" ||
        !(SHARE_KINDS as readonly string[]).includes(resourceType) ||
        typeof inner.resourceId !== "string" ||
        typeof inner.anchorProjectId !== "string" ||
        typeof audience !== "string" ||
        !(SHARE_AUDIENCES as readonly string[]).includes(audience)
      ) {
        throw refuse("the stored share request is malformed.");
      }
      if (!ownerUserId) {
        throw refuse(
          "the proposal records no owner (subject_user_id), so whose share this is cannot be established."
        );
      }
      const expiresAt =
        typeof inner.expiresAt === "string" ? new Date(inner.expiresAt) : null;

      const database = await getDb();
      const plan = await planShare(database, ownerUserId, {
        resourceType: resourceType as (typeof SHARE_KINDS)[number],
        resourceId: inner.resourceId,
        anchorProjectId: inner.anchorProjectId,
        audience: audience as (typeof SHARE_AUDIENCES)[number],
        expiresAt,
      });
      const result = await applyShare(database, plan, {
        userId: ownerUserId,
        agentUserId: proposal.agentUserId ?? null,
        sourceProposalId: input.proposalId,
        mintToken: false,
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
      return {
        success: true,
        primaryId: result.shareId ?? result.resourceId,
        effect:
          result.rowsWritten > 0
            ? {
                applied: "verified" as const,
                rows: result.rowsWritten,
                subject: "share",
              }
            : {
                applied: "none" as const,
                reason:
                  "It was already shared with this project, so nothing changed.",
              },
      };
    },
  });
}
