/**
 * applyDocumentPatch — THE AI document edit door (documents-centerpiece W4b).
 *
 * The session-document section door, generalised from "one section of a
 * session's document" to "any ops on any document". Every agent-facing way to
 * change a document's content lands here:
 *
 *   MCP `synap_update_document` · `synap_update_entity.content` (alias) ·
 *   Hub REST `POST /documents/:id/patch` · `PATCH /documents/:id` (alias) ·
 *   `POST /documents/proposals` (alias) · hub `createDocumentProposal` (alias) ·
 *   IS `update_document` · the session section door (`upsertSessionDocumentSection`)
 *   · a person's "suggest edit" (`proposals.createDocumentEdit`, filed direct).
 *
 * Order, all BEFORE anything is written or proposed:
 *   1. load the document the caller may EDIT (the document's own floor —
 *      `loadEditableDocument`), or the session's document for the session door;
 *   2. check the base the writer read (`baseRevision`; legacy `baseVersion`);
 *   3. render the ops and enforce the floors (`renderDocumentPatch`): exact-once
 *      `replace_text`, no agent change to a human-owned section (replace_all
 *      included), no embed removal without `allowRemovingEmbeds`;
 *   4. diagnose the result (advisory — never rejects);
 *   5. GOVERNANCE via `checkPermissionOrPropose`: a section-only patch files as
 *      `document.section_update` (or `document.session_narrative_update` for an
 *      agent in its own session — the D10 rule), anything else as
 *      `document.update`. No default auto-approve; a `governance_rules` row may
 *      auto-apply (D-gov). An agent `replace_all` is forced to a proposal.
 *
 * An applied patch writes through `claimDocumentRevision` (the ONE content-write
 * door: compare-and-set, author-switch checkpoints, the upload), tells open
 * editors (`document:content-replaced`), re-indexes, and stores its
 * diagnostics stamped with the revision it wrote. A proposed one carries
 * `{ops, baseRevision, preview, diagnostics}`; `applyApprovedDocumentPatch`
 * re-renders it against the document AS IT IS AT APPROVAL and re-diagnoses.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  documents,
  drizzleSql,
  claimDocumentRevision,
  emitDocumentContentReplaced,
} from "@synap/database";
import { storage } from "@synap/storage";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { createEventBackedProposal } from "../../utils/event-backed-proposal.js";
import {
  assertDocumentBaseRevision,
  assertDocumentBaseVersion,
  readProposalBaseRevision,
  readProposalBaseVersion,
} from "../../utils/document-base-version.js";
import { loadEditableDocument } from "../../utils/document-edit-access.js";
import {
  SECTION_UPDATE_ACTION,
  SESSION_NARRATIVE_ACTION,
} from "../session-document/governance-keys.js";
import {
  DocumentPatchOpsSchema,
  isSectionOnlyPatch,
  renderDocumentPatch,
  type DocumentPatchOp,
  type PatchWriter,
  type SectionPreview,
} from "./patch-ops.js";
import {
  diagnoseDocument,
  podEmbedResolver,
  type DocumentDiagnostic,
} from "./document-diagnostics.js";

const logger = createLogger({ module: "document-patch" });

/** The gate action for a full / text patch (a section-only patch uses the section keys). */
export const DOCUMENT_UPDATE_ACTION = "update" as const;

export type PatchDocumentRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  mimeType: string | null;
  storageKey: string | null;
  currentVersion: number;
  contentRevision: number;
};

export async function loadPatchDocument(
  documentId: string
): Promise<PatchDocumentRow> {
  const [doc] = await db
    .select({
      id: documents.id,
      userId: documents.userId,
      workspaceId: documents.workspaceId,
      title: documents.title,
      mimeType: documents.mimeType,
      storageKey: documents.storageKey,
      currentVersion: documents.currentVersion,
      contentRevision: documents.contentRevision,
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
      message:
        "This document has no stored content to edit (an external reference or a whiteboard).",
    });
  }
  return doc;
}

export async function readPatchDocumentContent(
  doc: Pick<PatchDocumentRow, "storageKey">
): Promise<string> {
  return (await storage.downloadBuffer(doc.storageKey!)).toString("utf-8");
}

// ─── Diagnostics storage ─────────────────────────────────────────────────────

