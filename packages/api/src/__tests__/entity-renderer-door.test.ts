import { describe, it, expect } from "vitest";
import {
  EntityRendererRefSchema,
  mergeSystemData,
} from "../routers/entities.js";

/**
 * Locks the two safety properties of `trpc.entities.setEntityRenderer`:
 *
 *  1. The `ref` union is NARROWED to `{ kind: "cell" }` — a per-row renderer can
 *     never carry `url` / `iframe-srcdoc` arbitrary content.
 *  2. The write MERGES into `system_data` — `viewMode`, `bentoViewId`,
 *     `onboardingScaffold`, `mergedInto` survive.
 */

describe("EntityRendererRefSchema (per-entity renderer narrowing)", () => {
  it("accepts a cell ref", () => {
    const parsed = EntityRendererRefSchema.parse({
      kind: "cell",
      cellKey: "deal-board",
      props: { a: 1 },
      title: "Board",
    });
    expect(parsed.cellKey).toBe("deal-board");
  });

  it("accepts a minimal cell ref", () => {
    expect(
      EntityRendererRefSchema.safeParse({ kind: "cell", cellKey: "note" })
        .success
    ).toBe(true);
  });

  it("REJECTS the arbitrary-content variants", () => {
    expect(
      EntityRendererRefSchema.safeParse({
        kind: "url",
        url: "https://evil.example",
      }).success
    ).toBe(false);

    expect(
      EntityRendererRefSchema.safeParse({
        kind: "iframe-srcdoc",
        appId: "x",
        srcdoc: "<script>fetch('https://evil.example')</script>",
      }).success
    ).toBe(false);
  });

  it("REJECTS the other RendererTarget variants the profile door allows", () => {
    for (const ref of [
      { kind: "view", viewId: "v-1" },
      { kind: "external-app", appId: "x", url: "https://evil.example" },
      { kind: "host-app", appId: "x" },
      { kind: "view-adapter", adapterKey: "table" },
    ]) {
      expect(EntityRendererRefSchema.safeParse(ref).success).toBe(false);
    }
  });

  it("is strict — a srcdoc/url field cannot ride along on a cell ref", () => {
    expect(
      EntityRendererRefSchema.safeParse({
        kind: "cell",
        cellKey: "note",
        srcdoc: "<script>1</script>",
      }).success
    ).toBe(false);

    expect(
      EntityRendererRefSchema.safeParse({
        kind: "cell",
        cellKey: "note",
        url: "https://evil.example",
      }).success
    ).toBe(false);
  });

  it("rejects an empty cellKey", () => {
    expect(
      EntityRendererRefSchema.safeParse({ kind: "cell", cellKey: "" }).success
    ).toBe(false);
  });
});

describe("mergeSystemData (system_data must never be clobbered)", () => {
  const existing = {
    viewMode: "bento",
    bentoViewId: "view-9",
    onboardingScaffold: { step: 2 },
    mergedInto: "entity-7",
  };

  it("preserves every pre-existing key when writing renderer", () => {
    const next = mergeSystemData(existing, {
      renderer: { kind: "cell", cellKey: "deal-board" },
    });

    expect(next).toEqual({
      ...existing,
      renderer: { kind: "cell", cellKey: "deal-board" },
    });
    // named explicitly so a regression names the victim
    expect(next.viewMode).toBe("bento");
    expect(next.bentoViewId).toBe("view-9");
    expect(next.onboardingScaffold).toEqual({ step: 2 });
    expect(next.mergedInto).toBe("entity-7");
  });

  it("clearing the renderer removes only that key (no tombstone)", () => {
    const withRenderer = mergeSystemData(existing, {
      renderer: { kind: "cell", cellKey: "deal-board" },
    });
    const cleared = mergeSystemData(withRenderer, { renderer: null });

    expect(cleared).toEqual(existing);
    expect("renderer" in cleared).toBe(false);
  });

  it("does not mutate the input row's systemData", () => {
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeSystemData(existing, { renderer: { kind: "cell", cellKey: "x" } });
    expect(existing).toEqual(snapshot);
  });

  it("tolerates null / non-object system_data", () => {
    expect(mergeSystemData(null, { renderer: null })).toEqual({});
    expect(mergeSystemData(undefined, { viewMode: "document" })).toEqual({
      viewMode: "document",
    });
    expect(mergeSystemData([1, 2], { viewMode: "document" })).toEqual({
      viewMode: "document",
    });
  });
});
