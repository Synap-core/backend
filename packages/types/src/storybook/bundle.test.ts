/**
 * The bundle validator holds the identity rule and refuses a bundle with any
 * error: the sync never mirrors part of a bundle, because what a bundle leaves
 * out is marked gone.
 */
import { describe, expect, it } from "vitest";
import {
  STORYBOOK_BUNDLE_VERSION,
  componentKey,
  isRelativeSourcePath,
  pageKey,
  parseStorybookBundle,
  uiStatusFromVerdict,
} from "./bundle.js";

const BUTTON = componentKey("packages/web/src/spatial-ui/components.tsx", "SpatialButton");
const ROW = componentKey("packages/web/src/proposals/row.tsx", "ProposalRow");

function goodBundle(): Record<string, unknown> {
  return {
    version: STORYBOOK_BUNDLE_VERSION,
    generatedAt: "2026-11-23T15:00:00.000Z",
    source: { repo: "Synap-core/app-bases", sha: "12813c62e", storybookVersion: "10.6.1" },
    components: [
      {
        key: BUTTON,
        name: "SpatialButton",
        level: "primitive",
        sourcePath: "packages/web/src/spatial-ui/components.tsx",
        exportName: "SpatialButton",
        storyIds: ["inputs-spatialbutton--default"],
        screenshot: "0b8f4c7e-3a52-4e3b-9a0e-1f2d3c4b5a69",
        props: [{ name: "variant", type: "ButtonVariant", required: false, values: ["primary"] }],
        family: "button",
        verdict: "ok",
        sourceHash: "h1",
        composedOf: [],
        somethingElse: "dropped",
      },
      {
        key: ROW,
        name: "ProposalRow",
        sourcePath: "packages/web/src/proposals/row.tsx",
        exportName: "ProposalRow",
        storyIds: [],
        sourceHash: "h2",
        composedOf: [BUTTON],
        variantOf: BUTTON,
      },
      {
        key: "title:Legacy/Thing",
        name: "Thing",
        sourcePath: "stories/legacy/Thing.stories.tsx",
        exportName: "Thing",
        storyIds: ["legacy-thing--default"],
        sourceHash: "h3",
        composedOf: [],
      },
    ],
    pages: [
      {
        key: pageKey("pages-desktop-home--full"),
        title: "Home",
        surface: "desktop",
        template: "lens",
        storyId: "pages-desktop-home--full",
        screenshot: "5c2a1e4b-8d7f-4a6b-9c3e-2f1d0a9b8c7d",
        sourceHash: "p1",
        components: [ROW],
      },
    ],
    flows: [
      {
        key: "flow:morning-check",
        title: "Morning check",
        need: "See what needs me",
        surface: "both",
        steps: [{ page: pageKey("pages-desktop-home--full"), label: "Open Home" }],
      },
    ],
  };
}

const components = (b: Record<string, unknown>) => b.components as Record<string, unknown>[];
const pages = (b: Record<string, unknown>) => b.pages as Record<string, unknown>[];
const flows = (b: Record<string, unknown>) => b.flows as Record<string, unknown>[];

