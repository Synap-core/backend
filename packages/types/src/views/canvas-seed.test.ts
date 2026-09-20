import { describe, expect, it } from "vitest";

import { parseViewContent, safeParseViewContent } from "./schemas.js";

/**
 * Canvas seed content — the ONLY server-side path that can put shapes on a
 * whiteboard.
 *
 * A whiteboard's shapes live as plain JSON `{ store: { <tldrawRecordId>:
 * <record> } }` in the document's MinIO object. `packages/realtime`'s Yjs
 * `bindState` hydrates a room from that blob on open (`parsed.store ?? parsed`)
 * and `writeState` serialises back to it. `views.create` writes the blob once,
 * at create time; there is no content-update door.
 *
 * Before 2026-09-20 `store` was NOT declared on `CanvasViewContentSchema`, and
 * the seed path worked only by accident: `views.create` declares
 * `initialContent: z.any()` and stringifies the RAW input rather than the
 * parsed result, so an undeclared `store` survived validation-by-stripping.
 * Any refactor to `parseResult.data` — the obvious cleanup — would have
 * silently dropped every seeded shape while every test stayed green.
 *
 * These tests pin the field so that cannot happen.
 */
describe("canvas view content — the whiteboard seed", () => {
  const record = {
    "shape:hero": {
      id: "shape:hero",
      type: "geo",
      x: 120,
      y: 80,
      props: { w: 200, h: 90, text: "checkPermissionOrPropose()" },
    },
  };

  it("PRESERVES `store` through a parse — the field a seed actually travels in", () => {
    const parsed = parseViewContent({
      version: 1,
      category: "canvas",
      store: record,
    });

    // Reachability, not shape: assert the RECORD ARRIVES, not merely that a
    // `store` key is declared somewhere. A declared-but-stripped field is the
    // exact defect this file exists to prevent.
    expect(parsed.category).toBe("canvas");
    expect(parsed).toHaveProperty("store");
    const store = (parsed as { store?: Record<string, unknown> }).store;
    expect(store).toBeDefined();
    expect(store).toHaveProperty("shape:hero");
    expect(
      (store?.["shape:hero"] as { props: { text: string } }).props.text
    ).toBe("checkPermissionOrPropose()");
  });

  it("accepts a seed with NO `elements` key", () => {
    // `elements` is named by the schema but read by nobody — bindState reads
    // `store`. Requiring it would force every caller to send `elements: []` as
    // a superstition, so it is optional.
    const result = safeParseViewContent({
      version: 1,
      category: "canvas",
      store: record,
    });
    expect(result.success).toBe(true);
  });

  it("still accepts legacy payloads that carry `elements`", () => {
    const result = safeParseViewContent({
      version: 1,
      category: "canvas",
      elements: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts both keys together, and keeps `store`", () => {
    const parsed = parseViewContent({
      version: 1,
      category: "canvas",
      elements: [],
      store: record,
    });
    expect(
      (parsed as { store?: Record<string, unknown> }).store
    ).toHaveProperty("shape:hero");
  });

  it("rejects a canvas payload whose category does not match", () => {
    const result = safeParseViewContent({
      version: 1,
      category: "not-a-category",
      store: record,
    });
    expect(result.success).toBe(false);
  });
});
