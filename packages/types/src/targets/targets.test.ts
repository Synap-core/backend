import { describe, expect, it } from "vitest";
import {
  PICK_TARGET_KINDS,
  describePickTarget,
  parsePickTarget,
  parseSourceLocation,
  pickTargetToContext,
  type PickTarget,
} from "./index.js";

/** One valid fixture per kind — derived coverage: a new kind without one fails. */
const VALID: Record<(typeof PICK_TARGET_KINDS)[number], PickTarget> = {
  entity: {
    kind: "entity",
    entityId: "e1",
    profileSlug: "person",
    title: "Ada",
  },
  document: { kind: "document", documentId: "d1", heading: "Pricing" },
  cell: { kind: "cell", cellKey: "pipeline-chart", provenance: "stored" },
  widget: { kind: "widget", blockId: "b1", dashboardId: "v1" },
  view_row: { kind: "view_row", viewId: "v1", entityId: "e1" },
  shape: {
    kind: "shape",
    shapeId: "shape:abc",
    shapeType: "note",
    boardId: "w1",
  },
  app_ui: {
    kind: "app_ui",
    appId: "sessions",
    source: { file: "src/A.tsx", line: 4 },
  },
  web: { kind: "web", url: "https://acme.com/pricing", text: "Buy" },
};

describe("parsePickTarget", () => {
  it("round-trips one valid target of EVERY kind", () => {
    for (const kind of PICK_TARGET_KINDS) {
      expect(parsePickTarget(JSON.parse(JSON.stringify(VALID[kind])))).toEqual(
        VALID[kind]
      );
    }
  });

  it("refuses an unknown kind and a missing required id", () => {
    expect(parsePickTarget({ kind: "spaceship", id: "x" })).toBeNull();
    expect(parsePickTarget({ kind: "entity" })).toBeNull();
    expect(parsePickTarget({ kind: "view_row", viewId: "v" })).toBeNull();
    expect(parsePickTarget({ kind: "cell", cellKey: "c" })).toBeNull(); // no provenance
  });

  it("refuses a non-http web url (no javascript:/file: targets)", () => {
    expect(
      parsePickTarget({ kind: "web", url: "javascript:alert(1)" })
    ).toBeNull();
    expect(
      parsePickTarget({ kind: "web", url: "file:///etc/passwd" })
    ).toBeNull();
  });

  it("drops unknown fields and bounds strings", () => {
    const parsed = parsePickTarget({
      kind: "entity",
      entityId: "e1",
      secret: "nope",
      title: "x".repeat(1000),
    });
    expect(parsed).not.toHaveProperty("secret");
    expect(parsed?.title?.length).toBe(300);
  });
});

describe("parseSourceLocation", () => {
  it("reads the build plugin's string form", () => {
    expect(parseSourceLocation("src/apps/A.tsx:12:5")).toEqual({
      file: "src/apps/A.tsx",
      line: 12,
      column: 5,
    });
    expect(parseSourceLocation("nope")).toBeUndefined();
  });
});

describe("describePickTarget", () => {
  it("names the thing through the vocabulary, never a raw kind", () => {
    expect(describePickTarget(VALID.document)).toBe("Document · Pricing");
    expect(describePickTarget(VALID.web)).toBe("Website · acme.com");
    for (const kind of PICK_TARGET_KINDS) {
      expect(describePickTarget(VALID[kind])).not.toMatch(/_/);
    }
  });
});

describe("pickTargetToContext", () => {
  it("flattens to strings, source as file:line", () => {
    expect(pickTargetToContext(VALID.app_ui)).toEqual({
      kind: "app_ui",
      appId: "sessions",
      source: "src/A.tsx:4",
    });
  });
});
