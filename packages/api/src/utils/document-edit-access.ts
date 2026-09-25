/**
 * Document EDIT RIGHTS: the one predicate for update, propose, versions and
 * restore (founder decision D-gov, 2026-09-25: edit rights follow the document's
 * own floor).
 *
 * Two gates, both from the access layer and never hand-rolled:
 *   1. READ FLOOR: the document must be visible through the registered
 *      `documents` VisibilityRule (`scopedDb`). That covers owner, workspace
 *      membership and exposure (project) membership. An invisible document
 *      answers NOT_FOUND, so a non-member cannot probe for ids.
 *   2. WRITE FLOOR on the LOADED row's scope, never a request-supplied one:
 *      - workspace document → an editor+ member of that workspace
 *        (`assertWorkspaceWrite`);
 *      - pod-wide (NULL workspace) document → its owner (`assertWorkspaceWrite`);
 *      - a document filed into a project (`belongs_to_project` edge, the same
 *        exposure edge the read floor admits) → also an editor+ member of that
 *        project. `visible_to` (client portal) exposure stays read-only;
 *      - a pod-wide document that is the body of a POD-SHARED entity (a
 *        document follows its entity — founder decision 2026-09-25) → also a
 *        pod member with a writing pod role. Evaluated with the SAME predicate
 *        the read floor uses (`podSharedDocumentWhere`). A standalone pod-wide
 *        document stays owner-only.
 *
 * Before this, update/versions/restore/propose were owner-only while reads were
 * member-level: a workspace member could open a shared document, type, and have
 * every save 404.
 *
 * Reading history (`listVersions`, `getVersionPreview`) is a READ: gate 1 only.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  documents,
  relations,
  projectMembers,
  podMembers,
} from "@synap/database";
import { AccessContext, scopedDb } from "../access/index.js";
import { assertWorkspaceWrite } from "./workspace-write-access.js";
import { BELONGS_TO_PROJECT, podSharedDocumentWhere } from "./project-scope.js";

/** Project roles that may change a project's documents (same set as workspaces). */
const PROJECT_WRITE_ROLES = ["owner", "admin", "editor"];
/**
 * Pod roles that may change a pod-shared document. Pod roles today are
 * `owner | admin | member` — there is no read-only pod tier, so every role
 * writes. An allowlist, not a denylist: a read-only role added later (a guest)
 * is excluded until someone decides otherwise.
 */
const POD_WRITE_ROLES = ["owner", "admin", "member"];

export type DocumentRow = typeof documents.$inferSelect;

/** Gate 1: the document as the caller may see it, or NOT_FOUND. */
export async function loadReadableDocument(
  userId: string,
  documentId: string
): Promise<DocumentRow> {
  const doc = await scopedDb(
    AccessContext.operator({ userId })
  ).findFirst<DocumentRow>(documents, { where: eq(documents.id, documentId) });
  if (!doc) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  }
  return doc;
}

/**
 * Gate 2 on an already-loaded (readable) row: resolves when the caller may
 * change its content or history, throws FORBIDDEN when they may not. Any
 * other failure (a failed membership read) propagates as itself.
 */
async function assertDocumentEditable(
  userId: string,
  doc: DocumentRow
): Promise<void> {
  try {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: doc.workspaceId,
      ownerId: doc.userId,
    });
  } catch (err) {
    // Only a FORBIDDEN verdict can be widened by project membership; any other
    // failure (a failed membership read) propagates as itself.
    if (!(err instanceof TRPCError && err.code === "FORBIDDEN")) throw err;
    if (await isProjectEditorOf(userId, doc.id)) return;
    if (doc.workspaceId === null && (await isPodSharedEditorOf(userId, doc.id)))
      return;
    throw err;
  }
}

/** Gates 1 + 2: the document, if the caller may change its content or history. */
export async function loadEditableDocument(
  userId: string,
  documentId: string
): Promise<DocumentRow> {
  const doc = await loadReadableDocument(userId, documentId);
  await assertDocumentEditable(userId, doc);
  return doc;
}

/**
 * May the caller edit this (readable) document? The SAME gate
 * `loadEditableDocument` enforces, as a boolean for the reader
 * (`documents.get` → `canEdit`), so the surface never offers an edit the
 * write would refuse. EMPTY ≠ FAILED: only the FORBIDDEN verdict is `false`;
 * a failed membership read throws, never reads as "cannot edit".
 */
export async function canEditDocument(
  userId: string,
  doc: DocumentRow
): Promise<boolean> {
  try {
    await assertDocumentEditable(userId, doc);
    return true;
  } catch (err) {
    if (err instanceof TRPCError && err.code === "FORBIDDEN") return false;
    throw err;
  }
}

/** Is `userId` an editor+ member of a project this document is filed into? */
async function isProjectEditorOf(
  userId: string,
  documentId: string
): Promise<boolean> {
  const [row] = await db
    .select({ projectId: projectMembers.projectId })
    .from(relations)
    .innerJoin(
      projectMembers,
      eq(projectMembers.projectId, relations.targetEntityId)
    )
    .where(
      and(
        eq(relations.sourceEntityId, documentId),
        eq(relations.type, BELONGS_TO_PROJECT),
        eq(projectMembers.userId, userId),
        inArray(projectMembers.role, PROJECT_WRITE_ROLES)
      )
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Is this pod-wide document the body of a pod-shared entity, and does `userId`
 * hold a writing pod role? The share test is `podSharedDocumentWhere` — the
 * read floor's own branch — so read and write cannot disagree about sharing.
 */
async function isPodSharedEditorOf(
  userId: string,
  documentId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        podSharedDocumentWhere(documents.workspaceId, documents.id, userId)
      )
    )
    .limit(1);
  if (!row) return false;
  const [member] = await db
    .select({ podRole: podMembers.podRole })
    .from(podMembers)
    .where(
      and(
        eq(podMembers.userId, userId),
        inArray(podMembers.podRole, POD_WRITE_ROLES)
      )
    )
    .limit(1);
  return Boolean(member);
}
