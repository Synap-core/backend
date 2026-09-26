/**
 * The SESSION section door — write ONE narrative section of a session's
 * document, by id. An ALIAS onto `applyDocumentPatch` (the one AI document
 * edit door, `services/document-patch`): this file only resolves the session
 * (owned by the caller), finds or creates its designated document, and hands
 * the door one `upsert_section` op with the session's stamps.
 *
 * Everything else — the ownership refusal (the AI never rewrites a person's
 * section), the base check (CONFLICT), the unlocatable-section refusal
 * (PRECONDITION_FAILED), governance under `document.section_update` /
 * `document.session_narrative_update` (the D10 rule), the write through
 * `claimDocumentRevision`, the undo checkpoint and the approval half — is the
 * door's, and is the same for every document edit.
 */

import { TRPCError } from "@trpc/server";
import {
  applyDocumentPatch,
  loadPatchDocument,
  readPatchDocumentContent,
} from "../document-patch/apply-document-patch.js";
import { SECTION_ID_RE } from "../document-patch/patch-ops.js";
import { parseSections, sectionOwner, type SectionOwner } from "./sections.js";
import {
  findSessionDocumentId,
  getOrCreateSessionDocument,
  loadOwnedSession,
  loadReadableSession,
  sessionStateStamp,
} from "./session-document.js";

export interface UpsertSessionSectionInput {
  /** The human principal the request acts for. Must own the session. */
  userId: string;
  /** Present ⇒ an agent is writing, and the ownership rule applies. */
  agentUserId?: string | null;
  /**
   * The pod itself is writing a machine-owned section (e.g.
   * `system:closing-report`) on the owner's behalf — a deterministic
   * projection of stored facts, no model in the loop. The section is stamped
   * `owner="ai"` with this author, and the ownership rule applies exactly as
   * for an agent. Governance runs on the owner's principal. Ignored when
   * `agentUserId` is set.
   */
  systemAuthor?: string;
  /** Optional `status` stamp for the section (e.g. a verdict state). */
  status?: string;
  sessionId: string;
  /**
   * The session the caller is VERIFIABLY working in (the ownership-checked
   * `X-Session-Id` / MCP ambient session) — never a request-body field. Only a
   * write to this session's own document can earn the narrative rule.
   */
  ambientSessionId?: string | null;
  sectionId: string;
  title: string;
  body: string;
  /**
   * The document version the writer read. `null` asserts the session has no
   * document yet (it is created). Either assertion failing is a CONFLICT.
   * Legacy: prefer `baseRevision`, which also sees human saves that cut no
   * checkpoint.
   */
  baseVersion: number | null;
  /** The content revision the writer read (`readSessionDocument` returns it). */
  baseRevision?: number;
  reasoning?: string;
  sourceMessageId?: string;
}

export type UpsertSessionSectionResult =
  | {
      status: "applied";
      documentId: string;
      version: number;
      revision: number;
      replaced: boolean;
      undo: { documentId: string; versionId: string };
      autoApprovedProposalId?: string;
    }
  | {
      status: "proposed";
      documentId: string;
      proposalId: string;
      proposalType: string;
      summary: string;
      reviewPath: string;
      reviewUrl: string;
      deduped?: boolean;
    };

export async function upsertSessionDocumentSection(
  input: UpsertSessionSectionInput
): Promise<UpsertSessionSectionResult> {
  if (!SECTION_ID_RE.test(input.sectionId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "sectionId must be lowercase letters, digits, '-' or '_' (max 64), starting with a letter or digit.",
    });
  }
  if (!input.title.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "title is required" });
  }

  const session = await loadOwnedSession(input.sessionId, input.userId);
  const agentUserId = input.agentUserId ?? null;

  let documentId = await findSessionDocumentId(session.id);
  let created = false;
  if (!documentId) {
    if (input.baseVersion !== null) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This session has no document yet. Pass baseVersion: null to create it with this section.",
      });
    }
    const made = await getOrCreateSessionDocument(session, { agentUserId });
    if (!made.created) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "The session document was created by another writer just now. Reload it and write the section again.",
      });
    }
    documentId = made.documentId;
    created = true;
  } else if (input.baseVersion === null) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This session already has a document. Read it and pass its current version as baseVersion.",
    });
  }

  const result = await applyDocumentPatch({
    userId: input.userId,
    agentUserId,
    ...(input.systemAuthor ? { systemAuthor: input.systemAuthor } : {}),
    documentId,
    session: {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      sessionState: sessionStateStamp(session),
      ambientSessionId: input.ambientSessionId ?? null,
    },
    // Just created by this call: nothing else has written it yet, so the
    // door pins the revision it reads.
    ...(input.baseRevision !== undefined
      ? { baseRevision: input.baseRevision }
      : !created && input.baseVersion !== null
        ? { baseVersion: input.baseVersion }
        : {}),
    ops: [
      {
        op: "upsert_section",
        id: input.sectionId,
        title: input.title,
        body: input.body,
        ...(input.status ? { status: input.status } : {}),
      },
    ],
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.sourceMessageId
      ? { sourceMessageId: input.sourceMessageId }
      : {}),
  });

  if (result.status === "proposed") {
    return {
      status: "proposed",
      documentId: result.documentId,
      proposalId: result.proposalId,
      proposalType: result.proposalType,
      summary: result.summary,
      reviewPath: result.reviewPath,
      reviewUrl: result.reviewUrl,
      ...(result.deduped ? { deduped: true } : {}),
    };
  }
  return {
    status: "applied",
    documentId: result.documentId,
    version: result.version,
    revision: result.revision,
    replaced: result.replacedSections.includes(input.sectionId),
    undo: result.undo,
    ...(result.autoApprovedProposalId
      ? { autoApprovedProposalId: result.autoApprovedProposalId }
      : {}),
  };
}

/** Read side: the session's document, its version, and each section's stamps. */
export async function readSessionDocument(input: {
  sessionId: string;
  userId: string;
  /** Honour the human-roster read branch (`sessionReadableWhere`). Default false. */
  roster?: boolean;
}): Promise<{
  documentId: string | null;
  version: number | null;
  /** The content revision — pass it back as `baseRevision` when writing. */
  revision: number | null;
  content: string | null;
  sections: Array<{
    id: string;
    owner: SectionOwner;
    author: string | null;
    writtenAt: string | null;
    sessionState: string | null;
  }>;
}> {
  const session = await loadReadableSession(input.sessionId, input.userId, {
    roster: input.roster,
  });
  const documentId = await findSessionDocumentId(session.id);
  if (!documentId) {
    return {
      documentId: null,
      version: null,
      revision: null,
      content: null,
      sections: [],
    };
  }
  const doc = await loadPatchDocument(documentId);
  const content = await readPatchDocumentContent(doc);
  return {
    documentId,
    version: doc.currentVersion,
    revision: doc.contentRevision,
    content,
    sections: parseSections(content).sections.map((s) => ({
      id: s.id,
      owner: sectionOwner(s),
      author: s.attributes.author ?? null,
      writtenAt: s.attributes.writtenAt ?? null,
      sessionState: s.attributes.sessionState ?? null,
    })),
  };
}
