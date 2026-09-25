/**
 * Document rooms: the Yjs state is a CACHE of the markdown (W4a).
 *
 * Pinned:
 *   - the cache is loaded ONLY when `working_state_revision === content_revision`;
 *     a stale cache (an approved edit / restore moved the revision) is ignored
 *     and the room asks for a one-time seed of the current revision;
 *   - a room is stamped trusted only when its `revision` meta equals the
 *     document's current revision, and never after a failed load.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  applyDocumentRoomPlan,
  markDocumentRoomLoadFailed,
  planDocumentRoomLoad,
  roomMeta,
  ROOM_META_KEYS,
  trustedCacheRevision,
} from "../document-room.js";

function cachedState(text: string): string {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

describe("planDocumentRoomLoad", () => {
  it("loads the cache when it is known to equal the current revision", () => {
    const plan = planDocumentRoomLoad({
      contentRevision: 4,
      workingState: cachedState("hello"),
      workingStateRevision: 4,
    });
    expect(plan.kind).toBe("cache");
    const ydoc = new Y.Doc();
    applyDocumentRoomPlan(ydoc, plan);
    expect(ydoc.getText("t").toString()).toBe("hello");
    expect(roomMeta(ydoc).get(ROOM_META_KEYS.revision)).toBe(4);
    expect(roomMeta(ydoc).get(ROOM_META_KEYS.seedRevision)).toBeUndefined();
  });

  it("IGNORES a stale cache (the revision moved) and asks for a seed of the current revision", () => {
    const plan = planDocumentRoomLoad({
      contentRevision: 5,
      workingState: cachedState("pre-approval text"),
      workingStateRevision: 4,
    });
    expect(plan).toEqual({ kind: "seed", revision: 5 });
    const ydoc = new Y.Doc();
    applyDocumentRoomPlan(ydoc, plan);
    expect(ydoc.getText("t").toString()).toBe("");
    expect(roomMeta(ydoc).get(ROOM_META_KEYS.seedRevision)).toBe(5);
  });

  it("an untrusted (NULL) cache is never loaded", () => {
    expect(
      planDocumentRoomLoad({
        contentRevision: 1,
        workingState: cachedState("x"),
        workingStateRevision: null,
      })
    ).toEqual({ kind: "seed", revision: 1 });
  });
});

describe("trustedCacheRevision", () => {
  it("trusts only a room whose revision meta equals the document's revision", () => {
    const ydoc = new Y.Doc();
    expect(trustedCacheRevision(ydoc, 3)).toBeNull(); // never seeded
    roomMeta(ydoc).set(ROOM_META_KEYS.revision, 3);
    expect(trustedCacheRevision(ydoc, 3)).toBe(3);
    // A server replace moved the document on; the room still holds 3.
    expect(trustedCacheRevision(ydoc, 4)).toBeNull();
  });

  it("a room that failed to load is never trusted", () => {
    const ydoc = new Y.Doc();
    roomMeta(ydoc).set(ROOM_META_KEYS.revision, 2);
    markDocumentRoomLoadFailed(ydoc, "could not read");
    expect(trustedCacheRevision(ydoc, 2)).toBeNull();
  });
});
