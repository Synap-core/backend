/**
 * The ONE dependency rule. Each fixture row names the candidate rule it RULES
 * OUT — a row that rules out nothing is decoration.
 */
import { describe, expect, it } from "vitest";
import {
  LINK_EDGE_ROLES,
  NODE_ZONES,
  deriveNodeNeighbourhood,
  armOptionOf,
  classifyArmBlocker,
  classifyDependencyBlocker,
  deriveOpenBlockers,
  parseArmRef,
  planDecisionArms,
  isBlocked,
  isDependencyEnded,
  isDependencyLinkType,
  isAdvancesPair,
  isPrimaryLinkMetadata,
  isServesPair,
  isWorkLinkType,
  normaliseDependencyRelation,
  ADVANCES_LINK_TYPE,
  DEPENDENCY_LINK_TYPES,
  SERVES_LINK_TYPE,
  WORK_LINK_TYPES,
  type DependencyEdge,
  type DependencyNodeState,
} from "./index.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/statuses.js";
import { TRACK_STATUSES } from "../units/track-status.js";
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

// Status-flow W5: the track outcome is DERIVED from its declaration, not from
// a hand list. Behaviour-neutral: every value the retired lists held (copied
// here verbatim, with the lists that stay) keeps its answer, and every other
// declared track status stays open.
describe("classifyDependencyBlocker — same answers as the hand lists it retired", () => {
  const HAND_LISTS = {
    track: { delivered: ["completed"], dropped: ["archived"] },
    session: { delivered: ["closed"], dropped: ["cancelled", "failed"] },
    entity: {
      delivered: [
        "done",
        "completed",
        "complete",
        "closed",
        "resolved",
        "finished",
        "shipped",
        "closed_won",
      ],
      dropped: ["cancelled", "canceled", "archived", "closed_lost", "wont_do"],
    },
  } as const;
  for (const [kind, lists] of Object.entries(HAND_LISTS)) {
    it(`${kind}: every listed value keeps its outcome`, () => {
      for (const s of lists.delivered) {
        expect(classifyDependencyBlocker(kind, s), s).toBe("delivered");
      }
      for (const s of lists.dropped) {
        expect(classifyDependencyBlocker(kind, s), s).toBe("dropped");
      }
    });
  }
  // Rules out a derivation that clears or drops more than the lists did.
  it("track: every other declared status, and an unknown one, holds", () => {
    const listed: readonly string[] = [
      ...HAND_LISTS.track.delivered,
      ...HAND_LISTS.track.dropped,
    ];
    for (const s of TRACK_STATUSES.filter((t) => !listed.includes(t))) {
      expect(classifyDependencyBlocker("track", s), s).toBe("open");
    }
    for (const s of ["", "Completed", "weird", null, undefined]) {
      expect(classifyDependencyBlocker("track", s), String(s)).toBe("open");
    }
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
  // "Delivered" means the work was done, not that the session closed (founder,
  // 2026-11-20). Rules out "closed clears" (SESSION_DELIVERED_STATUSES =
  // ["closed"], the rule this replaced): the two rules DISAGREE exactly on a
  // closed session whose `closedAs` is not_done.
  it("a session CLOSED with required work open (closedAs not_done) holds, marked dropped", () => {
    const edges = [dep("session", "work", "session", "b")];
    const state = { status: "closed", closedAs: "not_done" as const };
    expect(
      classifyDependencyBlocker("session", "closed", null, "not_done")
    ).toBe("dropped");
    expect(
      deriveOpenBlockers(work, edges, states({ "session:b": state }))
    ).toEqual([
      {
        kind: "session",
        id: "b",
        hidden: false,
        dropped: true,
        status: "closed",
      },
    ]);
  });
  // Rules out the over-correction "only an explicit done clears": a closed
  // row with no close-anyway record (a person's close, every close before
  // the record existed) delivered, so no historical chain re-blocks.
  it("a closed session with closedAs done, or none recorded, clears", () => {
    expect(classifyDependencyBlocker("session", "closed", null, "done")).toBe(
      "delivered"
    );
    expect(classifyDependencyBlocker("session", "closed", null, null)).toBe(
      "delivered"
    );
    // closedAs never makes a not-ended session delivered.
    expect(classifyDependencyBlocker("session", "active", null, "done")).toBe(
      "open"
    );
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

describe("advances — a goal's pillar, a work link, never a dependency", () => {
  // Rules out "advances joined the dependency list": a pillar would start
  // reading as something the goal waits on.
  it("is a work link the door writes, and not a dependency link", () => {
    expect(isWorkLinkType(ADVANCES_LINK_TYPE)).toBe(true);
    expect(isDependencyLinkType(ADVANCES_LINK_TYPE)).toBe(false);
  });
  // Rules out "any unit may advance any space": only a goal advances, and
  // only a space is advanced.
  it("joins track → workspace only", () => {
    expect(isAdvancesPair("track", "workspace")).toBe(true);
    expect(isAdvancesPair("session", "workspace")).toBe(false);
    expect(isAdvancesPair("track", "track")).toBe(false);
    expect(isAdvancesPair("track", "project")).toBe(false);
  });
  // Rules out "a truthy primary counts": only the boolean true marks it.
  it("reads the primary mark as the boolean true only", () => {
    expect(isPrimaryLinkMetadata({ primary: true })).toBe(true);
    expect(isPrimaryLinkMetadata({ primary: "true" })).toBe(false);
    expect(isPrimaryLinkMetadata({ primary: false })).toBe(false);
    expect(isPrimaryLinkMetadata({})).toBe(false);
    expect(isPrimaryLinkMetadata(null)).toBe(false);
  });
  it("reads as Advances / Advanced by", () => {
    expect(resolveLineageEdgeLabel("advances", "outgoing")).toBe("Advances");
    expect(resolveLineageEdgeLabel("advances", "incoming")).toBe("Advanced by");
  });
});

describe("serves — a work link, never a dependency", () => {
  // Rules out "serves joined the dependency list": every blocker reader reads
  // DEPENDENCY_LINK_TYPES, so it would start treating a goal as a blocker.
  it("is a work link the door writes, and not a dependency link", () => {
    expect(isWorkLinkType(SERVES_LINK_TYPE)).toBe(true);
    expect(isDependencyLinkType(SERVES_LINK_TYPE)).toBe(false);
    expect(DEPENDENCY_LINK_TYPES).not.toContain("serves");
    expect(WORK_LINK_TYPES).toEqual([
      "blocked_by",
      "replaces",
      "serves",
      "advances",
    ]);
    for (const t of DEPENDENCY_LINK_TYPES) expect(isWorkLinkType(t)).toBe(true);
    expect(isWorkLinkType("targets")).toBe(false);
    expect(isWorkLinkType(null)).toBe(false);
  });
  // Rules out "any dependency pair may serve": only a session or a sub-goal
  // serves, and only a goal is served.
  it("joins session|track → track only", () => {
    expect(isServesPair("session", "track")).toBe(true);
    expect(isServesPair("track", "track")).toBe(true);
    expect(isServesPair("entity", "track")).toBe(false);
    expect(isServesPair("session", "session")).toBe(false);
    expect(isServesPair("track", "entity")).toBe(false);
  });
  // Rules out "the rule reads every edge it is handed": a serves edge to an
  // open goal must not hold the session up.
  it("deriveOpenBlockers ignores a serves edge to an open goal", () => {
    const S = { kind: "session", id: "s" };
    const edges: DependencyEdge[] = [
      {
        fromType: "session",
        fromId: "s",
        toType: "track",
        toId: "g",
        linkType: "serves",
      },
    ];
    const open = states({ "track:g": { status: "active" } });
    expect(deriveOpenBlockers(S, edges, open)).toEqual([]);
    expect(isBlocked(S, edges, open)).toBe(false);
  });
  it("reads 'Serves' / 'Served by' in the neighbourhood, never reversed", () => {
    const nb = deriveNodeNeighbourhood({ kind: "track", id: "g" }, [
      {
        id: "s",
        kind: "session",
        edgeType: "serves",
        direction: "incoming",
        via: "links",
      },
    ]);
    const items = NODE_ZONES.flatMap((z) => nb[z].items);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: "Served by", reversed: false });
    expect(resolveLineageEdgeLabel("serves", "outgoing")).toBe("Serves");
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

describe("decision arms (P5) — every branch is a decision", () => {
  const arm = (option: string | null, to = "D"): DependencyEdge => ({
    ...dep("session", "S", "entity", to),
    option,
  });
  const decided = (chosenOption: string | null, status = "accepted") =>
    states({
      "entity:D": {
        status,
        category:
          status === "accepted"
            ? "done"
            : status === "rejected"
              ? "lost"
              : "open",
        chosenOption,
      },
    });
  const S = { kind: "session", id: "S" };

  it("the arm CHOSEN clears; another arm holds as NOT TAKEN (rules out 'accepted clears every arm')", () => {
    expect(deriveOpenBlockers(S, [arm("raise")], decided("raise"))).toEqual([]);
    expect(deriveOpenBlockers(S, [arm("bootstrap")], decided("raise"))).toEqual(
      [
        expect.objectContaining({
          kind: "entity",
          id: "D",
          dropped: true,
          notTaken: true,
        }),
      ]
    );
  });

  it("accepted with NOTHING chosen takes no arm (rules out 'no choice reads as yours')", () => {
    expect(deriveOpenBlockers(S, [arm("raise")], decided(null))).toEqual([
      expect.objectContaining({ dropped: true, notTaken: true }),
    ]);
  });

  it("a REJECTED decision holds every arm as dropped, never not-taken (never silently skipped)", () => {
    const [b] = deriveOpenBlockers(
      S,
      [arm("raise")],
      decided("raise", "rejected")
    );
    expect(b).toMatchObject({ dropped: true });
    expect(b!.notTaken).toBeUndefined();
  });

  it("an OPEN decision holds every arm as open", () => {
    expect(
      deriveOpenBlockers(S, [arm("raise")], decided(null, "proposed"))
    ).toEqual([expect.objectContaining({ dropped: false })]);
  });

  it("CONTROL: an edge with no option behaves as before (accepted clears whatever was chosen)", () => {
    expect(deriveOpenBlockers(S, [arm(null)], decided("raise"))).toEqual([]);
    expect(deriveOpenBlockers(S, [arm(null)], decided(null))).toEqual([]);
  });

  it("classifyArmBlocker: only a delivered blocker is split by its option", () => {
    expect(classifyArmBlocker("delivered", "a", "a")).toBe("delivered");
    expect(classifyArmBlocker("delivered", "a", "b")).toBe("not_taken");
    expect(classifyArmBlocker("dropped", "a", "a")).toBe("dropped");
    expect(classifyArmBlocker("open", "a", null)).toBe("open");
    expect(classifyArmBlocker("delivered", null, "b")).toBe("delivered");
  });

  it("armOptionOf reads `links.metadata.option`, nothing else", () => {
    expect(armOptionOf({ option: "raise" })).toBe("raise");
    expect(armOptionOf({ option: " " })).toBeNull();
    expect(armOptionOf({ option: 3 })).toBeNull();
    expect(armOptionOf({ criterionKey: "x" })).toBeNull();
    expect(armOptionOf(null)).toBeNull();
    expect(armOptionOf(["option"])).toBeNull();
  });
});

describe("a SKIPPED step holds nobody (P5: skipped = delivered for ordering)", () => {
  const J = { kind: "session", id: "J" };
  const edges = [dep("session", "J", "session", "A")];

  it("a step skipped as an arm not taken does not hold its dependent", () => {
    expect(
      deriveOpenBlockers(
        J,
        edges,
        states({ "session:A": { status: "cancelled", skipped: true } })
      )
    ).toEqual([]);
  });

  it("the same step cancelled WITHOUT the skip holds it as dropped (rules out 'cancelled clears')", () => {
    expect(
      deriveOpenBlockers(
        J,
        edges,
        states({ "session:A": { status: "cancelled" } })
      )
    ).toEqual([expect.objectContaining({ dropped: true })]);
  });

  it("a skip record on a session that is NOT ended (reopened) frees nobody", () => {
    expect(
      classifyDependencyBlocker("session", "active", null, null, true)
    ).toBe("open");
    expect(
      classifyDependencyBlocker("session", "cancelled", null, "not_done", true)
    ).toBe("delivered");
  });

  it("a join of two exclusive arms waits only on the arm taken", () => {
    const join = [
      dep("session", "J", "session", "A"),
      dep("session", "J", "session", "B"),
    ];
    const st = states({
      "session:A": { status: "closed" },
      "session:B": { status: "cancelled", skipped: true },
    });
    expect(isBlocked(J, join, st)).toBe(false);
    const stillRunning = states({
      "session:A": { status: "active" },
      "session:B": { status: "cancelled", skipped: true },
    });
    expect(deriveOpenBlockers(J, join, stillRunning)).toEqual([
      expect.objectContaining({ id: "A", dropped: false }),
    ]);
  });
});

describe("planDecisionArms — what an accepted decision does to its arms", () => {
  const arms = [
    { stepId: "s-raise", option: "raise" },
    { stepId: "s-boot", option: "bootstrap" },
    { stepId: "s-boot-2", option: "bootstrap" },
  ];

  it("skips every step on an arm not chosen", () => {
    expect(planDecisionArms("raise", arms)).toEqual({
      skip: ["s-boot", "s-boot-2"],
      unmatched: false,
    });
  });

  it("NO arm for the choice: nothing is skipped, the person is told (the n8n trap)", () => {
    expect(planDecisionArms("sell", arms)).toEqual({
      skip: [],
      unmatched: true,
    });
    expect(planDecisionArms(null, arms)).toEqual({ skip: [], unmatched: true });
  });

  it("no arms at all: nothing to do", () => {
    expect(planDecisionArms("raise", [])).toEqual({
      skip: [],
      unmatched: false,
    });
  });
});

describe("parseArmRef — the door's `<decision id>:<option>` form", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  it("splits after the 36-character id; the option may hold more ':'", () => {
    expect(parseArmRef(`${ID}:raise`)).toEqual({ id: ID, option: "raise" });
    expect(parseArmRef(`${ID}:a:b`)).toEqual({ id: ID, option: "a:b" });
  });
  it("a bare id is a plain wait; an empty option is refused", () => {
    expect(parseArmRef(ID)).toEqual({ id: ID, option: null });
    expect(parseArmRef(`${ID}:`)).toBeNull();
    expect(parseArmRef(`${ID}: `)).toBeNull();
  });
});
