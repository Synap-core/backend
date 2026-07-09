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
