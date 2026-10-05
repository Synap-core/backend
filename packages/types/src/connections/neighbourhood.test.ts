/**
 * The node-neighbourhood role table. Each fixture row exists because it RULES
 * OUT a candidate rule — the comment on each says which. "Every incoming edge
 * is Came from" (the retired browser `lineage-model.ts` rule) fails the
 * session-targets, member-of and blocked_by rows; "anything pointing at it is
 * work" fails the capability-member row; "dependency = relations only" fails
 * the links blocked_by rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINK_EDGE_ROLES,
  NODE_ZONES,
  NODE_ZONE_CAP,
  RELATION_EDGE_ROLES,
  VIA_EDGE_ROLES,
  deriveNodeNeighbourhood,
  isProvenanceEdge,
  zoneOf,
  type NodeNeighbourhood,
  type NodeZone,
  type WireGraphNeighbor,
} from "./index.js";

const FOCUS = { kind: "entity", id: "focus" };

function edge(partial: Partial<WireGraphNeighbor>): WireGraphNeighbor {
  return {
    id: "x",
    name: "X",
    kind: "entity",
    subtype: null,
    edgeType: "relates_to",
    direction: "outgoing",
    via: "relations",
    ...partial,
  };
}

function zoneIds(nb: NodeNeighbourhood, zone: NodeZone): string[] {
  return nb[zone].items.map((i) => i.id);
}

function only(n: WireGraphNeighbor): NodeZone {
  const nb = deriveNodeNeighbourhood(FOCUS, [n]);
  const zones = NODE_ZONES.filter((z) => nb[z].total > 0);
  expect(zones, `exactly one zone for ${JSON.stringify(n)}`).toHaveLength(1);
  return zones[0]!;
}

describe("deriveNodeNeighbourhood — discriminating rows", () => {
  it("a session TARGETING the focus is work on it, not where it came from", () => {
    // Rules out "incoming ⇒ cameFrom".
    expect(
      only(
        edge({
          kind: "session",
          edgeType: "targets",
          direction: "incoming",
          via: "links",
        })
      )
    ).toBe("workingOnIt");
  });

  it("the session the focus targets is what it serves", () => {
    expect(
      only(
        edge({
          kind: "project",
          edgeType: "targets",
          direction: "outgoing",
          via: "links",
        })
      )
    ).toBe("servesAndBlocks");
  });

  it("links `produced`: the capture it was made from / the entity it made", () => {
    expect(
      only(
        edge({
          kind: "capture",
          edgeType: "produced",
          direction: "incoming",
          via: "links",
        })
      )
    ).toBe("cameFrom");
    expect(
      only(
        edge({
          kind: "entity",
          edgeType: "produced",
          direction: "outgoing",
          via: "links",
        })
      )
    ).toBe("became");
  });

  it("the governing proposal and the session it happened in came first", () => {
    expect(
      only(
        edge({
          kind: "proposal",
          edgeType: "create_entity",
          direction: "incoming",
          via: "governed",
        })
      )
    ).toBe("cameFrom");
    expect(
      only(
        edge({
          kind: "session",
          edgeType: "produced_in",
          direction: "incoming",
          via: "produced-in",
        })
      )
    ).toBe("cameFrom");
  });

  it("a PROPOSAL focus: what it governed is what it became", () => {
    expect(
      only(
        edge({
          kind: "entity",
          edgeType: "create_entity",
          direction: "outgoing",
          via: "governed",
        })
      )
    ).toBe("became");
  });

  it("the track FK fold: project it serves, method it came from, sessions working on it", () => {
    const nb = deriveNodeNeighbourhood({ kind: "track", id: "t" }, [
      edge({
        id: "p",
        kind: "project",
        edgeType: "member_of",
        direction: "outgoing",
        via: "structure",
      }),
      edge({
        id: "pb",
        kind: "playbook",
        edgeType: "instantiated_from",
        direction: "outgoing",
        via: "structure",
      }),
      edge({
        id: "s",
        kind: "session",
        edgeType: "member_of",
        direction: "incoming",
        via: "structure",
      }),
    ]);
    expect(zoneIds(nb, "servesAndBlocks")).toEqual(["p"]);
    expect(zoneIds(nb, "cameFrom")).toEqual(["pb"]);
    expect(zoneIds(nb, "workingOnIt")).toEqual(["s"]);
  });

  it("links `blocked_by` reads from BOTH ends", () => {
    // focus --blocked_by--> s1: the focus waits on s1.
    expect(
      only(
        edge({
          kind: "session",
          edgeType: "blocked_by",
          direction: "outgoing",
          via: "links",
        })
      )
    ).toBe("blockedBy");
    // s2 --blocked_by--> focus: the focus blocks s2.
    expect(
      only(
        edge({
          kind: "session",
          edgeType: "blocked_by",
          direction: "incoming",
          via: "links",
        })
      )
    ).toBe("servesAndBlocks");
  });

  it("relations `blocks` / `depends_on` are the same dependency, mirrored", () => {
    // a --blocks--> focus  ⇒ focus is blocked by a
    expect(only(edge({ edgeType: "blocks", direction: "incoming" }))).toBe(
      "blockedBy"
    );
    expect(only(edge({ edgeType: "blocks", direction: "outgoing" }))).toBe(
      "servesAndBlocks"
    );
    // focus --depends_on--> b ⇒ focus is blocked by b
    expect(only(edge({ edgeType: "depends_on", direction: "outgoing" }))).toBe(
      "blockedBy"
    );
    expect(only(edge({ edgeType: "depends_on", direction: "incoming" }))).toBe(
      "servesAndBlocks"
    );
  });

  it("a capability's member TOOL is related; a playbook's member RULE is work", () => {
    // Rules out "anything pointing at it is work": the worker guard.
    expect(
      only(
        edge({
          kind: "tool",
          edgeType: "member_of",
          direction: "incoming",
          via: "links",
        })
      )
    ).toBe("related");
    expect(
      only(
        edge({
          kind: "automation",
          edgeType: "member_of",
          direction: "incoming",
          via: "links",
        })
      )
    ).toBe("workingOnIt");
  });

  it("a rule that activates the focus is working on it; what it activates it became", () => {
    expect(
      only(
        edge({
          kind: "automation",
          edgeType: "activates",
          direction: "incoming",
          via: "links",
        })
      )
    ).toBe("workingOnIt");
    expect(
      only(
        edge({
          kind: "playbook",
          edgeType: "activates",
          direction: "outgoing",
          via: "links",
        })
      )
    ).toBe("became");
  });

  it("a fork reads Came from on the child and Became on the parent", () => {
    expect(
      only(
        edge({
          kind: "session",
          edgeType: "spawned_from",
          direction: "outgoing",
          via: "links",
        })
      )
    ).toBe("cameFrom");
    expect(
      only(
        edge({
          kind: "session",
          edgeType: "spawned_from",
          direction: "incoming",
          via: "links",
        })
      )
    ).toBe("became");
  });

  it("an unknown relation slug, an unknown via and a structural edge are related — never dropped", () => {
    const nb = deriveNodeNeighbourhood(FOCUS, [
      edge({ id: "a", edgeType: "sponsored_by" }),
      edge({ id: "b", via: "brand_new_substrate", edgeType: "x" }),
      edge({ id: "c", direction: "structural", edgeType: "blocks" }),
    ]);
    expect(zoneIds(nb, "related")).toEqual(["a", "b", "c"]);
    expect(nb.total).toBe(3);
  });

  it("a session ABOUT the entity (focus_sessions.subjectEntityId) is work on it", () => {
    expect(
      only(
        edge({
          kind: "session",
          edgeType: "Session",
          direction: "incoming",
          via: "session",
        })
      )
    ).toBe("workingOnIt");
  });
});

describe("deriveNodeNeighbourhood — render once, cap, identity", () => {
  it("one far end reached by two edges renders once, in the zone that says most", () => {
    const nb = deriveNodeNeighbourhood(FOCUS, [
      edge({
        id: "s",
        kind: "session",
        edgeType: "targets",
        direction: "incoming",
        via: "links",
      }),
      edge({
        id: "s",
        kind: "session",
        edgeType: "produced",
        direction: "incoming",
        via: "links",
      }),
    ]);
    expect(zoneIds(nb, "cameFrom")).toEqual(["s"]);
    expect(nb.workingOnIt.total).toBe(0);
    expect(nb.total).toBe(1);
  });

  it("drops the entity_id property twin of a relation, and the focus itself", () => {
    const nb = deriveNodeNeighbourhood(FOCUS, [
      edge({ id: "co", edgeType: "works_at", via: "relations" }),
      edge({ id: "co", edgeType: "company", via: "property" }),
      edge({ id: "focus", kind: "entity", edgeType: "relates_to" }),
    ]);
    expect(nb.total).toBe(1);
    expect(nb.related.items[0]!.via).toBe("relations");
  });

  it("caps every zone at NODE_ZONE_CAP and keeps the true total", () => {
    const many = Array.from({ length: NODE_ZONE_CAP + 3 }, (_, i) =>
      edge({ id: `r${i}` })
    );
    const nb = deriveNodeNeighbourhood(FOCUS, many);
    expect(nb.related.items).toHaveLength(NODE_ZONE_CAP);
    expect(nb.related.total).toBe(NODE_ZONE_CAP + 3);
    const uncapped = deriveNodeNeighbourhood(FOCUS, many, {
      cap: Number.POSITIVE_INFINITY,
    });
    expect(uncapped.related.items).toHaveLength(NODE_ZONE_CAP + 3);
  });

  it("names an entity by its profile slug and routes it by its graph kind", () => {
    const [item] = deriveNodeNeighbourhood(FOCUS, [
      edge({ id: "p", subtype: "person", name: "Théo" }),
    ]).related.items;
    expect(item).toMatchObject({
      kind: "person",
      graphKind: "entity",
      title: "Théo",
    });
  });

  it("labels from THIS side: relation defs, curated lineage words, else a reversed mark", () => {
    const nb = deriveNodeNeighbourhood(
      FOCUS,
      [
        edge({ id: "co", edgeType: "works_at", direction: "incoming" }),
        edge({
          id: "cap",
          kind: "capture",
          edgeType: "produced",
          direction: "incoming",
          via: "links",
        }),
        edge({
          id: "s2",
          kind: "session",
          edgeType: "blocked_by",
          direction: "incoming",
          via: "links",
        }),
      ],
      {
        relationTypes: [
          { type: "works_at", label: "Works At", inverseLabel: "Employs" },
        ],
      }
    );
    expect(nb.related.items[0]).toMatchObject({
      label: "Employs",
      reversed: false,
    });
    expect(nb.cameFrom.items[0]).toMatchObject({
      label: "Made from",
      reversed: false,
    });
    // No curated inverse for blocked_by yet: forward words + the reversed mark,
    // never "Blocked by" presented as if it were true from the blocker's side.
    expect(nb.servesAndBlocks.items[0]).toMatchObject({
      label: "Blocked by",
      reversed: true,
    });
  });

  it("flags the substrate it runs on (capability grant, linked tool/skill)", () => {
    const nb = deriveNodeNeighbourhood(FOCUS, [
      edge({ id: "c", kind: "capability", via: "grant", edgeType: "granted" }),
      edge({ id: "t", kind: "tool", via: "links", edgeType: "used" }),
      edge({ id: "a", kind: "agent", via: "grant", edgeType: "granted_to" }),
    ]);
    const powered = nb.related.items
      .filter((i) => i.poweredBy)
      .map((i) => i.id);
    expect(powered).toEqual(["c", "t"]);
  });
});

describe("the role table is the provenance rule", () => {
  /** The rule `isProvenanceEdge` carried before it read the table. */
  const LEGACY_PROVENANCE_VIAS = new Set([
    "governed",
    "produced-in",
    "body",
    "channel",
    "session",
  ]);
  const legacy = (via: string, edgeType: string) =>
    LEGACY_PROVENANCE_VIAS.has(via) ||
    (via === "links" && edgeType === "produced");

  it("agrees with the legacy provenance rule on every classified (via, edge) pair", () => {
    const pairs: Array<[string, string]> = [];
    for (const via of Object.keys(VIA_EDGE_ROLES)) {
      const types =
        via === "links"
          ? Object.keys(LINK_EDGE_ROLES)
          : via === "relations"
            ? Object.keys(RELATION_EDGE_ROLES)
            : ["anything"];
      for (const t of types) pairs.push([via, t]);
    }
    // Non-vacuity: the scan sees every link type and every via.
    expect(pairs.length).toBeGreaterThan(40);
    for (const [via, edgeType] of pairs) {
      expect(
        isProvenanceEdge({
          id: "x",
          name: "x",
          kind: "entity",
          edgeType,
          direction: "incoming",
          via,
        }),
        `${via}/${edgeType}`
      ).toBe(legacy(via, edgeType));
    }
  });

  it("every role resolves to a real zone from both ends, for workers and non-workers", () => {
    for (const via of Object.keys(VIA_EDGE_ROLES)) {
      for (const t of [
        ...Object.keys(LINK_EDGE_ROLES),
        ...Object.keys(RELATION_EDGE_ROLES),
      ]) {
        for (const direction of ["incoming", "outgoing", "structural"]) {
          for (const kind of ["session", "tool"]) {
            expect(NODE_ZONES).toContain(
              zoneOf({ kind, edgeType: t, direction, via })
            );
          }
        }
      }
    }
  });
});

describe("the shared golden's LIVE pod rows all land somewhere", () => {
  const golden = JSON.parse(
    readFileSync(
      join(__dirname, "__fixtures__/connections.golden.json"),
      "utf8"
    )
  ) as {
    liveRows: Array<{ name: string; neighbors: WireGraphNeighbor[] }>;
  };

  it("no live neighbour is lost (zone totals = distinct far ends)", () => {
    expect(golden.liveRows.length).toBeGreaterThan(0);
    for (const row of golden.liveRows) {
      const nb = deriveNodeNeighbourhood(null, row.neighbors, {
        cap: Number.POSITIVE_INFINITY,
      });
      const sum = NODE_ZONES.reduce((s, z) => s + nb[z].total, 0);
      expect(sum, row.name).toBe(nb.total);
      expect(nb.total, row.name).toBeGreaterThan(0);
    }
  });
});
