/**
 * Document (text) rooms: the Yjs state is a CACHE of the markdown, never history.
 *
 * The markdown in `documents.storage_key` is canonical. The realtime room holds
 * a Yjs copy of it for co-editing, persisted to `documents.working_state`. That
 * cache is trusted only while it is KNOWN to equal the current content:
 * `documents.working_state_revision === documents.content_revision`. Any writer
 * other than the room itself (an approved edit, a restore, a non-collaborative
 * save) moves `content_revision` through `claimDocumentRevision`, and the stale
 * cache is then ignored. The room starts empty and the markdown is seeded into
 * it ONCE (the Hocuspocus rule).
 *
 * The server cannot build the editor's Yjs tree from markdown: that needs the
 * editor schema, which lives in the client. So the SEED is done by one client,
 * and this module only tells the room what it needs. The shared contract is the
 * `synap-room` Y.Map below. The client mirror is
 * `synap-app/packages/features/document/src/roomMeta.ts`, and the two key sets
 * must stay identical.
 *
 *   revision      the content_revision the room's content corresponds to. The
 *                 server sets it when it loads a trusted cache; the client sets
 *                 it after it seeds, writes back, or reloads a replaced document.
 *   seedRevision  set by the server when the room starts empty and needs the
 *                 markdown of that revision seeded.
 *   seedClaim     the client id that won the right to seed (last-writer-wins on
 *                 a Y.Map key converges, so exactly one client seeds).
 *   loadError     the server could not load the room. Clients must surface it
 *                 and must neither seed nor write back: an empty room here is a
 *                 FAILED read, not an empty document.
 */

import * as Y from "yjs";

export const ROOM_META_MAP = "synap-room";
export const ROOM_META_KEYS = {
  revision: "revision",
  seedRevision: "seedRevision",
  seedClaim: "seedClaim",
  loadError: "loadError",
} as const;

export interface DocumentRoomRow {
  contentRevision: number;
  workingState: string | null;
  workingStateRevision: number | null;
}

export type DocumentRoomPlan =
  | { kind: "cache"; revision: number; state: Uint8Array }
  | { kind: "seed"; revision: number };

/** Load the cache only when it is known to equal the current content. */
export function planDocumentRoomLoad(doc: DocumentRoomRow): DocumentRoomPlan {
  if (
    doc.workingState &&
    doc.workingStateRevision !== null &&
    doc.workingStateRevision === doc.contentRevision
  ) {
    return {
      kind: "cache",
      revision: doc.contentRevision,
      state: new Uint8Array(Buffer.from(doc.workingState, "base64")),
    };
  }
  return { kind: "seed", revision: doc.contentRevision };
}

export function roomMeta(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(ROOM_META_MAP);
}

/** Apply a load plan to a fresh room. */
export function applyDocumentRoomPlan(
  ydoc: Y.Doc,
  plan: DocumentRoomPlan
): void {
  if (plan.kind === "cache") {
    Y.applyUpdate(ydoc, plan.state);
    ydoc.transact(() => {
      const meta = roomMeta(ydoc);
      meta.set(ROOM_META_KEYS.revision, plan.revision);
      meta.delete(ROOM_META_KEYS.seedRevision);
      meta.delete(ROOM_META_KEYS.loadError);
    });
    return;
  }
  ydoc.transact(() => {
    const meta = roomMeta(ydoc);
    meta.set(ROOM_META_KEYS.seedRevision, plan.revision);
    meta.delete(ROOM_META_KEYS.loadError);
  });
}

/** Mark the room as FAILED to load. Clients render the error; they do not seed. */
export function markDocumentRoomLoadFailed(ydoc: Y.Doc, message: string): void {
  roomMeta(ydoc).set(ROOM_META_KEYS.loadError, message);
}

/**
 * The revision to stamp on `working_state_revision` when persisting this room.
 * Only when the room claims exactly the document's current revision: any other
 * value (unseeded, stale after a server replace) leaves the cache untrusted.
 */
export function trustedCacheRevision(
  ydoc: Y.Doc,
  contentRevision: number
): number | null {
  const meta = roomMeta(ydoc);
  if (meta.get(ROOM_META_KEYS.loadError) !== undefined) return null;
  const revision = meta.get(ROOM_META_KEYS.revision);
  return typeof revision === "number" && revision === contentRevision
    ? revision
    : null;
}