/** `documents.metadata.diagnostics` — what was checked, and at which revision. */
export interface StoredDocumentDiagnostics {
  revision: number;
  checkedAt: string;
  items: DocumentDiagnostic[];
}

/**
 * Stamp `items` onto the document ONLY if it is still at `revision` — a stamp
 * must describe the text it checked, never a newer text it did not see.
 * Returns whether the stamp landed.
 */
export async function storeDocumentDiagnostics(
  documentId: string,
  revision: number,
  items: DocumentDiagnostic[]
): Promise<boolean> {
  const stored: StoredDocumentDiagnostics = {
    revision,
    checkedAt: new Date().toISOString(),
    items,
  };
  const patch = JSON.stringify({ diagnostics: stored });
  const rows = await db
    .update(documents)
    .set({
      metadata: drizzleSql`COALESCE(${documents.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
    })
    .where(
      and(eq(documents.id, documentId), eq(documents.contentRevision, revision))
    )
    .returning({ id: documents.id });
  return rows.length > 0;
}

/** The stored diagnostics, when they describe `revision`; otherwise null (never stale ones). */
export function readStoredDiagnostics(
  metadata: unknown,
  revision: number
): DocumentDiagnostic[] | null {
  const d = (metadata as { diagnostics?: StoredDocumentDiagnostics } | null)
    ?.diagnostics;
  return d && d.revision === revision && Array.isArray(d.items)
    ? d.items
    : null;
}

/**
 * Diagnostics are advisory, so a check that could not RUN (a failed catalog or
 * access read) never blocks a write — but it is not an empty list either: it
 * comes back as `{ items: null, error }`, the writer sees "not checked", and
 * nothing is stamped.
 */
export type DiagnosticsOutcome =
  | { items: DocumentDiagnostic[]; error?: undefined }
  | { items: null; error: string };

export async function diagnoseForDocument(
  markdown: string,
  doc: Pick<PatchDocumentRow, "id" | "workspaceId">,
  writerUserId: string
): Promise<DiagnosticsOutcome> {
  try {
    return {
      items: await diagnoseDocument(
        markdown,
        podEmbedResolver({ writerUserId, workspaceId: doc.workspaceId })
      ),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(
      { documentId: doc.id, error },
      "document diagnostics could not run"
    );
    return { items: null, error: `Diagnostics could not run: ${error}` };
  }
}

/** The wire form: `diagnostics` (null = not checked) + the reason when not checked. */
function diagnosticsFields(outcome: DiagnosticsOutcome): {
  diagnostics: DocumentDiagnostic[] | null;
  diagnosticsError?: string;
} {
  return outcome.items
    ? { diagnostics: outcome.items }
    : { diagnostics: null, diagnosticsError: outcome.error };
}

// ─── The write ───────────────────────────────────────────────────────────────

export type PatchBase =
  | { revision: number; version?: undefined }
  | { revision?: undefined; version: number };

export interface AppliedPatchWrite {
  revision: number;
  version: number;
  versionId: string;
  /** The version row holding the content from before this write. */
  undoVersionId: string;
}

async function writePatch(args: {
  doc: PatchDocumentRow;
  base: PatchBase;
  baseContent: string;
  newContent: string;
  author: { kind: "ai" | "system" | "user"; id: string };
  message: string;
  diagnostics: DiagnosticsOutcome;
}): Promise<AppliedPatchWrite> {
  const { doc, base, baseContent, newContent, author, message } = args;
  const claimed = await db.transaction((tx) =>
    claimDocumentRevision(
      tx,
      doc.id,
      base.revision,
      { authorKind: author.kind, authorId: author.id },
      {
        content: newContent,
        ...(base.version !== undefined ? { baseVersion: base.version } : {}),
        preContent: baseContent,
        mimeType: doc.mimeType || "text/markdown",
        checkpoint: { message },
      }
    )
  );
  // A checkpointed claim always cuts (or reuses) the pre-image and cuts the
  // new row; their absence would be a broken door, not an empty result.
  if (!claimed.checkpointVersionId || !claimed.undoVersionId) {
    throw new Error(
      "claimDocumentRevision did not checkpoint a document patch (door contract broken)"
    );
  }
  const emitted = await emitDocumentContentReplaced({
    documentId: claimed.documentId,
    revision: claimed.revision,
    workspaceId: claimed.workspaceId,
    ownerUserId: claimed.ownerUserId,
  });
  if (!emitted.ok) {
    logger.warn(
      { documentId: doc.id, error: emitted.error },
      "document:content-replaced emit failed after a document patch — open editors were not told"
    );
  }
  if (args.diagnostics.items) {
    const stamped = await storeDocumentDiagnostics(
      doc.id,
      claimed.revision,
      args.diagnostics.items
    );
    if (!stamped) {
      // Someone wrote after us already; their write re-diagnoses (reactor).
      logger.info(
        { documentId: doc.id },
        "document moved before its diagnostics were stamped"
      );
    }
  }
  // Re-index the new text (search reads the stored body) and re-diagnose.
  void emitSideEffects({
    subjectType: "document",
    action: "update",
    subjectId: doc.id,
    userId: doc.userId,
    workspaceId: claimed.workspaceId,
    data: { id: doc.id, title: doc.title },
  });
  return {
    revision: claimed.revision,
    version: claimed.currentVersion,
    versionId: claimed.checkpointVersionId,
    undoVersionId: claimed.undoVersionId,
  };
}

// ─── The door ────────────────────────────────────────────────────────────────

/** The session a session-document write happens in (the session door resolves it). */
export interface PatchSessionContext {
  sessionId: string;
  workspaceId: string | null;
  /** `status[:stage]`, stamped on the sections this patch writes. */
  sessionState: string;
  /**
   * The session the caller is VERIFIABLY working in (the ownership-checked
   * `X-Session-Id` / MCP ambient session). Only a write to this session's own
   * document can earn the narrative rule.
   */
  ambientSessionId?: string | null;
}

export interface ApplyDocumentPatchInput {
  /** The human principal the request acts for. */
  userId: string;
  /** Present ⇒ an agent is writing: the ownership floor applies. */
  agentUserId?: string | null;
  /**
   * The pod itself is writing machine-owned sections on the owner's behalf (a
   * deterministic projection, no model in the loop — the closing report). Same
   * floors as an agent. Ignored when `agentUserId` is set.
   */
  systemAuthor?: string;
  documentId: string;
  /**
   * Set by the session section door, which has already authorised the caller
   * as the session's owner and resolved (or created) its document. Absent ⇒
   * the caller's edit rights are checked on the document's own floor.
   */
  session?: PatchSessionContext;
  /** The content revision the writer read (`get_document` → `revision`). */
  baseRevision?: number;
  /** Legacy base: the checkpoint version the writer read (session door). */
  baseVersion?: number;
  ops: DocumentPatchOp[];
  allowRemovingEmbeds?: boolean;
  reasoning?: string;
  sourceMessageId?: string;
  /** The request's session (provenance on the proposal); not the session door's. */
  provenanceSessionId?: string | null;
}

interface PatchResultCommon {
  documentId: string;
  /** What changed, per section — the same preview a reviewer sees. */
  preview: SectionPreview[];
  /** Advisory: what will not render. Never a refusal. `null` = could not be checked. */
  diagnostics: DocumentDiagnostic[] | null;
  /** Why `diagnostics` is null. */
  diagnosticsError?: string;
}

export type ApplyDocumentPatchResult =
  | (PatchResultCommon & {
      status: "applied";
      revision: number;
      version: number;
      /** Section ids an `upsert_section` replaced in place (vs appended). */
      replacedSections: string[];
      undo: { documentId: string; versionId: string };
      autoApprovedProposalId?: string;
    })
  | (PatchResultCommon & {
      status: "proposed";
      proposalId: string;
      proposalType: string;
      summary: string;
      reviewPath: string;
      reviewUrl: string;
      deduped?: boolean;
    });

/** The payload a patch proposal carries (and `applyApprovedDocumentPatch` reads). */
export interface DocumentPatchProposalData {
  documentId: string;
  sessionId?: string;
  ops: DocumentPatchOp[];
  baseRevision: number;
  /** The checkpoint at filing — read only by readers that predate revisions. */
  baseVersion: number;
  preview: SectionPreview[];
  /** `null` = the check could not run (`diagnosticsError` says why). */
  diagnostics: DocumentDiagnostic[] | null;
  diagnosticsError?: string;
  allowRemovingEmbeds: boolean;
  /** Section stamps: the author written onto sections, and the session state. */
  author: string;
  sessionState?: string;
  systemAuthor?: string;
}

function parseOps(ops: unknown): DocumentPatchOp[] {
  const parsed = DocumentPatchOpsSchema.safeParse(ops);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid document patch ops: ${parsed.error.issues.map((i) => `${i.path.join(".") || "ops"}: ${i.message}`).join("; ")}`,
    });
  }
  return parsed.data;
}

