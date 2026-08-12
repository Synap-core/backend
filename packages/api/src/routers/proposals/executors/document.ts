import {
  db,
  proposals,
  DocumentRepository,
  eventRepository,
  type CreateDocumentInput,
  eq,
  normalizeDocumentType,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { storage } from "@synap/storage";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

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

      // External URL reference: no bytes to store. Mirror the auto-approved
      // external branch in documents.ts (storageUrl = url, storageKey = NULL,
      // metadata.external = true) — skip the MinIO upload + version snapshot
      // entirely. Without this, an approved external-reference proposal would
      // wrongly upload empty content and build a normal content document.
      // Route both branches through the ONE document door
      // (DocumentRepository.create) instead of raw inserts — killing the
      // hand-inlined uploadDocumentVersionSnapshot + documentVersions insert.
      // BEHAVIOR NOTE: create() emits `document.create.completed` (which the prior
      // raw inserts did NOT) and defaults the row's provenance columns (previously
      // NULL). The approval/proposal-status flow below is untouched.
      const docRepo = new DocumentRepository(db, eventRepository);
      if (typeof data.url === "string" && data.url) {
        const docUserId = (data.userId as string) || userId;
        await docRepo.create(
          {
            id: documentId,
            title: (data.title as string) || "Untitled",
            type: normalizeDocumentType(
              (data.type as string) || "markdown",
              "markdown"
            ) as CreateDocumentInput["type"],
            storageUrl: data.url,
            storageKey: null,
            size: 0,
            mimeType: null,
            metadata: { external: true },
            userId: docUserId,
            workspaceId: proposal.workspaceId,
            sourceProposalId: input.proposalId,
          },
          docUserId
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

        // Report to IS telemetry (fire-and-forget — never blocks)
        reportApproved(deps, proposal, input.proposalId);

        deps.emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      const docType = normalizeDocumentType(
        (data.type as string) || "markdown",
        "markdown"
      );
      const extension = docType === "markdown" ? "md" : docType;
      const content = (data.content as string) || "";
      const docUserId = (data.userId as string) || userId;
      const storageKey = storage.buildPath(
        docUserId,
        "document",
        documentId,
        extension
      );
      const mimeType =
        docType === "html"
          ? "text/html"
          : docType === "code"
            ? "text/plain"
            : "text/markdown";
      const metadata = await storage.upload(storageKey, content, {
        contentType: mimeType,
      });

      // ONE door: create() writes the row + the immutable v1 snapshot atomically
      // (its `content` arg replaces the hand-inlined uploadDocumentVersionSnapshot
      // + documentVersions insert). The row's mimeType stays "text/markdown"
      // exactly as the prior raw insert (the computed `mimeType` above is only the
      // storage content-type, unchanged). Provenance stamped from the proposal.
      await docRepo.create(
        {
          id: documentId,
          title: (data.title as string) || "Untitled",
          type: docType as CreateDocumentInput["type"],
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/markdown",
          userId: docUserId,
          workspaceId: proposal.workspaceId,
          content, // → writes the v1 document_versions snapshot
          sourceProposalId: input.proposalId,
        },
        docUserId
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
