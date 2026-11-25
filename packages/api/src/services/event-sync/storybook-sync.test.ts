/**
 * The storybook `ui` sync kind, its pure halves: the bundle → graph mapper
 * (identity = the bundle key, so a retitled story keeps its record; ONE graph
 * per run, so the first run is one import proposal), the tombstones (a record
 * the source stopped emitting goes `gone`, kept), and the refresh plan (a
 * second run of the same bundle changes nothing; review state from
 * source-hash vs reviewed-hash; a person's `deprecated` is never moved; the
 * compare holds when jsonb hands the stored keys back in its own order).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../lifecycle/move-status.js", () => ({ moveStatus: vi.fn() }));

import {
  STORYBOOK_BUNDLE_VERSION,
  STORYBOOK_PROVIDER,
  componentKey,
  flowKey,
  pageKey,
  type StorybookBundle,
} from "@synap-core/types/storybook";
import {
  bundleItems,
  bundleKeys,
  goneFromRows,
  planRefresh,
  readStorybookInput,
  storybookAccountHint,
} from "./storybook-sync.js";
import { mapStorybookItems } from "./map-storybook-to-graph.js";
import { getSyncKinds } from "./sync-kind-registry.js";

const BUTTON = componentKey(
  "packages/web/src/spatial-ui/components.tsx",
  "SpatialButton"
);
const ROW = componentKey("packages/web/src/proposals/row.tsx", "ProposalRow");
const HOME = pageKey("pages-desktop-home");
const FLOW = flowKey("morning-check");
const APP = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function bundle(): StorybookBundle {
  return {
    version: STORYBOOK_BUNDLE_VERSION,
    generatedAt: "2026-11-23T15:00:00.000Z",
    source: {
      repo: "Synap-core/app-bases",
      sha: "12813c62e",
      storybookVersion: "10.6.1",
    },
    components: [
      {
        key: BUTTON,
        name: "SpatialButton",
        level: "primitive",
        sourcePath: "packages/web/src/spatial-ui/components.tsx",
        exportName: "SpatialButton",
        storyIds: ["inputs-spatialbutton--default"],
        verdict: "ok",
        sourceHash: "h1",
        composedOf: [],
      },
      {
        key: ROW,
        name: "ProposalRow",
        sourcePath: "packages/web/src/proposals/row.tsx",
        exportName: "ProposalRow",
        storyIds: [],
        verdict: "consolidate",
        sourceHash: "h2",
        composedOf: [BUTTON],
        variantOf: BUTTON,
      },
    ],
    pages: [
      {
        key: HOME,
        title: "Home",
        surface: "desktop",
        storyIds: ["pages-desktop-home--full", "pages-desktop-home--empty"],
        sourceHash: "p1",
        components: [ROW],
      },
    ],
    flows: [
      {
        key: FLOW,
        title: "Morning check",
        surface: "both",
        steps: [
          { page: HOME, label: "Open Home" },
          { page: HOME, label: "Back Home" },
        ],
      },
    ],
  };
}

/** Object keys in Postgres jsonb's output order (shorter first, then bytewise), at every depth. */
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value).sort((a, b) =>
    a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0
  );
  return Object.fromEntries(
    keys.map((k) => [k, jsonbOrder((value as Record<string, unknown>)[k])])
  );
}

const graphOf = (
  b: StorybookBundle,
  input = { bundleFileId: "f", appId: APP }
) => mapStorybookItems(bundleItems(b, input));

describe("storybook ui kind: registration", () => {
  it("is one `ui` kind of provider storybook, never ticked and never reported to the broker", () => {
    const kinds = getSyncKinds(STORYBOOK_PROVIDER);
    expect(kinds.map((k) => k.kind)).toEqual(["ui"]);
    expect(kinds[0]!.scheduled).toBe(false);
    expect(kinds[0]!.brokered).toBe(false);
  });
});