function writerOf(input: {
  userId: string;
  agentUserId: string | null;
  systemAuthor: string | null;
  sessionState?: string;
}): PatchWriter {
  return {
    isMachine: Boolean(input.agentUserId) || Boolean(input.systemAuthor),
    author: input.agentUserId ?? input.systemAuthor ?? input.userId,
    ...(input.sessionState ? { sessionState: input.sessionState } : {}),
  };
}

function checkpointMessage(
  ops: readonly DocumentPatchOp[],
  approved: boolean
): string {
  const suffix = approved ? " (approved)" : "";
  if (ops.length === 1 && ops[0]!.op === "upsert_section") {
    return `Section "${ops[0]!.title.trim()}" written${suffix}`;
  }
  return `Document edited${suffix}`;
}

export async function applyDocumentPatch(
  input: ApplyDocumentPatchInput
): Promise<ApplyDocumentPatchResult> {
  const ops = parseOps(input.ops);
  const agentUserId = input.agentUserId ?? null;
  const systemAuthor = agentUserId ? null : (input.systemAuthor ?? null);

  // 1. The document, as the caller may edit it.
  if (!input.session) {
    await loadEditableDocument(input.userId, input.documentId);
  }
  const doc = await loadPatchDocument(input.documentId);

  // 2. The base the writer read.
  const hasReplaceAll = ops.some((op) => op.op === "replace_all");
  if (
    hasReplaceAll &&
    input.baseRevision === undefined &&
    input.baseVersion === undefined
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "replace_all rewrites the whole document, so it needs the revision you read: pass baseRevision (get_document returns it).",
    });
  }
  const base: PatchBase =
    input.baseRevision !== undefined
      ? { revision: input.baseRevision }
      : input.baseVersion !== undefined
        ? { version: input.baseVersion }
        : // Unguarded text/section ops (exact-match / by id): pin the revision
          // read HERE, so a proposal cannot apply over a later human save.
          { revision: doc.contentRevision };
  if (base.revision !== undefined) {
    assertDocumentBaseRevision(base.revision, doc.contentRevision);
  } else {
    assertDocumentBaseVersion(base.version, doc.currentVersion);
  }

  // 3. Render + floors.
  const writer = writerOf({
    userId: input.userId,
    agentUserId,
    systemAuthor,
    sessionState: input.session?.sessionState,
  });
  const baseContent = await readPatchDocumentContent(doc);
  const rendered = renderDocumentPatch(baseContent, ops, {
    writer,
    allowRemovingEmbeds: input.allowRemovingEmbeds === true,
  });

  // 4. Advisory diagnostics of the result.
  const diagnostics = await diagnoseForDocument(
    rendered.markdown,
    doc,
    input.userId
  );

  // 5. Governance.
  const sectionOnly = isSectionOnlyPatch(ops);
  const ownSession =
    Boolean(agentUserId) &&
    !!input.session &&
    input.session.ambientSessionId === input.session.sessionId;
  const action = sectionOnly
    ? ownSession
      ? SESSION_NARRATIVE_ACTION
      : SECTION_UPDATE_ACTION
    : DOCUMENT_UPDATE_ACTION;
  const data: DocumentPatchProposalData = {
    documentId: doc.id,
    ...(input.session ? { sessionId: input.session.sessionId } : {}),
    ops,
    baseRevision: base.revision ?? doc.contentRevision,
    baseVersion: doc.currentVersion,
    preview: rendered.previews,
    ...diagnosticsFields(diagnostics),
    allowRemovingEmbeds: input.allowRemovingEmbeds === true,
    author: writer.author,
    ...(writer.sessionState ? { sessionState: writer.sessionState } : {}),
    ...(systemAuthor ? { systemAuthor } : {}),
  };
  // A proposal filed against a legacy checkpoint base keeps comparing on it.
  const proposalData: Record<string, unknown> =
    base.version !== undefined
      ? { ...data, baseRevision: undefined, baseVersion: base.version }
      : { ...data };
  const workspaceId = input.session
    ? input.session.workspaceId
    : doc.workspaceId;
  const provenanceSessionId =
    input.session?.sessionId ?? input.provenanceSessionId ?? undefined;
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    ...(agentUserId ? { agentUserId, source: "intelligence" as const } : {}),
    workspaceId: workspaceId ?? undefined,
    subjectType: "document",
    action,
    // An agent rewriting the whole body is always reviewed, whatever a rule says.
    ...(agentUserId && hasReplaceAll ? { forcePropose: true } : {}),
    ...(provenanceSessionId ? { sessionId: provenanceSessionId } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.sourceMessageId
      ? { sourceMessageId: input.sourceMessageId }
      : {}),
    data: { ...proposalData, id: doc.id, title: doc.title },
  });

  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      documentId: doc.id,
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
      ...(perm.deduped ? { deduped: true } : {}),
      preview: rendered.previews,
      ...diagnosticsFields(diagnostics),
    };
  }

  const applied = await writePatch({
    doc,
    base,
    baseContent,
    newContent: rendered.markdown,
    author: agentUserId
      ? { kind: "ai", id: agentUserId }
      : systemAuthor
        ? { kind: "system", id: systemAuthor }
        : { kind: "user", id: input.userId },
    message: checkpointMessage(ops, false),
    diagnostics,
  });
  return {
    status: "applied",
    documentId: doc.id,
    revision: applied.revision,
    version: applied.version,
    replacedSections: rendered.replacedSections,
    undo: { documentId: doc.id, versionId: applied.undoVersionId },
    preview: rendered.previews,
    ...diagnosticsFields(diagnostics),
    ...("autoApprovedProposalId" in perm && perm.autoApprovedProposalId
      ? { autoApprovedProposalId: perm.autoApprovedProposalId }
      : {}),
  };
}

