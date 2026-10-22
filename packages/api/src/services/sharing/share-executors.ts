import { TRPCError } from "@trpc/server";
import { db, eq, getDb, proposals } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../../routers/proposals/execution-registry.js";
import { reportApproved } from "../../routers/proposals/executors/shared.js";
import { applyShare, planShare, SHARE_AUDIENCES } from "./share-service.js";
import { SHARE_KINDS } from "./exposure-policy.js";
import { applyPublish, planPublish } from "./publish-service.js";
import {
  applyConfigureSite,
  applySitePublish,
  planSite,
  planSitePublish,
  SITE_PUBLISH_MAX_RECORDS,
} from "./site-service.js";

/**
 * Approve-executor for `share/create` — an AGENT's share, publish, site
 * (`op: "configure_site"`) or batch publish into a site (`op:
 * "publish_records"`).
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
    // Adds a member / exposes a resource: lasting access for someone.
    widensCredential: true,
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

      // Every branch ends the same way once its write landed.
      const markApproved = async () => {
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
      };

      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const resourceType = inner.resourceType;
      const audience = inner.audience;
      const ownerUserId = proposal.subjectUserId;

      // A BATCH PUBLISH into a site (D5) files the same floored door with
      // `op: "publish_records"` and ids only. EVERY record is re-planned NOW
      // on the proposal's SUBJECT through the SAME `planSitePublish` the
      // direct door runs (policy, project membership, slug), so a policy
      // tightened or a record moved while the proposal waited is skipped,
      // never published. The site-level checks refuse the whole approval. An
      // approved member is live at once: the site's token addresses it.
      if (inner.op === "publish_records") {
        const entityIds = inner.entityIds;
        if (
          audience !== "public" ||
          typeof inner.siteId !== "string" ||
          !Array.isArray(entityIds) ||
          entityIds.length === 0 ||
          entityIds.length > SITE_PUBLISH_MAX_RECORDS ||
          !entityIds.every((id) => typeof id === "string")
        ) {
          throw refuse("the stored site publish request is malformed.");
        }
        if (!ownerUserId) {
          throw refuse(
            "the proposal records no owner (subject_user_id), so whose site this is cannot be established."
          );
        }
        const database = await getDb();
        const plan = await planSitePublish(database, ownerUserId, {
          siteId: inner.siteId,
          entityIds: entityIds as string[],
        });
        const applied = await applySitePublish(database, plan, {
          userId: ownerUserId,
          agentUserId: proposal.agentUserId ?? null,
          sourceProposalId: input.proposalId,
        });
        await markApproved();
        // `refusals` is the receipt's honest partial-application field: the
        // records approval did NOT publish, each with the reason.
        const refusals = [...plan.skipped, ...applied.skipped].map(
          (k) => `Record ${k.entityId} was not published: ${k.reason}`
        );
        return {
          success: true,
          primaryId: plan.siteId,
          effect:
            applied.rowsWritten > 0
              ? {
                  applied: "verified" as const,
                  rows: applied.rowsWritten,
                  ids: applied.ids,
                  subject: "share",
                }
              : {
                  applied: "none" as const,
                  reason:
                    "None of the records could be published now; see the refusals.",
                },
          ...(refusals.length > 0 ? { refusals } : {}),
        };
      }

      // A SITE (a published project, `site-service.ts`) files the same floored
      // door with `op: "configure_site"`. Replayed through the SAME
      // `planSite` the direct door runs, on the proposal's SUBJECT, and
      // written WITHOUT a token: the site stays draft until the signed-in
      // owner puts it live (an agent never holds the public secret).
      if (inner.op === "configure_site") {
        if (
          audience !== "public" ||
          typeof inner.projectId !== "string" ||
          (inner.homeWorkspaceId !== undefined &&
            inner.homeWorkspaceId !== null &&
            typeof inner.homeWorkspaceId !== "string")
        ) {
          throw refuse("the stored site request is malformed.");
        }
        if (!ownerUserId) {
          throw refuse(
            "the proposal records no owner (subject_user_id), so whose site this is cannot be established."
          );
        }
        const database = await getDb();
        const plan = await planSite(database, ownerUserId, {
          projectId: inner.projectId,
          homeWorkspaceId: (inner.homeWorkspaceId as string | null) ?? null,
          config: inner.config,
        });
        const site = await applyConfigureSite(database, plan, {
          userId: ownerUserId,
          agentUserId: proposal.agentUserId ?? null,
          sourceProposalId: input.proposalId,
        });
        await markApproved();
        return {
          success: true,
          primaryId: site.siteId,
          effect: {
            applied: "verified" as const,
            rows: site.rowsWritten,
            subject: "share",
          },
        };
      }

      // PUBLISH files the same floored door with `audience: "public"`.
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
        await markApproved();
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

      await markApproved();
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
