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
 *      - a document whose ENTITY is filed into a project (the entity carries
 *        the `belongs_to_project` edge; the document is its body via
 *        `entities.document_id` — the same shape the read floor follows) → also
 *        an editor+ member of that project. `visible_to` (client portal)
 *        exposure stays read-only, and a `guest` project role never edits
 *        (not in PROJECT_WRITE_ROLES);
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
 *
 * A document OWNED BY A VIEW (a whiteboard / canvas: `views.document_id`)
 * also takes its view's floor, as a widening of both gates: readable when the
 * view is readable (the registered `views` VisibilityRule), editable when the
 * view is writable (`assertWorkspaceWrite` on the VIEW row — the same ladder
 * as `assertViewAccess(view, …, "write")`: editor+ of the view's workspace, or
 * the owner of a pod-wide view). The view IS the document's owner there, and
 * canvas documents created before 2026-02-24 (`views.create` inserted them
 * without `workspace_id` until ea3a1d62; no backfill migration exists) carry a
 * NULL workspace while their view carries one. Without this branch those
 * boards were unreachable for every workspace member but their creator.
 *
 * The realtime (Yjs) room gate consumes THIS file through the
 * `@synap/api/document-access` entry (`resolveDocumentRoomAccess`), so a room
 * and a save can never disagree about who may write.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  documents,
  entities,
  relations,
  projectMembers,
  podMembers,
  views,
  getWorkspaceMembership,
} from "@synap/database";
import { AccessContext, scopedDb } from "../access/index.js";
// The access index registers the object-room floors
// (`utils/object-room-floors.ts`). The realtime server reaches channel
// visibility through THIS entry (`@synap/api/document-access`), so a
// document's room is joinable by exactly its readers there too.
import { assertWorkspaceWrite } from "./workspace-write-access.js";
import {
  BELONGS_TO_PROJECT,
  EXPOSURE_RELATION_TYPES,
  podSharedDocumentWhere,
} from "./project-scope.js";

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
type ViewRow = typeof views.$inferSelect;

/**
 * Why a reader may not edit — a MACHINE code the surface maps to its own copy
 * (a sentence, so it stays local to the UI, not in the vocabulary). Only codes
 * the gate below can actually produce:
 *   - `view_only`       — the caller holds a workspace or project membership
 *                         that reaches the document, but its role does not
 *                         write (workspace viewer; project viewer / guest,
 *                         including a `visible_to` portal guest);
 *   - `not_member`      — a workspace document seen without any such
 *                         membership (e.g. a pod-visible workspace);
 *   - `not_owner`       — a personal pod-wide document owned by someone else;
 *   - `pod_shared_read` — the body of a pod-shared entity, and the caller's pod
 *                         role is not in POD_WRITE_ROLES (no such role exists
 *                         today: reserved for a read-only pod tier).
 */
export const DOCUMENT_EDIT_REASONS = [
  "view_only",
  "not_member",
  "not_owner",
  "pod_shared_read",
] as const;
export type DocumentEditReason = (typeof DOCUMENT_EDIT_REASONS)[number];

export type DocumentEditVerdict =
  | { allowed: true; reason: null }
  | { allowed: false; reason: DocumentEditReason };

/** The gate's FORBIDDEN verdict, carrying WHY. */
class DocumentEditDenied extends TRPCError {
  constructor(readonly reason: DocumentEditReason) {
    super({ code: "FORBIDDEN", message: "You cannot edit this document." });
  }
}

/** Gate 1: the document as the caller may see it, or NOT_FOUND. */
export async function loadReadableDocument(
  userId: string,
  documentId: string
): Promise<DocumentRow> {
  const doc = await scopedDb(
    AccessContext.operator({ userId })
  ).findFirst<DocumentRow>(documents, { where: eq(documents.id, documentId) });
  if (doc) return doc;
  // A view-owned document is readable when its view is (the `views` rule).
  const view = await scopedDb(
    AccessContext.operator({ userId })
  ).findFirst<ViewRow>(views, { where: eq(views.documentId, documentId) });
  const owned = view
    ? await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      })
    : undefined;
  if (!owned) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  }
  return owned;
}

/** The view that owns this document (a canvas), if any — unscoped. */
async function owningView(documentId: string): Promise<ViewRow | undefined> {
  return db.query.views.findFirst({ where: eq(views.documentId, documentId) });
}

/**
 * May `userId` write the VIEW that owns this document? The view write floor:
 * `assertWorkspaceWrite` on the view row (editor+ of its workspace, or the
 * owner of a pod-wide view). Only its FORBIDDEN verdict reads as `false`.
 */
async function isViewWriterOf(
  userId: string,
  view: ViewRow | undefined
): Promise<boolean> {
  if (!view) return false;
  try {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: view.workspaceId,
      ownerId: view.userId,
    });
    return true;
  } catch (err) {
    if (err instanceof TRPCError && err.code === "FORBIDDEN") return false;
    throw err;
  }
}

