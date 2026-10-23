/**
 * The ONE dependency rule. Each fixture row names the candidate rule it RULES
 * OUT — a row that rules out nothing is decoration.
 */
import { describe, expect, it } from "vitest";
import {
  LINK_EDGE_ROLES,
  deriveNodeNeighbourhood,
  classifyDependencyBlocker,
  deriveOpenBlockers,
  isBlocked,
  isDependencyEnded,
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

describe("classifyDependencyBlocker — per kind", () => {
  // Rules out "every terminal status clears" (the rule this replaced: a
  // cancelled / failed blocker settled exactly like a closed one) AND "every
  // non-open status clears" (`stale` is resumable, not ended).
  it("session: only `closed` delivers; cancelled / failed are dropped; open and stale hold", () => {
    expect(classifyDependencyBlocker("session", "closed")).toBe("delivered");
    for (const s of ["cancelled", "failed"]) {
      expect(classifyDependencyBlocker("session", s), s).toBe("dropped");
    }
    for (const s of [...OPEN_SESSION_STATUSES, "stale", null, "weird"]) {
      expect(classifyDependencyBlocker("session", s), String(s)).toBe("open");
    }
  });
  // Rules out "one global done list": `completed` delivers a track but
  // `archived` is the goal DROPPED ("archive it when the goal is dropped").
  it("track: completed delivers; archived is dropped; active / paused hold", () => {
    expect(classifyDependencyBlocker("track", "completed")).toBe("delivered");
    expect(classifyDependencyBlocker("track", "archived")).toBe("dropped");
    expect(classifyDependencyBlocker("track", "active")).toBe("open");
    expect(classifyDependencyBlocker("track", "paused")).toBe("open");
  });
  it("entity: folded status values split delivered / dropped; no status ⇒ open", () => {
    expect(classifyDependencyBlocker("entity", "Done")).toBe("delivered");
    expect(classifyDependencyBlocker("entity", "closed-won")).toBe("delivered");
    expect(classifyDependencyBlocker("entity", "Resolved")).toBe("delivered");
    expect(classifyDependencyBlocker("entity", "Cancelled")).toBe("dropped");
    expect(classifyDependencyBlocker("entity", "closed lost")).toBe("dropped");
    expect(classifyDependencyBlocker("entity", "wont-do")).toBe("dropped");
    expect(classifyDependencyBlocker("entity", "archived")).toBe("dropped");
    expect(classifyDependencyBlocker("entity", "in_progress")).toBe("open");
    expect(classifyDependencyBlocker("entity", null)).toBe("open");
  });
  // Rules out "read the option KEY even when the kind declares a lifecycle":
  // a custom key the lists do not know (`published`, `rejected`) is decided by
  // its category, and a category outranks a key that LOOKS finished.
  it("entity: a known lifecycle category outranks the key", () => {
    expect(classifyDependencyBlocker("entity", "published", "done")).toBe(
      "delivered"
    );
    expect(classifyDependencyBlocker("entity", "rejected", "lost")).toBe(
      "dropped"
    );
    expect(classifyDependencyBlocker("entity", "done", "active")).toBe("open");
  });
  it("unknown kind is open", () => {
    expect(classifyDependencyBlocker("playbook", "completed")).toBe("open");
  });
  // `isDependencyEnded` is "no longer live", either way — the row-mark and
  // "dependent still waiting" test, NOT "stopped blocking".
  it("isDependencyEnded is delivered OR dropped", () => {
    expect(isDependencyEnded("session", "closed")).toBe(true);
    expect(isDependencyEnded("session", "cancelled")).toBe(true);
    expect(isDependencyEnded("session", "active")).toBe(false);
    expect(isDependencyEnded("entity", "Done")).toBe(true);
    expect(isDependencyEnded("entity", "wont_do")).toBe(true);
    expect(isDependencyEnded("entity", null)).toBe(false);
  });
});

describe("deriveOpenBlockers — dropped vs delivered (founder decision 2026-10-22)", () => {
  const work = { kind: "session", id: "work" };
  // One fixture per kind where the OLD rule and the new one DISAGREE: under
  // the old rule each of these blockers had settled and `work` read free.
  it.each([
    ["session", { status: "cancelled" }],
    ["session", { status: "failed" }],
    ["track", { status: "archived" }],
    ["entity", { status: "Cancelled" }],
    ["entity", { status: "rejected", category: "lost" as const }],
  ])(
    "a %s blocker that ended without delivering (%o) still holds, marked dropped",
    (kind, state) => {
      const edges = [dep("session", "work", kind, "b")];
      const open = deriveOpenBlockers(
        work,
        edges,
        states({ [`${kind}:b`]: { ...state, title: "The prerequisite" } })
      );
      expect(open).toEqual([
        {
          kind,
          id: "b",
          hidden: false,
          dropped: true,
          status: state.status,
          title: "The prerequisite",
        },
      ]);
      expect(isBlocked(work, edges, states({ [`${kind}:b`]: state }))).toBe(
        true
      );
    }
  );
  // The other half: a DELIVERED blocker still clears, per kind.
  it.each([
    ["session", { status: "closed" }],
    ["track", { status: "completed" }],
    ["entity", { status: "Done" }],
    ["entity", { status: "published", category: "done" as const }],
  ])("a delivered %s blocker (%o) clears", (kind, state) => {
    const edges = [dep("session", "work", kind, "b")];
    expect(
      deriveOpenBlockers(work, edges, states({ [`${kind}:b`]: state }))
    ).toEqual([]);
  });
  // Rules out "stale settles" (it did: stale ∉ OPEN_SESSION_STATUSES).
  it("a stale session blocker holds as OPEN, not dropped", () => {
    const edges = [dep("session", "work", "session", "b")];
    expect(
      deriveOpenBlockers(
        work,
        edges,
        states({ "session:b": { status: "stale" } })
      )
    ).toEqual([
      {
        kind: "session",
        id: "b",
        hidden: false,
        dropped: false,
        status: "stale",
      },
    ]);
  });
  // A replacement re-plans the dependent: whoever waited on the dropped B now
  // waits on A, and A's own outcome decides.
  it("a dropped blocker with a replacement is decided by the replacement", () => {
    const edges = [
      dep("session", "work", "session", "b"),
      rep("session", "a", "session", "b"),
    ];
    expect(
      deriveOpenBlockers(
        work,
        edges,
        states({
          "session:b": { status: "cancelled" },
          "session:a": { status: "closed" },
        })
      )
    ).toEqual([]);
    expect(
      deriveOpenBlockers(
        work,
        edges,
        states({
          "session:b": { status: "cancelled" },
          "session:a": { status: "active", title: "Second try" },
        })
      )
    ).toEqual([
      {
        kind: "session",
        id: "a",
        hidden: false,
        dropped: false,
        status: "active",
        title: "Second try",
        replaces: { kind: "session", id: "b" },
      },
    ]);
  });
  // A hidden blocker never reveals its status or name, and is never called
  // dropped (that would be a fact about it the reader may not see).
  it("a hidden blocker reports neither status, title nor dropped", () => {
    const edges = [dep("session", "work", "entity", "secret")];
    expect(
      deriveOpenBlockers(
        work,
        edges,
        states({
          "entity:secret": {
            hidden: true,
            status: "cancelled",
            title: "Secret",
          },
        })
      )
    ).toEqual([{ kind: "entity", id: "secret", hidden: true, dropped: false }]);
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
        dropped: false,
        status: "active",
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