// ─── A person's suggestion (filed direct) ────────────────────────────────────

/**
 * A person SUGGESTS an edit for the document's editors to accept: always a
 * proposal (`document/user_edit`, a direct door — the gate never forces a
 * person to propose to themselves), with the same payload, floors and
 * approval half as an agent patch.
 */
export async function suggestDocumentPatch(input: {
  userId: string;
  documentId: string;
  ops: DocumentPatchOp[];
  baseRevision?: number;
}): Promise<{
  proposalId: string;
  preview: SectionPreview[];
  diagnostics: DocumentDiagnostic[] | null;
  diagnosticsError?: string;
}> {
  const ops = parseOps(input.ops);
  await loadEditableDocument(input.userId, input.documentId);
  const doc = await loadPatchDocument(input.documentId);
  const baseRevision = input.baseRevision ?? doc.contentRevision;
  assertDocumentBaseRevision(baseRevision, doc.contentRevision);
  const writer = writerOf({
    userId: input.userId,
    agentUserId: null,
    systemAuthor: null,
  });
  const rendered = renderDocumentPatch(
    await readPatchDocumentContent(doc),
    ops,
    { writer }
  );
  const diagnostics = await diagnoseForDocument(
    rendered.markdown,
    doc,
    input.userId
  );
  const data: DocumentPatchProposalData = {
    documentId: doc.id,
    ops,
    baseRevision,
    baseVersion: doc.currentVersion,
    preview: rendered.previews,
    ...diagnosticsFields(diagnostics),
    allowRemovingEmbeds: false,
    author: writer.author,
  };
  const { proposal } = await createEventBackedProposal({
    userId: input.userId,
    workspaceId: doc.workspaceId,
    targetType: "document",
    targetId: doc.id,
    proposalType: "user_edit",
    action: "update",
    source: "user",
    summary: buildObjectActionTitle({
      action: "update",
      objectKind: "document",
      objectName: doc.title,
    }),
    createdBy: input.userId,
    data: { source: "user", sourceId: input.userId, ...data },
  });
  if (!proposal) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The suggestion could not be filed.",
    });
  }
  return {
    proposalId: proposal.id,
    preview: rendered.previews,
    ...diagnosticsFields(diagnostics),
  };
}