/**
 * Gate 2 on an already-loaded (readable) row: resolves when the caller may
 * change its content or history, throws FORBIDDEN (a `DocumentEditDenied`
 * carrying the reason) when they may not. Any other failure (a failed
 * membership read) propagates as itself.
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
    if (await isProjectMemberOf(userId, doc.id, PROJECT_WRITE_ROLES)) return;
    const view = await owningView(doc.id);
    if (await isViewWriterOf(userId, view)) return;
    const podShared =
      doc.workspaceId === null && (await isPodSharedDocument(userId, doc.id));
    if (podShared && (await hasPodWriteRole(userId))) return;
    throw new DocumentEditDenied(
      await denialReason(userId, doc, podShared, view)
    );
  }
}

/** Which reading path the caller holds, for a denied edit (see the codes). */
async function denialReason(
  userId: string,
  doc: DocumentRow,
  podShared: boolean,
  view: ViewRow | undefined
): Promise<DocumentEditReason> {
  if (podShared) return "pod_shared_read";
  // A view-owned document answers for its view's workspace when it has none.
  const workspaceId = doc.workspaceId ?? view?.workspaceId ?? null;
  if (workspaceId && (await getWorkspaceMembership(db, workspaceId, userId))) {
    return "view_only";
  }
  if (await isProjectMemberOf(userId, doc.id, null)) return "view_only";
  return workspaceId ? "not_member" : "not_owner";
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
 * May the caller edit this (readable) document, and if not, why? The SAME
 * gate `loadEditableDocument` enforces, as a verdict for the reader
 * (`documents.get` → `canEdit` + `editReason`), so the surface never offers an
 * edit the write would refuse. EMPTY ≠ FAILED: only the FORBIDDEN verdict is
 * `allowed: false`; a failed membership read throws, never reads as "cannot
 * edit".
 */
export async function canEditDocument(
  userId: string,
  doc: DocumentRow
): Promise<DocumentEditVerdict> {
  try {
    await assertDocumentEditable(userId, doc);
    return { allowed: true, reason: null };
  } catch (err) {
    if (err instanceof DocumentEditDenied) {
      return { allowed: false, reason: err.reason };
    }
    throw err;
  }
}

/**
 * The realtime (Yjs) room floor for one document: `edit` when the caller may
 * change it (`canEditDocument`), `read` when they may only see it (gate 1),
 * `none` when it is invisible to them or does not exist. The realtime server
 * calls this — never a copy of it. A failed read throws, and the room gate
 * then refuses (fail closed).
 */
export async function resolveDocumentRoomAccess(
  userId: string,
  documentId: string
): Promise<"edit" | "read" | "none"> {
  let doc: DocumentRow;
  try {
    doc = await loadReadableDocument(userId, documentId);
  } catch (err) {
    if (err instanceof TRPCError && err.code === "NOT_FOUND") return "none";
    throw err;
  }
  return (await canEditDocument(userId, doc)).allowed ? "edit" : "read";
}

/**
 * Is `userId` a member of a project this document's ENTITY is exposed to,
 * holding one of `roles` (`null` = any role)? Edges carry entity ids only, so
 * the document is reached through `entities.document_id` — the same join the
 * read floor uses (`exposureDocumentWhere`). Joining
 * `relations.source_entity_id` to the document id directly (the old shape)
 * matched nothing a writer produces.
 *
 * With `roles` (the edit check) only `belongs_to_project` counts: `visible_to`
 * (client portal) exposure stays read-only whatever the role. With `null` (the
 * denial reason) every exposure edge the read floor admits counts.
 */
async function isProjectMemberOf(
  userId: string,
  documentId: string,
  roles: string[] | null
): Promise<boolean> {
  const [row] = await db
    .select({ projectId: projectMembers.projectId })
    .from(entities)
    .innerJoin(
      relations,
      and(
        eq(relations.sourceEntityId, entities.id),
        roles
          ? eq(relations.type, BELONGS_TO_PROJECT)
          : inArray(relations.type, [...EXPOSURE_RELATION_TYPES])
      )
    )
    .innerJoin(
      projectMembers,
      eq(projectMembers.projectId, relations.targetEntityId)
    )
    .where(
      and(
        eq(entities.documentId, documentId),
        isNull(entities.deletedAt),
        eq(projectMembers.userId, userId),
        roles ? inArray(projectMembers.role, roles) : undefined
      )
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Is this pod-wide document the body of a pod-shared entity, as `userId` sees
 * it? The share test is `podSharedDocumentWhere` — the read floor's own branch
 * — so read and write cannot disagree about sharing.
 */
async function isPodSharedDocument(
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
  return Boolean(row);
}

/** Does `userId` hold a writing pod role? */
async function hasPodWriteRole(userId: string): Promise<boolean> {
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
