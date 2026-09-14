import { describe, it, expect } from "vitest";
import {
  CLEANUP_PACK_SCHEMA,
  CLEANUP_ACTION_REVERSIBLE,
  cleanupItemReason,
  describeCleanupAction,
  readPackItems,
  stableItemRef,
  type CleanupPackItemV2,
} from "./index.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function sessionItem(
  id: string,
  over: Partial<CleanupPackItemV2["evidence"]> = {}
): CleanupPackItemV2 {
  return {
    ref: stableItemRef("close_session", id),
    action: "close_session",
    subject: { kind: "session", id, name: `Session ${id}` },
    evidence: {
      createdAt: "2026-06-01T00:00:00Z",
      lastActivityAt: "2026-08-03T09:00:00Z",
      ...over,
    },
    reversible: CLEANUP_ACTION_REVERSIBLE.close_session,
    risk: "low",
    snapshot: { updatedAt: "2026-08-03T09:00:00Z" },
  };
}

function kindItem(
  id: string,
  over: Partial<CleanupPackItemV2["evidence"]> = {}
): CleanupPackItemV2 {
  return {
    ref: stableItemRef("retire_profile", id),
    action: "retire_profile",
    subject: { kind: "kind", id, name: `Kind ${id}` },
    evidence: {
      createdAt: "2026-07-12T00:00:00Z",
      lastActivityAt: null,
      records: 0,
      dependents: { views: 2, automations: 0, relationTypes: 0, facets: 0 },
      ...over,
    },
    reversible: CLEANUP_ACTION_REVERSIBLE.retire_profile,
    risk: "low",
    snapshot: { updatedAt: "2026-07-12T00:00:00Z" },
  };
}

describe("stableItemRef", () => {
  it("is id-keyed, so the same subject has the same ref in two packs", () => {
    const packA = {
      schema: CLEANUP_PACK_SCHEMA,
      items: [sessionItem("s1"), sessionItem("s2")],
    };
    // Different position, different pack: the ref must not move.
    const packB = {
      schema: CLEANUP_PACK_SCHEMA,
      items: [kindItem("k9"), sessionItem("s2")],
    };
    const refA = readPackItems(packA).items.find(
      (i) => i.subject.id === "s2"
    )!.ref;
    const refB = readPackItems(packB).items.find(
      (i) => i.subject.id === "s2"
    )!.ref;
    expect(refA).toBe("close_session:s2");
    expect(refB).toBe(refA);
  });
});

describe("readPackItems", () => {
  it("reads a v2 pack as non-legacy with the full item", () => {
    const read = readPackItems({
      schema: 2,
      items: [sessionItem("s1"), kindItem("k1")],
    });
    expect(read.schema).toBe(2);
    expect(read.unreadable).toBe(0);
    expect(read.items.map((i) => [i.ref, i.legacy, i.subject.kind])).toEqual([
      ["close_session:s1", false, "session"],
      ["retire_profile:k1", false, "kind"],
    ]);
    expect(read.items[0]!.item?.evidence.lastActivityAt).toBe(
      "2026-08-03T09:00:00Z"
    );
  });

  it("reads an already-filed v1 pack (positional refs, dropped actions) as legacy", () => {
    const v1 = {
      changeType: "update",
      items: [
        {
          ref: "$item0",
          action: "close_session",
          targetId: "s1",
          label: "Weekly sync",
          reason: "x",
        },
        {
          ref: "$item1",
          action: "expire_proposal",
          targetId: "p1",
          label: "Old ask",
          reason: "x",
        },
        {
          ref: "$item2",
          action: "pause_automation",
          targetId: "a1",
          label: "Nightly",
          reason: "x",
        },
        {
          ref: "$item3",
          action: "retire_profile",
          targetId: "k1",
          label: "Recipe (recipe)",
          reason: "x",
        },
      ],
    };
    const read = readPackItems(v1);
    expect(read.schema).toBe(1);
    expect(read.unreadable).toBe(0);
    expect(
      read.items.map((i) => [
        i.ref,
        i.action,
        i.subject.kind,
        i.subject.id,
        i.legacy,
        i.item,
      ])
    ).toEqual([
      ["$item0", "close_session", "session", "s1", true, null],
      ["$item1", "expire_proposal", "proposal", "p1", true, null],
      ["$item2", "pause_automation", "automation", "a1", true, null],
      ["$item3", "retire_profile", "kind", "k1", true, null],
    ]);
    expect(read.items[0]!.subject.name).toBe("Weekly sync");
  });

  it("counts an unknown action as unreadable instead of throwing or dropping it", () => {
    const read = readPackItems({
      schema: 2,
      items: [
        sessionItem("s1"),
        { ...sessionItem("s2"), action: "delete_everything" },
      ],
    });
    expect(read.items.map((i) => i.ref)).toEqual(["close_session:s1"]);
    expect(read.unreadable).toBe(1);
    const v1 = readPackItems({
      items: [{ ref: "$item0", action: "nuke", targetId: "x", label: "x" }],
    });
    expect(v1).toEqual({ schema: 1, items: [], unreadable: 1 });
  });

  it("refuses a v1-only action inside a v2 pack (FD1/FD2 are not re-armed by a v2 row)", () => {
    const expire = {
      ...sessionItem("p1"),
      action: "expire_proposal",
      ref: "expire_proposal:p1",
      subject: { kind: "proposal", id: "p1", name: "x" },
    };
    expect(readPackItems({ schema: 2, items: [expire] }).unreadable).toBe(1);
    // The discriminating row: no subject.kind, so ONLY the action gate stops it
    // (the row above is also refused by the subject-kind check, which masked a
    // removed action gate in the negative control).
    const kindless = { ...expire, subject: { id: "p1", name: "x" } };
    expect(readPackItems({ schema: 2, items: [kindless] })).toEqual({
      schema: 2,
      items: [],
      unreadable: 1,
    });
  });

  it("refuses a v2 row whose ref is positional, or whose subject kind mismatches its action", () => {
    const positional = { ...sessionItem("s1"), ref: "$item0" };
    const mismatched = {
      ...sessionItem("s2"),
      subject: { kind: "kind", id: "s2", name: "x" },
    };
    const badDate = sessionItem("s3", { createdAt: "not a date" });
    const read = readPackItems({
      schema: 2,
      items: [positional, mismatched, badDate, null, "x"],
    });
    expect(read.items).toEqual([]);
    expect(read.unreadable).toBe(5);
  });

  it("never throws on junk and keeps 'no items' distinct from 'unreadable items'", () => {
    for (const junk of [null, undefined, 42, "x", [], {}, { items: "nope" }]) {
      expect(readPackItems(junk)).toEqual({
        schema: null,
        items: [],
        unreadable: 0,
      });
    }
    expect(readPackItems({ schema: 2, items: [] })).toEqual({
      schema: 2,
      items: [],
      unreadable: 0,
    });
  });
});

