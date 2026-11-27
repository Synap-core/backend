import { db, proposals, eq, transitionProposal } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { registerProposalExecutor } from "../execution-registry.js";
import { readDeclaredFrameIo } from "../../../services/cells/declared-frame-io.js";
import { reportApproved, storedProposalFields } from "./shared.js";
import { materializeApprovedDocument } from "../../../services/proposals/materialize-approved-document.js";
import { placeHtmlPage } from "../../../services/cells/create-cell-instance.js";
import { DOCUMENT_PATCH_PROPOSAL_TYPES } from "@synap-core/types/proposals/intent";
import { applyApprovedDocumentPatch } from "../../../services/document-patch/apply-document-patch.js";
import { stampMaterialized } from "../../../services/proposals/stamp-materialized.js";
import {
  podDocumentScopeFloor,
  resolveDocumentScopeFields,
} from "../../../services/document-scope/document-scope.js";

/** The `metadata.reads` an approved html page stores, re-checked. */
function declaredPageReadsOf(data: Record<string, unknown>): {
  metadata?: Record<string, unknown>;
} {
  if (data.reads === undefined || data.reads === null) return {};
  const parsed =
    data.type === "html"
      ? readDeclaredFrameIo({ reads: data.reads })
      : ({ ok: false, error: "only an html page declares reads" } as const);
  if (!parsed.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `This document proposal declares reads a page may not ask (${parsed.error}), and nothing was written.`,
    });
  }
  return parsed.reads ? { metadata: { reads: parsed.reads } } : {};
}

interface PlaceAsRider {
  cellId?: string;
  name?: string;
  agentUserId: string | null;
}

/**
 * The html-embed cell rider an approved page carries (`data.placeAs`, put on
 * the proposal by the Hub document door for the cell routes), or null. Read
 * BEFORE anything is written: only an html page in a space is placed.
 */
function placeAsRiderOf(
  data: Record<string, unknown>,
  workspaceId: string | null
): PlaceAsRider | null {
  const rider = data.placeAs as
    | {
        kind?: unknown;
        cellId?: unknown;
        name?: unknown;
        agentUserId?: unknown;
      }
    | undefined;
  if (!rider || rider.kind !== "html-embed-cell") return null;
  if (data.type !== "html" || !workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This document proposal places a cell, but only an html page in a space is placed as a cell; nothing was written.",
    });
  }
  return {
    ...(typeof rider.cellId === "string" ? { cellId: rider.cellId } : {}),
    ...(typeof rider.name === "string" ? { name: rider.name } : {}),
    agentUserId:
      typeof rider.agentUserId === "string" ? rider.agentUserId : null,
  };
}

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
      const data = storedProposalFields(proposal);
      const documentId = proposal.targetId;

      // The writer is shared with a connected plan's `create_document` step
      // (`materializeApprovedDocument`): an external URL reference (storageKey
      // NULL, metadata.external) or an uploaded body, both through the ONE
      // document door (DocumentRepository.create), which emits
      // `document.create.completed`. Provenance stamped from the proposal.
      const docUserId = (data.userId as string) || userId;
      // A scope / refresher the proposal carries, re-read through the floor
      // as the owner: what it named may be gone or hidden since filing.
      const fields = await resolveDocumentScopeFields(
        {
          ...(data.scope !== undefined ? { scope: data.scope } : {}),
          ...(data.refreshAutomationId !== undefined
            ? { refreshAutomationId: data.refreshAutomationId }
            : {}),
        },
        podDocumentScopeFloor(docUserId)
      );
      const rider = placeAsRiderOf(data, proposal.workspaceId);
      const created = await materializeApprovedDocument({
        documentId,
        title: (data.title as string) || "Untitled",
        type: (data.type as string) || "markdown",
        content: (data.content as string) || "",
        url: typeof data.url === "string" ? data.url : null,
        userId: docUserId,
        workspaceId: proposal.workspaceId,
        sourceProposalId: input.proposalId,
        fields,
        // An html page's declared reads (`documents.metadata.reads`), carried
        // by the create door; re-checked against the ceiling, never trusted.
        ...declaredPageReadsOf(data),
      });

      // A page filed by the html-embed cell routes is placed as its cell now,
      // under the id reserved at filing (idempotent: a re-approval finds it).
      const placed = rider
        ? (
            await placeHtmlPage({
              ...(rider.cellId ? { id: rider.cellId } : {}),
              documentId: created.id,
              workspaceId: proposal.workspaceId!,
              userId: docUserId,
              ...(rider.name ? { name: rider.name } : {}),
              agentUserId: rider.agentUserId,
            })
          ).id
        : null;

      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        where: eq(proposals.id, input.proposalId),
      });

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      // The id the document was written under (the proposal's targetId): the
      // review page links "Open document" from it, like a patch's `documentId`.
      return {
        success: true,
        primaryId: created.id,
        created: placed ? 2 : 1,
        effect: placed
          ? {
              applied: "verified",
              rows: 2,
              ids: [created.id, placed],
              subject: "documents+cell_instances",
            }
          : {
              applied: "verified",
              rows: 1,
              ids: [created.id],
              subject: "documents",
            },
      };
    },
  });

  // ── document / update · section_update · session_narrative_update · refresher_section_update · user_edit ─
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

        // One statement: the status flip and the undo record (what this
        // approval changed, before and after) land together — the
        // `entity/update` precedent. Undo puts back only what still holds
        // what this write left (decision 6c5e9642).
        await stampMaterialized({
          proposalId: input.proposalId,
          record: { documentEdit: applied.edit },
          baseData: (proposal.data ?? null) as Record<string, unknown> | null,
          transition: {
            to: ProposalStatus.APPROVED,
            set: {
              reviewedBy: userId,
              reviewedAt: new Date(),
              updatedAt: new Date(),
            },
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
          primaryId: applied.documentId,
          // A rename-only patch writes the document row and cuts no version.
          effect: applied.versionId
            ? {
                applied: "verified",
                rows: 1,
                ids: [applied.versionId],
                subject: "document_versions+documents",
              }
            : {
                applied: "verified",
                rows: 1,
                ids: [applied.documentId],
                subject: "documents",
              },
        };
      },
    });
  }
}
