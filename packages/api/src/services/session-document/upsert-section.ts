/**
 * The SECTION WRITE DOOR for a session document — write ONE narrative section
 * by id, never the whole document.
 *
 * Refusals, all BEFORE any write:
 *   - the section is human-owned and the writer is an agent (FORBIDDEN) — the AI
 *     never rewrites a person's section;
 *   - the document is no longer at the version the writer read (CONFLICT);
 *   - the document's sections cannot be located reliably (PRECONDITION_FAILED):
 *     a duplicate id, or a section that never closes.
 *
 * Governance: every write goes through `checkPermissionOrPropose` under one of
 * the two keys in `governance-keys.ts`. An auto-approved write applies here; a
 * proposed one is applied by the `document/*section*` executors, which re-run
 * the same checks against the document AS IT IS AT APPROVAL.
 *
 * Undo: every applied write returns the version row holding the content from
 * before the write (created on the spot when the document had no row for its
 * current version). Restoring it is the existing `documents.restoreVersion`.
 */

import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  desc,
  eq,
  documents,
  documentVersions,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
} from "@synap/database";
import { storage } from "@synap/storage";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertDocumentBaseVersion } from "../../utils/document-base-version.js";
import {
  parseSections,
  sectionOwner,
  upsertSectionInMarkdown,
  SectionBodyError,
  type SectionOwner,
} from "./sections.js";
import {
  findSessionDocumentId,
  getOrCreateSessionDocument,
  loadOwnedSession,
  sessionStateStamp,
} from "./session-document.js";
import {
  SECTION_UPDATE_ACTION,
  SESSION_NARRATIVE_ACTION,
} from "./governance-keys.js";

export const SECTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type DocumentRow = {
  id: string;
  userId: string;
  type: string;
  mimeType: string | null;
  storageKey: string | null;
  currentVersion: number;
};

async function loadDocument(documentId: string): Promise<DocumentRow> {
  const [doc] = await db
    .select({
      id: documents.id,
      userId: documents.userId,
      type: documents.type,
      mimeType: documents.mimeType,
      storageKey: documents.storageKey,
      currentVersion: documents.currentVersion,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  }
  if (!doc.storageKey) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This document has no stored content to write sections into.",
    });
  }
  return doc;
}

async function readContent(doc: DocumentRow): Promise<string> {
  return (await storage.downloadBuffer(doc.storageKey!)).toString("utf-8");
}

export interface SectionDraft {
  sectionId: string;
  title: string;
  body: string;
  /** Stamps written onto the section: owner, author, writtenAt, sessionState. */
  attributes: {
    owner: SectionOwner;
    author: string;
    writtenAt: string;
    sessionState: string;
    /** Optional section status (markdown-engine `synap-section` allowlist). */
    status?: string;
  };
}

/**
 * Render `draft` into `content`, enforcing the ownership and well-formedness
 * refusals. `writerIsAgent` is what the ownership rule keys on.
 */
