/**
 * The ONE dependency rule. Each fixture row names the candidate rule it RULES
 * OUT — a row that rules out nothing is decoration.
 */
import { describe, expect, it } from "vitest";
import {
  LINK_EDGE_ROLES,
  deriveNodeNeighbourhood,
  deriveOpenBlockers,
  isBlocked,
  isDependencyBlockerCleared,
  normaliseDependencyRelation,
  type DependencyEdge,
  type DependencyNodeState,
} from "./index.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/statuses.js";
import { resolveLineageEdgeLabel } from "../vocabulary/index.js";

const dep = (
  fromType: string,
  fromId: string,
  toType: string,
  toId: string
): DependencyEdge => ({
  fromType,
  fromId,
  toType,
  toId,
  linkType: "blocked_by",
});
const rep = (
  fromType: string,
  fromId: string,
  toType: string,
  toId: string
): DependencyEdge => ({
  fromType,
  fromId,
  toType,
  toId,
  linkType: "replaces",
});

function states(map: Record<string, DependencyNodeState>) {
  return (ref: { kind: string; id: string }) => map[`${ref.kind}:${ref.id}`];
}

describe("normaliseDependencyRelation — direction", () => {
  // Rules out "relation source is always the blocked end".
  it("A blocks B ⇔ B blocked_by A", () => {
    expect(normaliseDependencyRelation("blocks", "A", "B")).toEqual({
      fromId: "B",
      toId: "A",
      linkType: "blocked_by",
    });
  });
  // Rules out "relation target is always the blocked end".
  it("A depends_on B ⇔ A blocked_by B", () => {
    expect(normaliseDependencyRelation("depends_on", "A", "B")).toEqual({
      fromId: "A",
      toId: "B",
      linkType: "blocked_by",
    });
  });
  // Rules out "every relation becomes a dependency".
  it("any other slug stays a relation", () => {
    expect(normaliseDependencyRelation("relates_to", "A", "B")).toBeNull();
  });
});

describe("isDependencyBlockerCleared — per kind", () => {
  it("session: parity with the pod reader (open ⇔ OPEN_SESSION_STATUSES)", () => {
    for (const s of OPEN_SESSION_STATUSES) {
      expect(isDependencyBlockerCleared("session", s), s).toBe(false);
    }
    for (const s of ["closed", "cancelled", "failed", "stale"]) {
      expect(isDependencyBlockerCleared("session", s), s).toBe(true);
    }
  });
  // Rules out "one global done list": `completed` clears a track but `active`
  // does not, and an entity `Done` clears while a session `done` (not a
  // session status) is not open either — each kind reads its own vocabulary.
  it("track: completed / archived clear; active / paused do not", () => {
    expect(isDependencyBlockerCleared("track", "completed")).toBe(true);
    expect(isDependencyBlockerCleared("track", "archived")).toBe(true);
    expect(isDependencyBlockerCleared("track", "active")).toBe(false);
    expect(isDependencyBlockerCleared("track", "paused")).toBe(false);
  });
  it("entity: folded status values; no status ⇒ still blocking", () => {
    expect(isDependencyBlockerCleared("entity", "Done")).toBe(true);
    expect(isDependencyBlockerCleared("entity", "closed-won")).toBe(true);
    expect(isDependencyBlockerCleared("entity", "Resolved")).toBe(true);
    expect(isDependencyBlockerCleared("entity", "in_progress")).toBe(false);
    expect(isDependencyBlockerCleared("entity", null)).toBe(false);
  });
  it("unknown kind never clears", () => {
    expect(isDependencyBlockerCleared("playbook", "completed")).toBe(false);
  });
});

describe("deriveOpenBlockers — cross-kind", () => {
  const task = { kind: "entity", id: "task" };
  // Rules out "dependency = session→session only" (the pre-B4 reader).
  it("an entity blocked by a session and a track is blocked while either is open", () => {
    const edges = [
      dep("entity", "task", "session", "s1"),
      dep("entity", "task", "track", "t1"),
    ];
    const open = deriveOpenBlockers(
      task,
      edges,
      states({
        "session:s1": { status: "closed" },
        "track:t1": { status: "active" },
      })
    );
    expect(open.map((b) => `${b.kind}:${b.id}`)).toEqual(["track:t1"]);
    expect(
      isBlocked(
        task,
        edges,
        states({
          "session:s1": { status: "closed" },
          "track:t1": { status: "completed" },
        })
      )
    ).toBe(false);
  });

  // Rules out "the edge's TO end is the blocked one" (reading it backwards).
  it("the TO end of blocked_by is the blocker, never the blocked", () => {
    const edges = [dep("entity", "other", "entity", "task")];
    expect(
      isBlocked(task, edges, states({ "entity:other": { status: "todo" } }))
    ).toBe(false);
  });

  // Rules out "unknown status reads as cleared" (a failed lookup = calm, wrong).
  it("an unknown blocker state blocks; a missing row does not; a hidden one blocks without a name", () => {
    const edges = [
      dep("entity", "task", "entity", "u"),
      dep("entity", "task", "entity", "gone"),
      dep("entity", "task", "entity", "secret"),
    ];
    const open = deriveOpenBlockers(
      task,
      edges,
      states({
        "entity:gone": { missing: true },
        "entity:secret": { hidden: true, status: "done" },
      })
    );
    expect(open.map((b) => [b.id, b.hidden])).toEqual([
      ["u", false],
      ["secret", true],
    ]);
  });
});