describe("parseStorybookBundle", () => {
  it("reads a valid bundle into a clean copy (unknown fields dropped)", () => {
    const read = parseStorybookBundle(goodBundle());
    expect(read.problems).toEqual([]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.components).toHaveLength(3);
    expect(read.value.components[0]).not.toHaveProperty("somethingElse");
    expect(read.value.components[0]!.props![0]).toEqual({
      name: "variant",
      type: "ButtonVariant",
      required: false,
      values: ["primary"],
    });
    expect(read.value.flows[0]!.surface).toBe("both");
  });

  it("refuses a payload that is not a bundle", () => {
    expect(parseStorybookBundle(null)).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: "not-object" })],
    });
    const b = goodBundle();
    b.version = "synap.storybook-bundle/v2";
    const read = parseStorybookBundle(b);
    expect(read.ok).toBe(false);
    expect(read.problems.map((p) => p.code)).toEqual(["wrong-version"]);
  });

  it("holds the identity rule: a component key is its source path and export", () => {
    const b = goodBundle();
    components(b)[0]!.exportName = "Button";
    const read = parseStorybookBundle(b);
    expect(read.ok).toBe(false);
    expect(read.problems).toEqual([
      expect.objectContaining({ code: "key-mismatch", path: "components[0].key" }),
    ]);

    const c = goodBundle();
    components(c)[2]!.key = "Legacy/Thing";
    expect(parseStorybookBundle(c).problems.map((p) => p.code)).toEqual(["key-mismatch"]);
  });

  it("holds the identity rule for pages and flows", () => {
    const b = goodBundle();
    pages(b)[0]!.key = "page:something-else";
    flows(b)[0]!.key = "morning-check";
    const read = parseStorybookBundle(b);
    expect(read.ok).toBe(false);
    expect(read.problems.map((p) => [p.code, p.path])).toEqual(
      expect.arrayContaining([
        ["key-mismatch", "pages[0].key"],
        ["key-mismatch", "flows[0].key"],
      ])
    );
  });

  it("refuses a duplicate key and a reference to a key it does not hold", () => {
    const b = goodBundle();
    components(b)[2]!.key = BUTTON;
    components(b)[2]!.sourcePath = "packages/web/src/spatial-ui/components.tsx";
    components(b)[2]!.exportName = "SpatialButton";
    components(b)[1]!.composedOf = ["component:nowhere.tsx#Nothing"];
    flows(b)[0]!.steps = [{ page: "page:missing", label: "x" }];
    const read = parseStorybookBundle(b);
    expect(read.ok).toBe(false);
    expect(read.problems.map((p) => [p.code, p.path])).toEqual([
      ["duplicate-key", "components[2].key"],
      ["dangling-ref", "components[1].composedOf[0]"],
      ["dangling-ref", "flows[0].steps[0].page"],
    ]);
  });

  it("refuses a machine path, a bad screenshot, a bad surface and a missing source, all at once", () => {
    const b = goodBundle();
    components(b)[0]!.sourcePath = "/Users/someone/app/packages/web/src/spatial-ui/components.tsx";
    components(b)[0]!.key = componentKey(
      "/Users/someone/app/packages/web/src/spatial-ui/components.tsx",
      "SpatialButton"
    );
    components(b)[1]!.screenshot = "thumbs/row.png";
    pages(b)[0]!.surface = "tablet";
    b.source = { sha: "abc" };
    const read = parseStorybookBundle(b);
    expect(read.ok).toBe(false);
    // What points at a key the bundle no longer holds dangles too: the button's
    // key moved with its machine path, leaving the row's composedOf and variantOf
    // pointing at nothing; the refused page (bad surface) leaves the flow's step.
    expect(read.problems.map((p) => p.code).sort()).toEqual(
      ["absolute-path", "bad-value", "bad-value", "dangling-ref", "dangling-ref", "dangling-ref", "missing-field"].sort()
    );
    expect(read.problems.filter((p) => p.code === "dangling-ref").map((p) => p.path)).toEqual([
      "components[1].composedOf[0]",
      "components[1].variantOf",
      "flows[0].steps[0].page",
    ]);
  });

  it("refuses missing lists instead of reading them as empty", () => {
    const b = goodBundle();
    delete b.pages;
    delete components(b)[0]!.composedOf;
    const read = parseStorybookBundle(b);
    expect(read.ok).toBe(false);
    expect(read.problems.map((p) => p.path)).toEqual([
      "components[0].composedOf",
      "$.pages",
      "flows[0].steps[0].page",
    ]);
  });
});

describe("helpers", () => {
  it("maps the inventory verdict onto the ui-status lifecycle", () => {
    expect(uiStatusFromVerdict("ok")).toBe("stable");
    expect(uiStatusFromVerdict("consolidate")).toBe("consolidate");
    expect(uiStatusFromVerdict("missing")).toBe("proposed");
  });

  it("a source path is repo-relative", () => {
    expect(isRelativeSourcePath("packages/web/src/x.tsx")).toBe(true);
    expect(isRelativeSourcePath("/abs/x.tsx")).toBe(false);
    expect(isRelativeSourcePath("C:\\x.tsx")).toBe(false);
    expect(isRelativeSourcePath("a/../b.tsx")).toBe(false);
  });
});