// ─── The approval half ───────────────────────────────────────────────────────

type ApprovableProposal = {
  targetId: string;
  agentUserId: string | null;
  createdBy?: string | null;
  data: unknown;
};

/**
 * The ops a proposal carries. A section proposal filed before W4b carried one
 * drafted section (`sectionId/title/body/attributes`) — read as the one
 * `upsert_section` op it always was, with its original stamps.
 */
function proposalOps(inner: Record<string, unknown>): {
  ops: DocumentPatchOp[];
  author?: string;
  sessionState?: string;
} {
  if (Array.isArray(inner.ops)) {
    return {
      ops: parseOps(inner.ops),
      ...(typeof inner.author === "string" ? { author: inner.author } : {}),
      ...(typeof inner.sessionState === "string"
        ? { sessionState: inner.sessionState }
        : {}),
    };
  }
  const attributes = inner.attributes as Record<string, unknown> | undefined;
  if (
    typeof inner.sectionId === "string" &&
    typeof inner.title === "string" &&
    typeof inner.body === "string" &&
    attributes
  ) {
    return {
      ops: parseOps([
        {
          op: "upsert_section",
          id: inner.sectionId,
          title: inner.title,
          body: inner.body,
          ...(typeof attributes.status === "string"
            ? { status: attributes.status }
            : {}),
        },
      ]),
      ...(typeof attributes.author === "string"
        ? { author: attributes.author }
        : {}),
      ...(typeof attributes.sessionState === "string"
        ? { sessionState: attributes.sessionState }
        : {}),
    };
  }
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "Document proposal is missing its ops (or its drafted section).",
  });
}