describe("deriveOpenBlockers — replaces", () => {
  const outcome = { kind: "session", id: "outcome" };
  const edges = [
    dep("session", "outcome", "session", "stepA"),
    rep("session", "stepB", "session", "stepA"),
  ];
  // Rules out "a replaced blocker keeps blocking": stepA failed, stepB is the
  // attempt instead — stepA's own (open/failed) state no longer decides.
  it("waits on the replacement, not the replaced step", () => {
    const open = deriveOpenBlockers(
      outcome,
      edges,
      states({
        "session:stepA": { status: "active" },
        "session:stepB": { status: "active" },
      })
    );
    expect(open).toEqual([
      {
        kind: "session",
        id: "stepB",
        hidden: false,
        replaces: { kind: "session", id: "stepA" },
      },
    ]);
  });
  // Rules out "a failed (terminal) replaced step clears the dependent early".
  it("a failed replaced step does not clear the dependent while its replacement is open", () => {
    expect(
      isBlocked(
        outcome,
        edges,
        states({
          "session:stepA": { status: "failed" },
          "session:stepB": { status: "active" },
        })
      )
    ).toBe(true);
    expect(
      isBlocked(
        outcome,
        edges,
        states({
          "session:stepA": { status: "active" },
          "session:stepB": { status: "closed" },
        })
      )
    ).toBe(false);
  });
  it("a replacement cycle terminates", () => {
    const cyc = [
      dep("session", "outcome", "session", "a"),
      rep("session", "b", "session", "a"),
      rep("session", "a", "session", "b"),
    ];
    expect(() =>
      deriveOpenBlockers(outcome, cyc, () => undefined)
    ).not.toThrow();
  });
});

describe("neighbourhood labels for the dependency + replaces edges", () => {
  it("incoming blocked_by reads 'Blocks' (not a reversed forward label)", () => {
    const nb = deriveNodeNeighbourhood({ kind: "entity", id: "f" }, [
      {
        id: "x",
        kind: "entity",
        edgeType: "blocked_by",
        direction: "incoming",
        via: "links",
      },
      {
        id: "y",
        kind: "track",
        edgeType: "blocked_by",
        direction: "outgoing",
        via: "links",
      },
    ]);
    expect(nb.servesAndBlocks.items[0]).toMatchObject({
      label: "Blocks",
      reversed: false,
    });
    expect(nb.blockedBy.items[0]).toMatchObject({
      label: "Blocked by",
      graphKind: "track",
    });
  });
  it("replaces sits in Related, reading 'Replaces' / 'Replaced by'", () => {
    expect(LINK_EDGE_ROLES.replaces).toEqual({
      outgoing: "related",
      incoming: "related",
    });
    const nb = deriveNodeNeighbourhood({ kind: "session", id: "f" }, [
      {
        id: "old",
        kind: "session",
        edgeType: "replaces",
        direction: "outgoing",
        via: "links",
      },
      {
        id: "new",
        kind: "session",
        edgeType: "replaces",
        direction: "incoming",
        via: "links",
      },
    ]);
    expect(nb.related.items.map((i) => [i.id, i.label, i.reversed])).toEqual([
      ["old", "Replaces", false],
      ["new", "Replaced by", false],
    ]);
    expect(resolveLineageEdgeLabel("replaces", "incoming")).toBe("Replaced by");
  });
});

describe("dependencyLinkAsRelation (inverse of normaliseDependencyRelation)", () => {
  it("round-trips both legacy slugs through the one edge", async () => {
    const { dependencyLinkAsRelation, normaliseDependencyRelation } =
      await import("./index.js");
    for (const type of ["blocks", "depends_on"] as const) {
      const edge = normaliseDependencyRelation(type, "src", "tgt")!;
      expect(dependencyLinkAsRelation(type, edge.fromId, edge.toId)).toEqual({
        sourceId: "src",
        targetId: "tgt",
      });
    }
  });

  it("reads X blocked_by Y as Y blocks X and X depends_on Y", async () => {
    const { dependencyLinkAsRelation } = await import("./index.js");
    expect(dependencyLinkAsRelation("blocks", "x", "y")).toEqual({
      sourceId: "y",
      targetId: "x",
    });
    expect(dependencyLinkAsRelation("depends_on", "x", "y")).toEqual({
      sourceId: "x",
      targetId: "y",
    });
  });
});