describe("mapStorybookItems", () => {
  it("maps a bundle into ONE graph keyed by the bundle keys (the external ids)", () => {
    const { graph, skipped } = graphOf(bundle());
    expect(skipped).toBe(0);
    const records = graph.entities.filter((e) => !e.ref.startsWith("app:"));
    expect(records.map((e) => [e.profileSlug, e.identity.externalId])).toEqual([
      ["ui-component", BUTTON],
      ["ui-component", ROW],
      ["ui-page", HOME],
      ["user-flow", FLOW],
    ]);
    for (const e of graph.entities)
      expect(e.identity.source).toBe(STORYBOOK_PROVIDER);
    expect(graph.relations).toEqual(
      expect.arrayContaining([
        { sourceRef: ROW, targetRef: BUTTON, type: "composed_of" },
        { sourceRef: ROW, targetRef: BUTTON, type: "extends" },
        { sourceRef: HOME, targetRef: ROW, type: "composed_of" },
        { sourceRef: FLOW, targetRef: HOME, type: "traverses" },
        { sourceRef: BUTTON, targetRef: `app:${APP}`, type: "belongs_to" },
      ])
    );
    // A flow that visits a page twice traverses it once.
    expect(graph.relations.filter((r) => r.type === "traverses")).toHaveLength(
      1
    );
  });

  it("keeps the record of a retitled story: same key, new title", () => {
    const before = graphOf(bundle()).graph.entities.find(
      (e) => e.ref === BUTTON
    )!;
    const b = bundle();
    b.components[0]!.name = "Button";
    b.components[0]!.storyIds = ["actions-button--default"];
    const after = graphOf(b).graph.entities.find((e) => e.ref === BUTTON)!;
    expect(after.identity.externalId).toBe(before.identity.externalId);
    expect(after.title).toBe("Button");
  });

  it("shows a page by its first story; its key is the title id, whatever the order", () => {
    const page = graphOf(bundle()).graph.entities.find((e) => e.ref === HOME)!;
    expect(page.properties["story-id"]).toBe("pages-desktop-home--full");
    const b = bundle();
    b.pages[0]!.storyIds.reverse();
    const reordered = graphOf(b, {
      bundleFileId: "f",
      appId: APP,
      url: undefined,
    } as never).graph.entities.find((e) => e.profileSlug === "ui-page")!;
    expect(reordered.identity.externalId).toBe(HOME);
    expect(reordered.properties["story-id"]).toBe("pages-desktop-home--empty");
  });

  it("writes a page's source file as its source-path, and nothing when the bundle does not know it", () => {
    expect(
      graphOf(bundle()).graph.entities.find((e) => e.ref === HOME)!.properties
    ).not.toHaveProperty("source-path");
    const b = bundle();
    b.pages[0]!.sourcePath = "packages/web/src/pages/home.tsx";
    const page = graphOf(b).graph.entities.find((e) => e.ref === HOME)!;
    expect(page.properties["source-path"]).toBe(
      "packages/web/src/pages/home.tsx"
    );
  });

  it("sets the initial status from the inventory verdict and never writes a review or a brand", () => {
    const { graph } = graphOf(bundle());
    const button = graph.entities.find((e) => e.ref === BUTTON)!;
    const row = graph.entities.find((e) => e.ref === ROW)!;
    expect(button.properties["ui-status"]).toBe("stable");
    expect(row.properties["ui-status"]).toBe("consolidate");
    for (const e of graph.entities) {
      expect(e.properties).not.toHaveProperty("reviewed-hash");
      expect(e.properties).not.toHaveProperty("review-state");
      expect(e.properties).not.toHaveProperty("brand-identity");
    }
    expect(button.properties["design-app"]).toBe(APP);
  });

  it("maps a tombstone to the record's identity under a gone ref, with nothing else", () => {
    const { graph } = mapStorybookItems([
      {
        type: "gone",
        externalId: BUTTON,
        profileSlug: "ui-component",
        title: "SpatialButton",
      },
    ]);
    expect(graph.entities).toEqual([
      {
        ref: `gone:${BUTTON}`,
        profileSlug: "ui-component",
        title: "SpatialButton",
        properties: {},
        identity: { source: STORYBOOK_PROVIDER, externalId: BUTTON, url: null },
      },
    ]);
    expect(graph.relations).toEqual([]);
  });
});

describe("goneFromRows (tombstones)", () => {
  const row = (
    externalId: string,
    profileSlug = "ui-component",
    status: string | null = "stable"
  ) => ({
    externalId,
    title: externalId,
    status,
    profileSlug,
  });

  it("names every mirrored component and page the bundle no longer holds, once", () => {
    const keys = bundleKeys(bundle());
    const lost = componentKey("packages/web/src/old.tsx", "Old");
    const lostPage = pageKey("pages-old--full");
    const gone = goneFromRows(
      [
        row(BUTTON),
        row(lost),
        row(lost),
        row(lostPage, "ui-page"),
        row(HOME, "ui-page"),
      ],
      keys
    );
    expect(gone.map((g) => g.type === "gone" && g.externalId)).toEqual([
      lost,
      lostPage,
    ]);
  });

  it("skips what is already gone, the app stand-in and a user-flow (its lifecycle is a person's)", () => {
    const gone = goneFromRows(
      [
        row(componentKey("a.tsx", "A"), "ui-component", "gone"),
        row(`app:${APP}`, "devplane_app"),
        row(flowKey("old-flow"), "user-flow"),
      ],
      new Set()
    );
    expect(gone).toEqual([]);
  });
});