export function renderSectionWrite(
  content: string,
  draft: SectionDraft,
  writerIsAgent: boolean
): { markdown: string; replaced: boolean } {
  const parsed = parseSections(content);
  if (parsed.unterminatedId || parsed.duplicateIds.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: parsed.unterminatedId
        ? `Section "${parsed.unterminatedId}" is never closed, so sections cannot be located safely. A person needs to fix the document first.`
        : `Section id "${parsed.duplicateIds[0]}" appears more than once. A person needs to fix the document first.`,
    });
  }
  const existing = parsed.sections.find((s) => s.id === draft.sectionId);
  if (writerIsAgent && existing && sectionOwner(existing) === "human") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Section "${draft.sectionId}" belongs to a person, and the AI never rewrites a person's section. Write a new section instead.`,
    });
  }
  try {
    return upsertSectionInMarkdown(content, parsed, {
      id: draft.sectionId,
      title: draft.title,
      body: draft.body,
      attributes: draft.attributes,
    });
  } catch (err) {
    if (err instanceof SectionBodyError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

export interface AppliedSectionWrite {
  version: number;
  versionId: string;
  /** The version row holding the content from before this write. */
  undoVersionId: string;
}

/**
 * Write `newContent` as version `baseVersion + 1`. The version claim is a
 * compare-and-set on `current_version` inside one transaction, so a concurrent
 * writer that read the same base gets CONFLICT and uploads nothing.
 */
async function applySectionWrite(args: {
  doc: DocumentRow;
  baseVersion: number;
  baseContent: string;
  newContent: string;
  author: { kind: "ai" | "system" | "user"; id: string };
  message: string;
}): Promise<AppliedSectionWrite> {
  const { doc, baseVersion, baseContent, newContent, author, message } = args;
  const mimeType = doc.mimeType || "text/markdown";
  const nextVersion = baseVersion + 1;

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(documents)
      .set({
        currentVersion: nextVersion,
        lastSavedVersion: nextVersion,
        updatedAt: new Date(),
      })
      .where(
        and(eq(documents.id, doc.id), eq(documents.currentVersion, baseVersion))
      )
      .returning({ id: documents.id });
    if (claimed.length === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This document changed while the section was being written. Nothing was applied — reload and write the section again.",
      });
    }

    const [preImage] = await tx
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, doc.id),
          eq(documentVersions.version, baseVersion)
        )
      )
      .orderBy(desc(documentVersions.createdAt))
      .limit(1);
    let undoVersionId = preImage?.id;
    if (!undoVersionId) {
      undoVersionId = randomUUID();
      const snapshot = await uploadDocumentVersionSnapshot({
        userId: doc.userId,
        documentId: doc.id,
        versionId: undoVersionId,
        documentType: doc.type,
        mimeType,
        content: baseContent,
      });
      await tx.insert(documentVersions).values({
        id: undoVersionId,
        documentId: doc.id,
        version: baseVersion,
        ...storedVersionValues(snapshot),
        author: "system",
        authorId: author.id,
        message: "Checkpoint before a section write",
      });
    }

    await storage.upload(doc.storageKey!, Buffer.from(newContent, "utf-8"), {
      contentType: mimeType,
    });
    const versionId = randomUUID();
    const snapshot = await uploadDocumentVersionSnapshot({
      userId: doc.userId,
      documentId: doc.id,
      versionId,
      documentType: doc.type,
      mimeType,
      content: newContent,
    });
    await tx.insert(documentVersions).values({
      id: versionId,
      documentId: doc.id,
      version: nextVersion,
      ...storedVersionValues(snapshot),
      author: author.kind,
      authorId: author.id,
      message,
    });

    return { version: nextVersion, versionId, undoVersionId };
  });
}

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
   * for an agent: a person's section is never rewritten. Governance runs on
   * the owner's principal, as for any write the owner's own pod makes.
   * Ignored when `agentUserId` is set.
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
   */
  baseVersion: number | null;
  reasoning?: string;
  sourceMessageId?: string;
}

