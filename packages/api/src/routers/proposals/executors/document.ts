import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import { materializeApprovedDocument } from "../../../services/proposals/materialize-approved-document.js";
import { applyApprovedSectionProposal } from "../../../services/session-document/upsert-section.js";

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

  // ── document / section_update + session_narrative_update ───────────────────
  // The approval half of the session-document section write door. Re-applies
  // the drafted section against the document AS IT IS NOW: a base-version move,
  // a section a person now owns, or a malformed document throws, and the
  // shared dispatch records that as the failed approval's reason — nothing is
  // written.
  for (const key of [
    "document/section_update",
    "document/session_narrative_update",
  ] as const) {
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

        const applied = await applyApprovedSectionProposal(proposal, userId);

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
