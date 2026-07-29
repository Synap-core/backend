import { describe, expect, it } from "vitest";
import {
  reconcileProposedProperties,
  slugifyPropertyKey,
  inferValueType,
  AUTO_REMAP_MAX_FOLDED_DISTANCE,
} from "./property-reconciliation.js";

const SLUGS = ["geo", "score", "segment", "vertical", "funding-amount"];

describe("slugifyPropertyKey", () => {
  it("normalizes labels to the def slug regex", () => {
    expect(slugifyPropertyKey("Geo")).toBe("geo");
    expect(slugifyPropertyKey("Funding Amount")).toBe("funding-amount");
    expect(slugifyPropertyKey("Score!!")).toBe("score");
    expect(slugifyPropertyKey("  Deal   Stage  ")).toBe("deal-stage");
    expect(slugifyPropertyKey("Ann_Recurring")).toBe("ann-recurring");
  });
  it("returns empty when nothing slug-able remains", () => {
    expect(slugifyPropertyKey("!!!")).toBe("");
  });
});

describe("inferValueType", () => {
  it("maps JS values to def value types", () => {
    expect(inferValueType("x")).toBe("string");
    expect(inferValueType(3)).toBe("number");
    expect(inferValueType(true)).toBe("boolean");
    expect(inferValueType([1])).toBe("array");
    expect(inferValueType({ a: 1 })).toBe("object");
    expect(inferValueType(new Date())).toBe("date");
    expect(inferValueType(NaN)).toBe("string");
  });
});

describe("reconcileProposedProperties — defaults (no decisions)", () => {
  it("matched: exact slug is kept as-is, no def", () => {
    const r = reconcileProposedProperties({
      properties: { score: 42 },
      slugs: SLUGS,
    });
    expect(r.properties).toEqual({ score: 42 });
    expect(r.reconciled[0].class).toBe("matched");
    expect(r.defsToCreate).toEqual([]);
  });

  it("remap (distance 0): label-vs-slug casing auto-remaps onto the def slug", () => {
    const r = reconcileProposedProperties({
      properties: { Geo: "EU", Segment: "SMB" },
      slugs: SLUGS,
    });
    expect(r.properties).toEqual({ geo: "EU", segment: "SMB" });
    expect(r.reconciled.every((k) => k.class === "remap")).toBe(true);
    expect(r.reconciled.every((k) => k.source === "default")).toBe(true);
    expect(r.defsToCreate).toEqual([]);
  });

  it("remap (distance 1): single-char typo auto-remaps within threshold", () => {
    expect(AUTO_REMAP_MAX_FOLDED_DISTANCE).toBe(1);
    const r = reconcileProposedProperties({
      properties: { scor: 9 }, // fold distance 1 from "score"
      slugs: SLUGS,
    });
    expect(r.properties).toEqual({ score: 9 });
    expect(r.reconciled[0].class).toBe("remap");
  });

  it("new: no confident match becomes a first-class field + def", () => {
    const r = reconcileProposedProperties({
      properties: { Funding: 1000000, Runway: "18mo" },
      slugs: SLUGS,
    });
    // "Funding" is >1 edit from "funding-amount", so it is NEW, not a remap.
    expect(r.properties).toEqual({ funding: 1000000, runway: "18mo" });
    const classes = r.reconciled.map((k) => k.class);
    expect(classes).toEqual(["new", "new"]);
    expect(r.reconciled.every((k) => k.createDef)).toBe(true);
    expect(r.defsToCreate).toEqual([
      { slug: "funding", label: "Funding", valueType: "number" },
      { slug: "runway", label: "Runway", valueType: "string" },
    ]);
  });
});

describe("reconcileProposedProperties — explicit decisions", () => {
  it("refuse: drops the key, stores nothing, creates no def", () => {
    const r = reconcileProposedProperties({
      properties: { Vertical: "fintech", Runway: "18mo" },
      slugs: SLUGS,
      decisions: { Runway: { action: "refuse" } },
    });
    expect(r.properties).toEqual({ vertical: "fintech" }); // Vertical auto-remaps
    expect("Runway" in r.properties).toBe(false);
    const runway = r.reconciled.find((k) => k.key === "Runway")!;
    expect(runway.finalSlug).toBeNull();
    expect(runway.source).toBe("explicit");
    expect(r.defsToCreate.find((d) => d.slug === "runway")).toBeUndefined();
  });

  it("remap → toSlug: honors an explicit target slug, creates def if novel", () => {
    const r = reconcileProposedProperties({
      properties: { Funding: 5 },
      slugs: SLUGS,
      decisions: { Funding: { action: "remap", toSlug: "funding-amount" } },
    });
    expect(r.properties).toEqual({ "funding-amount": 5 });
    const k = r.reconciled[0];
    expect(k.class).toBe("remap");
    expect(k.finalSlug).toBe("funding-amount");
    expect(k.createDef).toBe(false); // funding-amount already a slug
    expect(r.defsToCreate).toEqual([]);
  });

  it("remap → novel slug: creates a def for it", () => {
    const r = reconcileProposedProperties({
      properties: { ARR: 12 },
      slugs: SLUGS,
      decisions: {
        ARR: { action: "remap", toSlug: "annual-recurring-revenue" },
      },
    });
    expect(r.properties).toEqual({ "annual-recurring-revenue": 12 });
    expect(r.defsToCreate).toEqual([
      { slug: "annual-recurring-revenue", label: "ARR", valueType: "number" },
    ]);
  });

  it("keep: forces a NEW field even when a fuzzy suggestion exists (declines remap)", () => {
    const r = reconcileProposedProperties({
      properties: { Geo: "EU" }, // would auto-remap to "geo" by default
      slugs: SLUGS,
      decisions: { Geo: { action: "keep" } },
    });
    // keep + slugify("Geo")="geo" which IS an existing slug → matched, no dup def
    expect(r.properties).toEqual({ geo: "EU" });
    expect(r.reconciled[0].class).toBe("matched");
    expect(r.reconciled[0].createDef).toBe(false);
  });

  it("keep on a genuinely-new key creates a def", () => {
    const r = reconcileProposedProperties({
      properties: { Moat: "network effects" },
      slugs: SLUGS,
      decisions: { Moat: { action: "keep" } },
    });
    expect(r.properties).toEqual({ moat: "network effects" });
    expect(r.reconciled[0].class).toBe("new");
    expect(r.defsToCreate).toEqual([
      { slug: "moat", label: "Moat", valueType: "string" },
    ]);
  });
});

describe("reconcileProposedProperties — reserved keys", () => {
  it("passes title through untouched, never a def", () => {
    const r = reconcileProposedProperties({
      properties: { title: "Acme", Geo: "EU" },
      slugs: SLUGS,
      reservedKeys: new Set(["title"]),
    });
    expect(r.properties.title).toBe("Acme");
    expect(r.reconciled.find((k) => k.key === "title")!.createDef).toBe(false);
  });
});
