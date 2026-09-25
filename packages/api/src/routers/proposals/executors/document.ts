import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import { materializeApprovedDocument } from "../../../services/proposals/materialize-approved-document.js";
import { DOCUMENT_PATCH_PROPOSAL_TYPES } from "@synap-core/types/proposals/intent";
import { applyApprovedDocumentPatch } from "../../../services/document-patch/apply-document-patch.js";

/** Register the document/* approve executors. */
export function registerDocumentExecutors(): void {
  // ── document / create ──────────────────────────────────────────────────────
  // (B3 document-content + the composite guard stay INLINE in proposals.ts
  // before the registry lookup, since they key off payload shape, not a type
  // string.)
  registerProposalExecutor({
    key: "document/create",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const documentId = proposal.targetId;

      // The writer is shared with a connected plan's `create_document` step
      // (`materializeApprovedDocument`): an external URL reference (storageKey
      // NULL, metadata.external) or an uploaded body, both through the ONE
      // document door (DocumentRepository.create), which emits
      // `document.create.completed`. Provenance stamped from the proposal.
      const docUserId = (data.userId as string) || userId;
      await materializeApprovedDocument({
        documentId,
        title: (data.title as string) || "Untitled",
        type: (data.type as string) || "markdown",
        content: (data.content as string) || "",
        url: typeof data.url === "string" ? data.url : null,
        userId: docUserId,
        workspaceId: proposal.workspaceId,
        sourceProposalId: input.proposalId,
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

  // ── document / update · section_update · session_narrative_update · user_edit ─
  // The approval half of the document patch door (`applyDocumentPatch`). Re-
  // renders the proposal's ops against the document AS IT IS NOW: a base move,
  // a section a person now owns, an embed the ops would drop, or a malformed
  // document throws, and the shared dispatch records that as the failed
  // approval's reason — nothing is written. `user_edit` is a person's
  // suggestion (filed direct); one filed before W4b carries `proposedContent`
  // and is applied by the inline B3 branch before this registry is consulted.
  // Derived from the ONE list the pod's patch door files under, which is also
  // what review surfaces (the session room's "Accepted" stamp) key on.
  for (const type of DOCUMENT_PATCH_PROPOSAL_TYPES) {
    const key = `document/${type}` as const;
    registerProposalExecutor({
      key,
      async execute({ proposal, userId, input, deps }) {
        const [alreadyDone] = await db
          .select({ status: proposals.status })
          .from(proposals)
          .where(eq(proposals.id, input.proposalId));
        if (alreadyDone?.status === ProposalStatus.APPROVED) {
          return { success: true, alreadyApproved: true };
        }

        const applied = await applyApprovedDocumentPatch(proposal, userId);

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
          primaryId: applied.documentId,
          effect: {
            applied: "verified",
            rows: 1,
            ids: [applied.versionId],
            subject: "document_versions+documents",
          },
        };
      },
    });
  }
}
