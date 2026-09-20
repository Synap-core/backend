import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { ProposalMaterializedRecord } from "@synap-core/types";
import { createAndLinkPropertyDef } from "../../../services/profiles/create-and-link-property-def.js";
import { updatePropertyDef } from "../../../services/profiles/update-property-def.js";
import {
  registerProposalExecutor,
  type StoredProposalData,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the property_def/* approve executors. */
export function registerPropertyDefExecutors(): void {
  // ── property_def / create ───────────────────────────────────────────────────
  // A gated createPropertyDef (AI caller outside DEFAULT_AUTO_APPROVE, or a
  // SAFE-mode workspace) lands here on approval. Uses the SAME
  // `createAndLinkPropertyDef` helper as the direct-apply branch in
  // hub-protocol/profiles.ts#createPropertyDef, so approval always performs
  // BOTH the property-def create AND the profile_properties link — a
  // property def is invisible to its profile until linked.
  registerProposalExecutor({
    key: "property_def/create",
    async execute({ proposal, payload, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const proposalWorkspaceId = proposal.workspaceId || null;
      const workspaceId =
        (innerData.workspaceId as string | undefined) ?? proposalWorkspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Property def proposal is missing workspaceId",
        });
      }

      await createAndLinkPropertyDef({
        userId,
        workspaceId,
        profileId: innerData.profileId as string | undefined,
        slug: innerData.slug as string,
        valueType: innerData.valueType as
          | "string"
          | "number"
          | "boolean"
          | "object"
          | "array"
          | "date"
          | "secret"
          | "entity_id",
        constraints: innerData.constraints as
          Record<string, unknown> | undefined,
        uiHints: innerData.uiHints as Record<string, unknown> | undefined,
        overlay: innerData.overlay === true,
        required: innerData.required as boolean | undefined,
        defaultValue: innerData.defaultValue,
        displayOrder: innerData.displayOrder as number | undefined,
      });

      // No revert path exists for property_def creates (mirrors "no delete
      // endpoints exposed to agents" — see module docstring), so `materialized`
      // is intentionally left empty rather than misusing `entityIds`/
      // `documentIds` for a row type ProposalMaterializedRecord has no field
      // for; revert correctly reports "unsupported" for this proposal type.
      const materialized: ProposalMaterializedRecord = {};
      const approvedPayload: StoredProposalData = {
        ...(payload as StoredProposalData),
        materialized,
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: approvedPayload,
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

  // ── property_def / update ───────────────────────────────────────────────────
  // The approval half of the EDIT door (hub-protocol/profiles.ts#updatePropertyDef).
  // Without it an approved `property_def/update` would hit the catch-all's
  // honesty gate and land APPROVAL_FAILED — loud, but useless. Uses the SAME
  // `updatePropertyDef` helper as the direct-apply branch, which delegates to
  // `propertyDefs.update` and therefore re-runs the row's owner gate and the
  // slug-conflict check AT APPROVAL TIME (a proposal can sit for days; the def
  // may have been renamed or re-owned since it was filed).
  registerProposalExecutor({
    key: "property_def/update",
    async execute({ proposal, payload, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const workspaceId =
        (innerData.workspaceId as string | undefined) ||
        proposal.workspaceId ||
        null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Property def update proposal is missing workspaceId",
        });
      }
      const propertyDefId = innerData.propertyDefId as string | undefined;
      if (!propertyDefId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Property def update proposal is missing propertyDefId",
        });
      }

      await updatePropertyDef({
        userId,
        workspaceId,
        propertyDefId,
        ...(typeof innerData.slug === "string" ? { slug: innerData.slug } : {}),
        ...(typeof innerData.valueType === "string"
          ? {
              valueType: innerData.valueType as
                | "string"
                | "number"
                | "boolean"
                | "object"
                | "array"
                | "date"
                | "secret"
                | "entity_id",
            }
          : {}),
        ...(innerData.constraints !== undefined
          ? { constraints: innerData.constraints as Record<string, unknown> }
          : {}),
        ...(innerData.uiHints !== undefined
          ? { uiHints: innerData.uiHints as Record<string, unknown> }
          : {}),
      });

      // Same as create: `ProposalMaterializedRecord` has no field for a
      // property-def row, and no revert path exists — so `materialized` stays
      // empty rather than misusing `entityIds`.
      const materialized: ProposalMaterializedRecord = {};
      const approvedPayload: StoredProposalData = {
        ...(payload as StoredProposalData),
        materialized,
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: approvedPayload,
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
