import { describe, expect, it } from "vitest";
import {
  findProposalTwins,
  proposalTwinKey,
  type ProposalTwinInput,
} from "./twin-key.js";

/**
 * The ONE "same proposal twice" key (finding 9ae52db7). diagnose's duplicate
 * clusters and the agent `duplicateRate` both read it, so these pin what a
 * twin is: the same change on the same target, never the same verb on
 * different targets.
 */

const CAPABILITY = "11111111-1111-4111-8111-111111111111";

/** A run of one delete verb on one note: they all share the capability target. */
function deleteRun(noteId: string, over: Partial<ProposalTwinInput> = {}) {
  return {
    proposalType: "capability.run",
    targetType: "capability",
    targetId: CAPABILITY,
    workspaceId: "ws1",
    data: { verbId: "entities.delete", params: { entityId: noteId } },
    ...over,
  } satisfies ProposalTwinInput;
}

describe("findProposalTwins", () => {
  it("seven deletes of seven different notes are seven proposals, not a cluster", () => {
    const rows = Array.from({ length: 7 }, (_, i) => deleteRun(`note-${i}`));
    expect(findProposalTwins(rows)).toEqual([]);
  });

  it("the same delete of the same note proposed twice is one cluster of 2", () => {
    const rows = [
      deleteRun("note-a"),
      deleteRun("note-a"),
      deleteRun("note-b"),
      deleteRun("note-c"),
    ];
    const twins = findProposalTwins(rows);
    expect(twins).toHaveLength(1);
    expect(twins[0]!.count).toBe(2);
  });

  it("a withdrawn proposal and its refile are twins: the stored filing hash wins over the stamped payload", () => {
    const filed = {
      proposalType: "update",
      targetType: "focus_session",
      targetId: "s1",
      workspaceId: "ws1",
      data: { data: { status: "paused" } },
    };
    const withdrawn = {
      ...filed,
      dedupHash: "hash-of-the-filed-change",
      data: { ...filed.data, withdrawReason: "filing it again" },
    };
    const refiled = { ...filed, dedupHash: "hash-of-the-filed-change" };
    expect(findProposalTwins([withdrawn, refiled])).toEqual([
      expect.objectContaining({ count: 2 }),
    ]);
  });

  it("orders the groups largest first", () => {
    const rows = [
      deleteRun("a"),
      deleteRun("a"),
      deleteRun("b"),
      deleteRun("b"),
      deleteRun("b"),
    ];
    expect(findProposalTwins(rows).map((g) => g.count)).toEqual([3, 2]);
  });
});

describe("proposalTwinKey normalizes the payload", () => {
  it("ignores key order, nested ones included", () => {
    const a = deleteRun("n", {
      data: {
        verbId: "entities.delete",
        params: { entityId: "n", hard: true },
      },
    });
    const b = deleteRun("n", {
      data: {
        params: { hard: true, entityId: "n" },
        verbId: "entities.delete",
      },
    });
    expect(proposalTwinKey(a)).toBe(proposalTwinKey(b));
  });

  it("keeps a real value difference, a whitespace one included (the write-time dedup rule)", () => {
    const create = (name: string, id: string) => ({
      proposalType: "create",
      targetType: "entity",
      targetId: id,
      workspaceId: "ws1",
      data: { name },
    });
    expect(proposalTwinKey(create("Acme", "x1"))).not.toBe(
      proposalTwinKey(create("Globex", "x2"))
    );
    expect(proposalTwinKey(create("Acme", "x1"))).not.toBe(
      proposalTwinKey(create(" Acme ", "x2"))
    );
  });

  it("ignores per-attempt plumbing: a create's minted target id, a fresh request id", () => {
    const create = (id: string, requestId: string) => ({
      proposalType: "create",
      targetType: "entity",
      targetId: id,
      workspaceId: "ws1",
      data: { requestId, name: "Acme" },
    });
    expect(proposalTwinKey(create("x1", "r1"))).toBe(
      proposalTwinKey(create("x2", "r2"))
    );
  });

  it("keeps the target of a non-create: the same patch on two records is two proposals", () => {
    const update = (targetId: string) => ({
      proposalType: "update",
      targetType: "entity",
      targetId,
      workspaceId: "ws1",
      data: { data: { status: "done" } },
    });
    expect(proposalTwinKey(update("e1"))).not.toBe(
      proposalTwinKey(update("e2"))
    );
  });
});
