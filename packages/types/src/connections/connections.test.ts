/**
 * The connections rule — fixture rows chosen where plausible WRONG rules
 * disagree with the right one (guards-and-tests.md). Each row names the wrong
 * rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  groupConnections,
  suggestConnections,
  type ConnectionNeighbor,
  type ConnectionRelationType,
} from "./index.js";

const TYPES: ConnectionRelationType[] = [
  {
    slug: "works_at",
    displayName: "Works at",
    inverseLabel: "Employs",
    isDirectional: true,
  },
  { slug: "reports_to", displayName: "Reports to", isDirectional: true },
  { slug: "relates_to", displayName: "Related to", isDirectional: false },
];

const n = (
  p: Partial<ConnectionNeighbor> & { id: string }
): ConnectionNeighbor => ({
  name: p.id,
  kind: "entity",
  subtype: "task",
  edgeType: "relates_to",
  direction: "outgoing",
  via: "relations",
  ...p,
});

describe("groupConnections — labels from THIS side", () => {
  it("incoming with inverseLabel reads the inverse (rules out: displayName always)", () => {
    const { groups } = groupConnections({
      neighbors: [
        n({
          id: "alice",
          subtype: "person",
          edgeType: "works_at",
          direction: "incoming",
        }),
      ],
      relationTypes: TYPES,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Employs",
      reversed: false,
      direction: "incoming",
    });
  });

  it("outgoing reads displayName, not inverse (rules out: inverse always / humanize slug)", () => {
    const { groups } = groupConnections({
      neighbors: [n({ id: "acme", subtype: "company", edgeType: "works_at" })],
      relationTypes: TYPES,
    });
    expect(groups[0]).toMatchObject({ label: "Works at", reversed: false });
  });

  it("incoming WITHOUT inverseLabel keeps displayName but is flagged reversed", () => {
    const { groups } = groupConnections({
      neighbors: [
        n({
          id: "bob",
          subtype: "person",
          edgeType: "reports_to",
          direction: "incoming",
        }),
      ],
      relationTypes: TYPES,
    });
    expect(groups[0]).toMatchObject({ label: "Reports to", reversed: true });
  });

  it("same type, both directions ⇒ two groups (rules out: group by type only)", () => {
    const { groups } = groupConnections({
      neighbors: [
        n({
          id: "acme",
          subtype: "company",
          edgeType: "works_at",
          direction: "outgoing",
        }),
        n({
          id: "carol",
          subtype: "person",
          edgeType: "works_at",
          direction: "incoming",
        }),
      ],
      relationTypes: TYPES,
    });
    expect(groups.map((g) => g.label).sort()).toEqual(["Employs", "Works at"]);
  });

  it("symmetric type merges both directions into ONE group", () => {
    const { groups } = groupConnections({
      neighbors: [
        n({ id: "t1", edgeType: "relates_to", direction: "outgoing" }),
        n({ id: "t2", edgeType: "relates_to", direction: "incoming" }),
      ],
      relationTypes: TYPES,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Related to",
      direction: "both",
      total: 2,
      reversed: false,
    });
  });

  it("unknown type humanizes, never leaks the slug", () => {
    const { groups } = groupConnections({
      neighbors: [n({ id: "x", edgeType: "mentored_by" })],
      relationTypes: TYPES,
    });
    expect(groups[0].label).toBe("Mentored by");
  });
});

describe("groupConnections — what leaves the section", () => {
  it("a link that is also a key fact is dropped (render once)", () => {
    const { groups, total } = groupConnections({
      neighbors: [
        n({ id: "acme", subtype: "company", edgeType: "works_at" }),
        n({ id: "globex", subtype: "company", edgeType: "works_at" }),
      ],
      relationTypes: TYPES,
      keyFactIds: ["acme"],
    });
    expect(total).toBe(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["globex"]);
  });

  it("provenance edges are split out, never a group", () => {
    const { groups, provenance } = groupConnections({
      neighbors: [
        n({
          id: "cap1",
          kind: "capture",
          subtype: null,
          edgeType: "produced",
          direction: "incoming",
          via: "links",
        }),
        n({
          id: "s1",
          kind: "session",
          subtype: null,
          edgeType: "produced_in",
          direction: "incoming",
          via: "produced-in",
        }),
        n({
          id: "p1",
          kind: "proposal",
          subtype: "approved",
          edgeType: "entity.create",
          direction: "incoming",
          via: "governed",
        }),
        n({
          id: "room",
          kind: "channel",
          subtype: null,
          edgeType: "context",
          direction: "structural",
          via: "channel",
        }),
        n({ id: "acme", subtype: "company", edgeType: "works_at" }),
      ],
      relationTypes: TYPES,
    });
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(["acme"]);
    expect(provenance.madeFrom.map((i) => i.id)).toEqual(["cap1"]);
    expect(provenance.inSession?.id).toBe("s1");
    expect(provenance.all.map((i) => i.id)).toEqual([
      "cap1",
      "s1",
      "p1",
      "room",
    ]);
  });

  it("made from TWO captures names both, once each, in input order (rules out: first-only)", () => {
    const cap = (id: string, via = "links") =>
      n({
        id,
        kind: "capture",
        subtype: null,
        edgeType: "produced",
        direction: "incoming",
        via,
      });
    const { provenance } = groupConnections({
      neighbors: [
        cap("memo-a"),
        // The same capture reached a second way: still one source.
        cap("memo-a", "produced-in"),
        cap("memo-b"),
        // Outgoing `produced` (this entity produced a capture) is NOT a source.
        n({
          id: "memo-c",
          kind: "capture",
          subtype: null,
          edgeType: "produced",
          direction: "outgoing",
          via: "links",
        }),
      ],
      relationTypes: TYPES,
    });
    expect(provenance.madeFrom.map((i) => i.id)).toEqual(["memo-a", "memo-b"]);
  });

  it("a property edge twinned with its relation renders once", () => {
    const { groups } = groupConnections({
      neighbors: [
        n({
          id: "acme",
          subtype: "company",
          edgeType: "works_at",
          via: "relations",
        }),
        n({
          id: "acme",
          subtype: "company",
          edgeType: "company",
          via: "property",
        }),
      ],
      relationTypes: TYPES,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].edgeType).toBe("works_at");
  });
});

describe("groupConnections — order and cap", () => {
  it("people, then companies, then by count (rules out: count first)", () => {
    const { groups } = groupConnections({
      neighbors: [
        n({ id: "t1", edgeType: "blocks" }),
        n({ id: "t2", edgeType: "blocks" }),
        n({ id: "t3", edgeType: "blocks" }),
        n({ id: "acme", subtype: "company", edgeType: "works_at" }),
        n({ id: "bob", subtype: "contact", edgeType: "reports_to" }),
        n({ id: "u", edgeType: "", via: "links" }),
      ],
      relationTypes: TYPES,
    });
    expect(groups.map((g) => g.label)).toEqual([
      "Reports to",
      "Works at",
      "Blocks",
      "Also linked",
    ]);
  });

  it("a mixed group does not rank as people", () => {
    const { groups } = groupConnections({
      neighbors: [
        n({ id: "p", subtype: "person", edgeType: "relates_to" }),
        n({ id: "t", edgeType: "relates_to" }),
        n({ id: "acme", subtype: "company", edgeType: "works_at" }),
      ],
      relationTypes: TYPES,
    });
    expect(groups[0].label).toBe("Works at");
  });

  it("cap trims items but total counts all", () => {
    const { groups } = groupConnections({
      neighbors: ["a", "b", "c"].map((id) => n({ id, edgeType: "blocks" })),
      cap: 2,
    });
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].total).toBe(3);
  });

  it("item kind is the entity profile, not the graph kind", () => {
    const { groups } = groupConnections({
      neighbors: [
        n({
          id: "alice",
          subtype: "person",
          edgeType: "works_at",
          direction: "incoming",
        }),
      ],
      relationTypes: TYPES,
    });
    expect(groups[0].items[0]).toMatchObject({
      kind: "person",
      graphKind: "entity",
    });
  });
});

describe("suggestConnections", () => {
  it("reference properties first, then peer usage by count, one per kind, max 3", () => {
    const out = suggestConnections(
      "person",
      {
        referenceProperties: [
          { slug: "company", targetKind: "company", relationType: "works_at" },
          { slug: "project", targetKind: "project", ownerKind: "task" },
        ],
      },
      [
        { edgeType: "attends", targetKind: "event", count: 9 },
        { edgeType: "owns", targetKind: "deal", count: 2 },
        { edgeType: "partner_of", targetKind: "company", count: 50 },
        { edgeType: "wrote", targetKind: "note", count: 1 },
      ]
    );
    expect(out.map((s) => [s.label, s.source])).toEqual([
      ["Company", "property"],
      ["Event", "peers"],
      ["Deal", "peers"],
    ]);
    expect(out[0]).toMatchObject({
      relationType: "works_at",
      propertySlug: "company",
    });
  });

  it("nothing to suggest ⇒ []", () => {
    expect(suggestConnections("idea", {}, [])).toEqual([]);
  });
});