export type UpsertSessionSectionResult =
  | {
      status: "applied";
      documentId: string;
      version: number;
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
  const systemAuthor = agentUserId ? null : (input.systemAuthor ?? null);
  // A system writer is machine-owned: same ownership rule as an agent.
  const writerIsAgent = Boolean(agentUserId) || Boolean(systemAuthor);

  let documentId = await findSessionDocumentId(session.id);
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
  } else if (input.baseVersion === null) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This session already has a document. Read it and pass its current version as baseVersion.",
    });
  }

  const doc = await loadDocument(documentId);
  const baseVersion = input.baseVersion ?? doc.currentVersion;
  assertDocumentBaseVersion(baseVersion, doc.currentVersion);

  const draft: SectionDraft = {
    sectionId: input.sectionId,
    title: input.title,
    body: input.body,
    attributes: {
      owner: writerIsAgent ? "ai" : "human",
      author: agentUserId ?? systemAuthor ?? input.userId,
      writtenAt: new Date().toISOString(),
      sessionState: sessionStateStamp(session),
      ...(input.status ? { status: input.status } : {}),
    },
  };
  const baseContent = await readContent(doc);
  const rendered = renderSectionWrite(baseContent, draft, writerIsAgent);

  const ownSession =
    Boolean(agentUserId) && input.ambientSessionId === session.id;
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    ...(agentUserId ? { agentUserId, source: "intelligence" as const } : {}),
    workspaceId: session.workspaceId ?? undefined,
    subjectType: "document",
    action: ownSession ? SESSION_NARRATIVE_ACTION : SECTION_UPDATE_ACTION,
    sessionId: session.id,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.sourceMessageId
      ? { sourceMessageId: input.sourceMessageId }
      : {}),
    data: {
      documentId,
      sessionId: session.id,
      ...draft,
      baseVersion,
    },
  });

  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      documentId,
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
      ...(perm.deduped ? { deduped: true } : {}),
    };
  }

  const applied = await applySectionWrite({
    doc,
    baseVersion,
    baseContent,
    newContent: rendered.markdown,
    author: agentUserId
      ? { kind: "ai", id: agentUserId }
      : systemAuthor
        ? { kind: "system", id: systemAuthor }
        : { kind: "user", id: input.userId },
    message: `Section "${draft.title.trim()}" written`,
  });
  return {
    status: "applied",
    documentId,
    version: applied.version,
    replaced: rendered.replaced,
    undo: { documentId, versionId: applied.undoVersionId },
    ...("autoApprovedProposalId" in perm && perm.autoApprovedProposalId
      ? { autoApprovedProposalId: perm.autoApprovedProposalId }
      : {}),
  };
}

/**
 * Apply an APPROVED section proposal against the document as it is now. The
 * proposal carries the draft and the base version it was drafted against; any
 * movement since is a CONFLICT (the approval dispatch records it as a failed
 * approval, with this message as the reason).
 */
export async function applyApprovedSectionProposal(
  proposal: {
    targetId: string;
    agentUserId: string | null;
    data: unknown;
  },
  approverUserId: string
): Promise<AppliedSectionWrite & { documentId: string }> {
  const raw = (proposal.data ?? {}) as Record<string, unknown>;
  const inner = (
    raw.data && typeof raw.data === "object" ? raw.data : raw
  ) as Record<string, unknown>;
  const baseVersion = inner.baseVersion;
  const attributes = inner.attributes as SectionDraft["attributes"] | undefined;
  if (
    typeof baseVersion !== "number" ||
    typeof inner.sectionId !== "string" ||
    typeof inner.title !== "string" ||
    typeof inner.body !== "string" ||
    !attributes
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Section proposal is missing its draft or base version.",
    });
  }

  const doc = await loadDocument(proposal.targetId);
  assertDocumentBaseVersion(baseVersion, doc.currentVersion);
  const baseContent = await readContent(doc);
  const writerIsAgent = Boolean(proposal.agentUserId);
  const rendered = renderSectionWrite(
    baseContent,
    {
      sectionId: inner.sectionId,
      title: inner.title,
      body: inner.body,
      attributes,
    },
    writerIsAgent
  );
  const applied = await applySectionWrite({
    doc,
    baseVersion,
    baseContent,
    newContent: rendered.markdown,
    // PROVENANCE: the agent drafted the words; the approver is on the proposal.
    author: writerIsAgent
      ? { kind: "ai", id: proposal.agentUserId! }
      : { kind: "user", id: approverUserId },
    message: `Section "${inner.title.trim()}" written (approved)`,
  });
  return { ...applied, documentId: doc.id };
}

/** Read side: the session's document, its version, and each section's stamps. */
export async function readSessionDocument(input: {
  sessionId: string;
  userId: string;
}): Promise<{
  documentId: string | null;
  version: number | null;
  content: string | null;
  sections: Array<{
    id: string;
    owner: SectionOwner;
    author: string | null;
    writtenAt: string | null;
    sessionState: string | null;
  }>;
}> {
  const session = await loadOwnedSession(input.sessionId, input.userId);
  const documentId = await findSessionDocumentId(session.id);
  if (!documentId) {
    return { documentId: null, version: null, content: null, sections: [] };
  }
  const doc = await loadDocument(documentId);
  const content = await readContent(doc);
  return {
    documentId,
    version: doc.currentVersion,
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
