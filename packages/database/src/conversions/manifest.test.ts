/**
 * DB-less unit tests for the conversion manifest — pure validation and
 * serialisation. No database connection is opened here (imports only manifest.ts).
 */

import { describe, it, expect } from "vitest";
import {
  CONVERSION_MANIFEST,
  CONVERSION_OP_TYPES,
  validateManifest,
  collectOpKeys,
  buildPropertyMappingJson,
  type ConversionManifest,
} from "./manifest.js";

describe("CONVERSION_MANIFEST", () => {
  it("is structurally valid", () => {
    expect(() => validateManifest(CONVERSION_MANIFEST)).not.toThrow();
  });

  it("has globally unique op keys", () => {
    const keys = collectOpKeys(CONVERSION_MANIFEST);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("seeds the generic `item` kind", () => {
    const seed = CONVERSION_MANIFEST.ops.find(
      (o) => o.opKey === "w3a.seed.item"
    );
    expect(seed).toBeDefined();
    expect(seed?.op).toBe("seedKindProfile");
    if (seed?.op === "seedKindProfile") {
      expect(seed.slug).toBe("item");
      expect(seed.entityScope).toBe("pod");
      expect(seed.uiHints?.captureDefault).toBe(true);
    }
  });

  it("keeps person/company/note as audit no-ops (deferred to W3C/W4)", () => {
    for (const slug of ["person", "company", "note"]) {
      const kept = CONVERSION_MANIFEST.ops.find(
        (o) => "slug" in o && o.slug === slug
      );
      expect(kept?.op).toBe("keep");
    }
  });

  it("every op discriminant is a known type", () => {
    for (const op of CONVERSION_MANIFEST.ops) {
      expect(CONVERSION_OP_TYPES).toContain(op.op);
    }
  });
});

describe("CONVERSION_MANIFEST — Wave 3C (CRM-family)", () => {
  it("has globally unique op keys across the grown manifest", () => {
    const keys = collectOpKeys(CONVERSION_MANIFEST);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("orders the item seed before the note/capture merge into item", () => {
    const seedIdx = CONVERSION_MANIFEST.ops.findIndex(
      (o) => o.opKey === "w3a.seed.item"
    );
    const mergeIdx = CONVERSION_MANIFEST.ops.findIndex(
      (o) => o.opKey === "w3c.merge.note-capture-into-item"
    );
    expect(seedIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeLessThan(mergeIdx);
  });

  it("every convertToFacet op has a non-empty applicableKinds", () => {
    const converts = CONVERSION_MANIFEST.ops.filter(
      (o) => o.op === "convertToFacet"
    );
    expect(converts.length).toBeGreaterThan(0);
    for (const op of converts) {
      expect(Array.isArray(op.applicableKinds)).toBe(true);
      expect(op.applicableKinds.length).toBeGreaterThan(0);
    }
  });

  it("every mergeInto op's intoSlug differs from all fromSlugs", () => {
    const merges = CONVERSION_MANIFEST.ops.filter((o) => o.op === "mergeInto");
    expect(merges.length).toBeGreaterThan(0);
    for (const op of merges) {
      expect(op.fromSlugs).not.toContain(op.intoSlug);
    }
  });

  it("declares the six CRM-family convertToFacet ops", () => {
    const expected = [
      ["w3c.convert.contact", "contact", "person"],
      ["w3c.convert.client", "client", "company"],
      ["w3c.convert.partner", "partner", "company"],
      ["w3c.convert.sponsor", "sponsor", "company"],
      ["w3c.convert.competitor", "competitor", "company"],
      ["w3c.convert.lead", "lead", "person"],
    ] as const;
    for (const [opKey, slug, targetKindSlug] of expected) {
      const op = CONVERSION_MANIFEST.ops.find((o) => o.opKey === opKey);
      expect(op).toBeDefined();
      expect(op?.op).toBe("convertToFacet");
      if (op?.op === "convertToFacet") {
        expect(op.slug).toBe(slug);
        expect(op.targetKindSlug).toBe(targetKindSlug);
      }
    }
  });

  it("merges note + capture into item", () => {
    const op = CONVERSION_MANIFEST.ops.find(
      (o) => o.opKey === "w3c.merge.note-capture-into-item"
    );
    expect(op?.op).toBe("mergeInto");
    if (op?.op === "mergeInto") {
      expect(op.fromSlugs).toEqual(["note", "capture"]);
      expect(op.intoSlug).toBe("item");
    }
  });

  it("keeps deal/event/task and the knowledge-family + anchor slugs as audited no-ops", () => {
    for (const slug of [
      "deal",
      "event",
      "task",
      "question",
      "research",
      "decision",
      "knowledge",
      "user_observation",
      "signal_item",
      "anchor",
    ]) {
      const kept = CONVERSION_MANIFEST.ops.find(
        (o) => o.opKey === `w3c.keep.${slug}` && "slug" in o && o.slug === slug
      );
      expect(kept?.op).toBe("keep");
    }
  });
});

describe("CONVERSION_MANIFEST — Wave 4 (knowledge-family)", () => {
  it("has globally unique op keys across the grown manifest", () => {
    const keys = collectOpKeys(CONVERSION_MANIFEST);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("orders every w4 convertToFacet op after the w3c note/capture merge", () => {
    const mergeIdx = CONVERSION_MANIFEST.ops.findIndex(
      (o) => o.opKey === "w3c.merge.note-capture-into-item"
    );
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    const w4Idx = CONVERSION_MANIFEST.ops
      .map((o, i) => [o, i] as const)
      .filter(([o]) => o.opKey.startsWith("w4."));
    expect(w4Idx.length).toBeGreaterThan(0);
    for (const [, i] of w4Idx) {
      expect(i).toBeGreaterThan(mergeIdx);
    }
  });

  it("declares the five knowledge-family convertToFacet ops, all targeting item", () => {
    const expected = [
      ["w4.convert.question", "question"],
      ["w4.convert.research", "research"],
      ["w4.convert.decision", "decision"],
      ["w4.convert.user_observation", "user_observation"],
      ["w4.convert.knowledge", "knowledge"],
    ] as const;
    for (const [opKey, slug] of expected) {
      const op = CONVERSION_MANIFEST.ops.find((o) => o.opKey === opKey);
      expect(op).toBeDefined();
      expect(op?.op).toBe("convertToFacet");
      if (op?.op === "convertToFacet") {
        expect(op.slug).toBe(slug);
        expect(op.targetKindSlug).toBe("item");
        expect(op.applicableKinds).toEqual(["item"]);
      }
    }
  });

  it("every w4 convertToFacet op has a non-empty propertyMapping with real slugs", () => {
    const w4Converts = CONVERSION_MANIFEST.ops.filter(
      (o) => o.op === "convertToFacet" && o.opKey.startsWith("w4.")
    );
    expect(w4Converts.length).toBe(5);
    for (const op of w4Converts) {
      if (op.op !== "convertToFacet") continue;
      const mapping = op.propertyMapping ?? {};
      const entries = Object.entries(mapping);
      expect(entries.length).toBeGreaterThan(0);
      for (const [src, tgt] of entries) {
        expect(src.trim().length).toBeGreaterThan(0);
        expect(tgt.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps signal_item as a w4 audited no-op (not converted)", () => {
    const kept = CONVERSION_MANIFEST.ops.find(
      (o) => o.opKey === "w4.keep.signal_item"
    );
    expect(kept?.op).toBe("keep");
    if (kept?.op === "keep") {
      expect(kept.slug).toBe("signal_item");
    }
  });
});

describe("CONVERSION_MANIFEST — Wave 6 (file → document)", () => {
  it("seeds the `document` kind pod-wide", () => {
    const seed = CONVERSION_MANIFEST.ops.find(
      (o) => o.opKey === "w6.seed.document"
    );
    expect(seed?.op).toBe("seedKindProfile");
    if (seed?.op === "seedKindProfile") {
      expect(seed.slug).toBe("document");
      expect(seed.entityScope).toBe("pod");
    }
  });

  it("merges `file` into `document`", () => {
    const op = CONVERSION_MANIFEST.ops.find(
      (o) => o.opKey === "w6.merge.file-into-document"
    );
    expect(op?.op).toBe("mergeInto");
    if (op?.op === "mergeInto") {
      expect(op.fromSlugs).toEqual(["file"]);
      expect(op.intoSlug).toBe("document");
    }
  });

  it("orders the document seed before the file→document merge", () => {
    const seedIdx = CONVERSION_MANIFEST.ops.findIndex(
      (o) => o.opKey === "w6.seed.document"
    );
    const mergeIdx = CONVERSION_MANIFEST.ops.findIndex(
      (o) => o.opKey === "w6.merge.file-into-document"
    );
    expect(seedIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(seedIdx);
  });

  it("keeps the global reconcile-entity-scope op ahead of the file merge so document per-entity scope is preserved", () => {
    const reconcileIdx = CONVERSION_MANIFEST.ops.findIndex(
      (o) => o.opKey === "w4.reconcile-entity-scope"
    );
    const mergeIdx = CONVERSION_MANIFEST.ops.findIndex(
      (o) => o.opKey === "w6.merge.file-into-document"
    );
    expect(reconcileIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(reconcileIdx);
  });
});

describe("validateManifest", () => {
  it("rejects duplicate op keys", () => {
    const m: ConversionManifest = {
      version: 1,
      ops: [
        { op: "keep", opKey: "dup", slug: "a", note: "x" },
        { op: "keep", opKey: "dup", slug: "b", note: "y" },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/duplicate opKey/);
  });

  it("rejects a missing op key", () => {
    const m: ConversionManifest = {
      version: 1,
      ops: [{ op: "keep", opKey: "", slug: "a", note: "x" }],
    };
    expect(() => validateManifest(m)).toThrow(/missing an opKey/);
  });

  it("rejects a non-positive version", () => {
    expect(() => validateManifest({ version: 0, ops: [] })).toThrow(/version/);
  });

  it("rejects convertToFacet targeting its own slug", () => {
    const m: ConversionManifest = {
      version: 1,
      ops: [
        {
          op: "convertToFacet",
          opKey: "x",
          slug: "investor",
          targetKindSlug: "investor",
          applicableKinds: ["person"],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/cannot target its own slug/);
  });

  it("rejects convertToFacet with no applicableKinds", () => {
    const m: ConversionManifest = {
      version: 1,
      ops: [
        {
          op: "convertToFacet",
          opKey: "x",
          slug: "investor",
          targetKindSlug: "person",
          applicableKinds: [],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/at least one applicableKind/);
  });

  it("rejects mergeInto merging a slug into itself", () => {
    const m: ConversionManifest = {
      version: 1,
      ops: [
        {
          op: "mergeInto",
          opKey: "x",
          fromSlugs: ["knowledge"],
          intoSlug: "knowledge",
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/cannot merge slug/);
  });

  it("rejects mergeInto with no fromSlugs", () => {
    const m: ConversionManifest = {
      version: 1,
      ops: [
        { op: "mergeInto", opKey: "x", fromSlugs: [], intoSlug: "knowledge" },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/at least one fromSlug/);
  });

  it("accepts a well-formed mixed manifest", () => {
    const m: ConversionManifest = {
      version: 2,
      ops: [
        {
          op: "seedKindProfile",
          opKey: "s",
          slug: "item",
          displayName: "Item",
          entityScope: "pod",
        },
        { op: "declareKind", opKey: "d", slug: "person", protected: true },
        {
          op: "convertToFacet",
          opKey: "c",
          slug: "investor",
          targetKindSlug: "person",
          applicableKinds: ["person", "company"],
          propertyMapping: { round: "round" },
          statusFrom: "stage",
        },
        {
          op: "mergeInto",
          opKey: "mi",
          fromSlugs: ["engineering_knowledge"],
          intoSlug: "knowledge",
        },
        { op: "extractNonEntity", opKey: "e", slug: "tmp", note: "moved out" },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });
});

describe("buildPropertyMappingJson", () => {
  it("returns an empty array for undefined mapping", () => {
    expect(buildPropertyMappingJson(undefined)).toBe("[]");
  });

  it("serialises [src, tgt] pairs sorted by source key", () => {
    const json = buildPropertyMappingJson({ zeta: "z", alpha: "a" });
    expect(JSON.parse(json)).toEqual([
      ["alpha", "a"],
      ["zeta", "z"],
    ]);
  });

  it("drops pairs with empty keys or values", () => {
    const json = buildPropertyMappingJson({ good: "g", "": "x", bad: "" });
    expect(JSON.parse(json)).toEqual([["good", "g"]]);
  });
});
