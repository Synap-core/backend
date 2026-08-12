import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { ProposalMaterializedRecord } from "@synap-core/types";
import { createAndLinkPropertyDef } from "../../../services/profiles/create-and-link-property-def.js";
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
}