/**
 * Apply an APPROVED document patch (or legacy section) proposal against the
 * document as it is NOW. Any movement past the base it was drafted against is
 * a CONFLICT, and every floor is re-checked; the approval dispatch records a
 * throw as the failed approval's reason, and nothing is written.
 */
export async function applyApprovedDocumentPatch(
  proposal: ApprovableProposal,
  approverUserId: string
): Promise<
  AppliedPatchWrite & { documentId: string; diagnostics: DiagnosticsOutcome }
> {
  const raw = (proposal.data ?? {}) as Record<string, unknown>;
  const inner = (
    raw.data && typeof raw.data === "object" && !Array.isArray(raw.ops)
      ? raw.data
      : raw
  ) as Record<string, unknown>;
  const { ops, author, sessionState } = proposalOps(inner);
  const baseRevision = readProposalBaseRevision(inner);
  const baseVersion = readProposalBaseVersion(inner);
  if (baseRevision === undefined && baseVersion === undefined) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Document proposal is missing the base it was drafted against.",
    });
  }

  const doc = await loadPatchDocument(proposal.targetId);
  const base: PatchBase =
    baseRevision !== undefined
      ? { revision: baseRevision }
      : { version: baseVersion! };
  if (base.revision !== undefined) {
    assertDocumentBaseRevision(base.revision, doc.contentRevision);
  } else {
    assertDocumentBaseVersion(base.version, doc.currentVersion);
  }

  const systemAuthor =
    typeof inner.systemAuthor === "string" ? inner.systemAuthor : null;
  const isMachine = Boolean(proposal.agentUserId) || Boolean(systemAuthor);
  // The words' author: the drafting agent, else the person who suggested them.
  const humanAuthor = proposal.createdBy ?? approverUserId;
  const writer: PatchWriter = {
    isMachine,
    author: author ?? proposal.agentUserId ?? systemAuthor ?? humanAuthor,
    ...(sessionState ? { sessionState } : {}),
  };
  const baseContent = await readPatchDocumentContent(doc);
  const rendered = renderDocumentPatch(baseContent, ops, {
    writer,
    allowRemovingEmbeds: inner.allowRemovingEmbeds === true,
  });
  // Re-diagnosed at approval: an embedded object may have gone since filing.
  const diagnostics = await diagnoseForDocument(
    rendered.markdown,
    doc,
    approverUserId
  );
  const applied = await writePatch({
    doc,
    base,
    baseContent,
    newContent: rendered.markdown,
    // PROVENANCE: the agent drafted the words; the approver is on the proposal.
    author: proposal.agentUserId
      ? { kind: "ai", id: proposal.agentUserId }
      : systemAuthor
        ? { kind: "system", id: systemAuthor }
        : { kind: "user", id: humanAuthor },
    message: checkpointMessage(ops, true),
    diagnostics,
  });
  return { ...applied, documentId: doc.id, diagnostics };
}
