/**
 * Approve-executor for `app/connect` — the approval half of
 * `POST /api/hub/apps/:id/connect` (App Connect v1, 2026-10-06).
 *
 * The app ASKED for reach; this records the human's answer on the app
 * (`apps.approved_requests`). It mints NOTHING — the bearer key is minted on
 * demand by `POST /apps/:id/key`, so no plaintext ever rests in a proposal.
 * Approval is the truth: a key the app already holds is re-derived from the
 * new approval at once (`applyApprovedReach` — its grants and the app agent's
 * memberships), so a narrowed approval narrows the live key.
 *
 * IDENTITY: only the app's OWNER may approve. `app/connect` is filed by the
 * owner's CLI, but the default `owner_and_admins` policy could let a workspace
 * admin approve — and this write grants the app reach, so a non-owner approver
 * gets a loud FORBIDDEN, never a silent no-op. A REVOKED app is refused
 * (CONFLICT): approving cannot hand reach back to it.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  AppRepository,
  readAppConnectRequests,
  APP_EVENT_ACTIONS,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import { auditLog } from "../../../utils/audit-log.js";
import { applyApprovedReach } from "../../../services/app-connect.js";

export function registerAppExecutors(): void {
  registerProposalExecutor({
    key: "app/connect",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const appId =
        (inner.appId as string | undefined) ?? proposal.targetId ?? undefined;
      if (!appId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "App connect proposal is missing the app id — file the request again.",
        });
      }

      const requests = readAppConnectRequests(raw);
      if (requests.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "App connect proposal has no requests — file the request again.",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const repo = new AppRepository(db);
      const app = await repo.get(appId);
      if (!app) {
        throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
      }
      if (app.ownerUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the app's owner can approve what it may touch",
        });
      }
      // A revoked app's request is withdrawn on revoke; one approved anyway
      // (a stale link) must not hand reach back to an app that has none.
      if (app.revokedAt) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This app was revoked — register it again to ask for access.",
        });
      }

      const updated = await repo.setApprovedRequests(appId, requests);
      if (!updated) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not record the app's approved requests.",
        });
      }
      // Before the proposal is marked approved: if this throws, the proposal
      // stays pending and a retry re-applies (idempotent) — never an approved
      // proposal whose live key still holds the old reach.
      const rederivedKeys = await applyApprovedReach(appId);

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // The app's own timeline: "Approved by you" (`events.read({ appId })`).
      await auditLog({
        subjectType: "app",
        action: APP_EVENT_ACTIONS.approved,
        phase: "completed",
        subjectId: app.id,
        userId,
        workspaceId: null,
        appId: app.publicId,
        data: {
          name: app.name,
          publicId: app.publicId,
          proposalId: input.proposalId,
          requests,
          rederivedKeys,
        },
      });

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return {
        success: true,
        primaryId: appId,
        effect: { applied: "verified", rows: 1, ids: [appId], subject: "apps" },
      };
    },
  });
}