describe("planRefresh", () => {
  const incoming = (b = bundle()) =>
    graphOf(b).graph.entities.find((e) => e.ref === BUTTON)!;
  const current = (
    over: Record<string, unknown> = {},
    status: string | null = "stable"
  ) => ({
    properties: { ...incoming().properties, ...over },
    status,
  });

  it("a second run of the same bundle writes nothing and moves nothing", () => {
    expect(planRefresh(incoming(), current())).toEqual({
      patch: {},
      moveTo: null,
    });
  });

  it("writes nothing when the stored props come back from jsonb with their keys reordered", () => {
    const b = bundle();
    b.components[0]!.props = [
      {
        name: "variant",
        type: '"primary" | "ghost"',
        required: false,
        defaultValue: '"primary"',
        values: ["primary", "ghost"],
        description: "How loud the button is.",
      },
    ];
    const fresh = incoming(b);
    // What Postgres hands back for the stored record: jsonb orders an object's
    // keys by length, then bytewise.
    const stored = jsonbOrder(fresh.properties) as Record<string, unknown>;
    expect(JSON.stringify(stored["props-summary"])).not.toBe(
      JSON.stringify(fresh.properties["props-summary"])
    );
    expect(
      planRefresh(fresh, { properties: stored, status: "stable" })
    ).toEqual({ patch: {}, moveTo: null });
    // A real change to a prop is still written.
    b.components[0]!.props![0]!.required = true;
    expect(
      Object.keys(
        planRefresh(incoming(b), { properties: stored, status: "stable" }).patch
      )
    ).toEqual(["props-summary"]);
  });

  it("refreshes a page's source-path when its file moved", () => {
    const b = bundle();
    b.pages[0]!.sourcePath = "packages/web/src/pages/home.tsx";
    const page = () => graphOf(b).graph.entities.find((e) => e.ref === HOME)!;
    const before = { properties: { ...page().properties }, status: "stable" };
    expect(planRefresh(page(), before)).toEqual({ patch: {}, moveTo: null });
    b.pages[0]!.sourcePath = "packages/web/src/home/page.tsx";
    expect(planRefresh(page(), before).patch).toEqual({
      "source-path": "packages/web/src/home/page.tsx",
    });
  });

  it("writes only the owned facts that changed; a fact the bundle drops keeps its value", () => {
    const b = bundle();
    b.components[0]!.sourceHash = "h1b";
    delete b.components[0]!.level;
    const plan = planRefresh(
      incoming(b),
      current({ "component-level": "primitive" })
    );
    expect(plan.patch).toEqual({ "source-hash": "h1b" });
  });

  it("marks a reviewed component changed when its source moved, fresh when it is back, and leaves one in review alone", () => {
    const b = bundle();
    b.components[0]!.sourceHash = "h9";
    expect(
      planRefresh(
        incoming(b),
        current({ "reviewed-hash": "h1", "review-state": "fresh" })
      ).patch
    ).toEqual({
      "source-hash": "h9",
      "review-state": "changed",
    });
    expect(
      planRefresh(
        incoming(),
        current({ "reviewed-hash": "h1", "review-state": "changed" })
      ).patch
    ).toEqual({
      "review-state": "fresh",
    });
    expect(
      planRefresh(
        incoming(b),
        current({ "reviewed-hash": "h1", "review-state": "in-review" })
      ).patch
    ).toEqual({
      "source-hash": "h9",
    });
    // Never reviewed: no review state is invented.
    expect(planRefresh(incoming(b), current()).patch).toEqual({
      "source-hash": "h9",
    });
  });

  it("follows the inventory verdict, but never moves a person's deprecated", () => {
    const b = bundle();
    b.components[0]!.verdict = "consolidate";
    expect(planRefresh(incoming(b), current({}, "stable")).moveTo).toBe(
      "consolidate"
    );
    expect(
      planRefresh(incoming(b), current({}, "deprecated")).moveTo
    ).toBeNull();
  });

  it("moves a tombstone to gone once, and a returning record back to its verdict", () => {
    const tomb = mapStorybookItems([
      {
        type: "gone",
        externalId: BUTTON,
        profileSlug: "ui-component",
        title: "x",
      },
    ]).graph.entities[0]!;
    expect(planRefresh(tomb, current({}, "stable"))).toEqual({
      patch: {},
      moveTo: "gone",
    });
    expect(planRefresh(tomb, current({}, "gone"))).toEqual({
      patch: {},
      moveTo: null,
    });
    expect(planRefresh(incoming(), current({}, "gone")).moveTo).toBe("stable");
  });
});

describe("the source a run reads", () => {
  it("reads the stored input only when it names a bundle file or a url", () => {
    expect(readStorybookInput({ appId: APP })).toBeNull();
    expect(readStorybookInput(null)).toBeNull();
    expect(
      readStorybookInput({
        url: "https://sb.example.com",
        appId: APP,
        extra: 1,
      })
    ).toEqual({
      url: "https://sb.example.com",
      appId: APP,
    });
  });

  it("names the source connection by its url or its bundle's repo", () => {
    expect(storybookAccountHint({ url: "https://sb.example.com/" }, null)).toBe(
      "storybook:https://sb.example.com"
    );
    expect(storybookAccountHint({}, bundle())).toBe(
      "storybook:Synap-core/app-bases"
    );
  });
});