describe("describeCleanupAction (moved from api, same output)", () => {
  it("names each group through the vocabulary, singular and plural", () => {
    expect(describeCleanupAction("close_session", 1)).toBe(
      "Close 1 idle session"
    );
    expect(describeCleanupAction("close_session", 3)).toBe(
      "Close 3 idle sessions"
    );
    expect(describeCleanupAction("retire_profile", 12)).toBe(
      "Retire 12 unused kinds"
    );
    // Legacy groups still get a heading when a v1 pack is read.
    expect(describeCleanupAction("pause_automation", 2)).toBe(
      "Pause 2 automations that never ran"
    );
    expect(describeCleanupAction("expire_proposal", 1)).toBe(
      "Expire 1 old proposal"
    );
  });
});

describe("cleanupItemReason", () => {
  it("session: idle days and the last-activity date", () => {
    expect(cleanupItemReason(sessionItem("s1"), NOW)).toBe(
      "Idle 42 days · no activity since 3 Aug"
    );
  });

  it("session: a date outside now's year carries the year", () => {
    const item = sessionItem("s1", { lastActivityAt: "2025-12-30T00:00:00Z" });
    expect(cleanupItemReason(item, NOW)).toBe(
      "Idle 258 days · no activity since 30 Dec 2025"
    );
  });

  it("session: null lastActivity falls back to age, never to 'Idle NaN'", () => {
    const item = sessionItem("s1", { lastActivityAt: null });
    expect(cleanupItemReason(item, NOW)).toBe(
      "Created 105 days ago · no activity recorded"
    );
  });

  it("kind: records, age and dependents", () => {
    expect(cleanupItemReason(kindItem("k1"), NOW)).toBe(
      "0 records · created 64 days ago · used by 2 views"
    );
  });

  it("kind: unmeasured automations are said, not read as zero", () => {
    const item = kindItem("k1", {
      dependents: { views: 0, automations: null, relationTypes: 1, facets: 0 },
      lastActivityAt: "2026-08-01T00:00:00Z",
    });
    const line = cleanupItemReason(item, NOW);
    expect(line).toMatch(
      /^0 records · created 64 days ago · last used 1 Aug · used by 1 relation type/
    );
    expect(line).toMatch(/automations not checked$/);
    expect(line).not.toMatch(/nothing depends on it/);
  });

  it("kind: all-zero measured dependents say so; no evidence extras stay quiet", () => {
    const zero = kindItem("k1", {
      dependents: { views: 0, automations: 0, relationTypes: 0, facets: 0 },
    });
    expect(cleanupItemReason(zero, NOW)).toBe(
      "0 records · created 64 days ago · nothing depends on it"
    );
    const bare = kindItem("k1", { records: undefined, dependents: undefined });
    expect(cleanupItemReason(bare, NOW)).toBe("Created 64 days ago");
  });

  it("never promises undo, for any action, even if reversible were set true", () => {
    const UNDO = /undo|undone|revers|restor|resum|reactivat|reopen/i;
    const cases = [
      sessionItem("s1"),
      sessionItem("s2", { lastActivityAt: null }),
      kindItem("k1"),
      kindItem("k2", { dependents: undefined, records: undefined }),
    ];
    for (const item of cases) {
      expect(cleanupItemReason({ ...item, reversible: true }, NOW)).not.toMatch(
        UNDO
      );
    }
    // v1 has no user-reachable inverse door for either action (FD5).
    expect(Object.values(CLEANUP_ACTION_REVERSIBLE)).toEqual([false, false]);
  });
});
