/**
 * Pod admin DELEGATES "which renderer draws this": every shared case
 * (`RENDERER_RESOLUTION_CASES`) runs through the adapter the hook calls
 * (`resolveForPodAdmin`) and gets its expected answer. Then this host's own
 * part: its fallback is the installed bundle's default, and only when that
 * cell is installed; a failed status read is FAILED (never "nothing to
 * draw"); a failed bindings read still resolves, marked `readFailed`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  RENDERER_RESOLUTION_CASES,
  type RendererSubject,
} from "@synap-core/types/renderer-resolution";

vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));

import {
  bundleFallback,
  objectRendererState,
  readRenderersStatus,
  resolveForPodAdmin,
  type RenderersStatus,
} from "./use-object-renderer";

describe("pod admin runs every shared resolution case through its adapter", () => {
  it("has cases to run (non-vacuity)", () => {
    expect(RENDERER_RESOLUTION_CASES.length).toBeGreaterThan(5);
  });
  for (const c of RENDERER_RESOLUTION_CASES) {
    it(c.name, () => {
      expect(resolveForPodAdmin(c.input)).toEqual(c.expected);
    });
  }
});

const BOARD = "cell:synap-renderers:board";
const CARD = "cell:synap-renderers:entity-card";
const ENTITY = "11111111-1111-4111-8111-111111111111";
const VIEW = "22222222-2222-4222-8222-222222222222";

const WIRE = {
  bundle: {
    slug: "synap-renderers",
    version: "1.0.0",
    setSha256: "abc",
    reactVersion: "19.2.3",
  },
  // By the bundle's cell KEY: the cell is `cell:<slug>:<key>`.
  defaults: {
    "entity-card": "entity-card",
    views: { board: "board", kanban: "board" },
  },
  installed: [
    {
      key: BOARD,
      runtime: "frame",
      contentKind: "collection",
      viewTypes: ["board", "kanban"],
    },
    { key: CARD, runtime: "frame", contentKind: "entity-card", viewTypes: [] },
  ],
};

const board: RendererSubject = {
  kind: "view",
  viewId: VIEW,
  viewType: "board",
};
const card: RendererSubject = {
  kind: "entity",
  slot: "entity-card",
  entityId: ENTITY,
  profileSlug: "deal",
};
const ok = (data: unknown) => ({ isLoading: false, error: null, data });

describe("bundleFallback — the host's fallback is the bundle's installed default", () => {
  const status = readRenderersStatus(WIRE)!;

  it("a view type the bundle draws → its cell", () => {
    expect(bundleFallback(status, board)).toEqual({
      kind: "cell",
      cellKey: BOARD,
      props: {},
    });
  });

  it("an entity slot → the slot's default", () => {
    expect(bundleFallback(status, card)).toEqual({
      kind: "cell",
      cellKey: CARD,
      props: {},
    });
  });

  it("a default whose cell is not installed → nothing", () => {
    const partial: RenderersStatus = {
      ...status,
      installed: status.installed.filter((c) => c.key !== BOARD),
    };
    expect(bundleFallback(partial, board)).toBeNull();
  });

  it("no bundle → nothing, whatever the defaults say", () => {
    expect(bundleFallback({ ...status, bundle: null }, board)).toBeNull();
  });

  it("a view type with no default → nothing", () => {
    expect(
      bundleFallback(status, {
        ...board,
        viewType: "calendar",
      } as RendererSubject)
    ).toBeNull();
  });
});

describe("objectRendererState — the reads, end to end", () => {
  it("a board view with nothing bound is drawn by the bundle's board", () => {
    const state = objectRendererState({ subject: board, status: ok(WIRE) });
    expect(state).toMatchObject({
      state: "resolved",
      resolution: {
        kind: "cell",
        ref: { cellKey: BOARD },
        via: "host-fallback",
        readFailed: false,
      },
    });
  });

  it("no bundle installed → nothing to draw (the page keeps its card)", () => {
    const state = objectRendererState({
      subject: board,
      status: ok({ bundle: null, defaults: {}, installed: [] }),
    });
    expect(state).toMatchObject({
      state: "resolved",
      resolution: { kind: "none", readFailed: false },
    });
  });

  it("a failed status read is FAILED, never 'nothing to draw'", () => {
    const retry = () => {};
    expect(
      objectRendererState({
        subject: board,
        status: { isLoading: false, error: new Error("x"), data: undefined },
        retry,
      })
    ).toEqual({ state: "failed", retry });
  });

  it("a status answer that is not a status is failed too", () => {
    expect(
      objectRendererState({ subject: board, status: ok({ nope: true }) }).state
    ).toBe("failed");
  });

  it("loading while either read is in flight", () => {
    expect(
      objectRendererState({
        subject: board,
        status: { isLoading: true, error: null, data: undefined },
      }).state
    ).toBe("loading");
    expect(
      objectRendererState({
        subject: card,
        status: ok(WIRE),
        effective: { isLoading: true, error: null, data: undefined },
      }).state
    ).toBe("loading");
  });

  it("a failed bindings read still resolves, and says it read only part", () => {
    const state = objectRendererState({
      subject: card,
      status: ok(WIRE),
      effective: { isLoading: false, error: new Error("x"), data: undefined },
    });
    expect(state).toMatchObject({
      state: "resolved",
      resolution: { kind: "cell", ref: { cellKey: CARD }, readFailed: true },
    });
  });

  it("a kind's own binding beats the bundle's default", () => {
    const state = objectRendererState({
      subject: card,
      status: ok({
        ...WIRE,
        installed: [
          ...WIRE.installed,
          {
            key: "cell:acme:deal-card",
            runtime: "frame",
            contentKind: "entity-card",
            viewTypes: [],
          },
        ],
      }),
      effective: ok({
        "entity-card": {
          kind: "cell",
          cellKey: "cell:acme:deal-card",
          props: {},
        },
        sources: { "entity-card": "profile" },
      }),
    });
    expect(state).toMatchObject({
      state: "resolved",
      resolution: {
        kind: "cell",
        ref: { cellKey: "cell:acme:deal-card" },
        via: "binding",
      },
    });
  });
});
