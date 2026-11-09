/**
 * Hub `views.updateView` — the one governed door an agent edits a view through
 * (`PATCH /api/hub/views/:id` and MCP `synap_update_view`) — checks the config
 * BEFORE its gate.
 *
 * The defect it pins: the config was validated only by `views.update`, which
 * runs AFTER `checkPermissionOrPropose` returned "proposed". An agent's edit
 * was always filed, and an approved `view/update` is applied by the
 * materializer, which validates nothing: a bento block with an unknown widget
 * key approved into a broken dashboard. Now a bad config is refused in the
 * caller's own reply and no proposal is filed.
 *
 * Behavioural, through the real router, the real `validateViewConfig`, the
 * real `bentoBlockArrangeErrors` and the real built-in widget catalog. Mocked:
 * the DB (the view row, no installed cells) and the gate (to see whether it
 * was reached). What this does NOT see: installed `cell:`/`generated:` cells
 * (no `widget_definitions` rows are seeded), and the approve path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const VIEW_ID = "00000000-0000-4000-8000-0000000000f1";
const WORKSPACE = "00000000-0000-4000-8000-0000000000f2";
const USER = "00000000-0000-4000-8000-0000000000f3";

const h = vi.hoisted(() => ({
  viewRow: { workspaceId: "", type: "bento", config: null } as {
    workspaceId: string;
    type: string;
    config: Record<string, unknown> | null;
  },
  gate: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = {
    query: {
      views: { findFirst: vi.fn(async () => h.viewRow) },
      widgetDefinitions: { findMany: vi.fn(async () => []) },
    },
  };
  return { ...actual, getDb: vi.fn(async () => fakeDb) };
});
vi.mock("@synap/storage", () => ({
  storage: { buildPath: vi.fn(), upload: vi.fn() },
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/permission-check.js")>()),
  checkPermissionOrPropose: h.gate,
}));

import { hubViewsRouter } from "./views.js";

function caller() {
  return hubViewsRouter.createCaller({
    authenticated: true,
    userId: USER,
    apiKeyId: "key-1",
    scopes: ["hub-protocol.write"],
  } as never);
}

const pos = { x: 0, y: 0, w: 4, h: 2 };

beforeEach(() => {
  h.viewRow = { workspaceId: WORKSPACE, type: "bento", config: null };
  h.gate.mockReset();
  h.gate.mockResolvedValue({ proposalId: "proposal-1" });
});

describe("hub views.updateView validates the config before the gate", () => {
  it("refuses a bento block whose widget is not in the catalog, naming the block, and files nothing", async () => {
    const run = caller().updateView({
      userId: USER,
      viewId: VIEW_ID,
      config: {
        blocks: [
          {
            id: "b1",
            kind: "widget",
            widgetType: "no-such-widget",
            config: {},
            pos,
          },
        ],
      },
    });
    await expect(run).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(run).rejects.toThrow(
      /blocks\[0\] "b1": Unknown widget "no-such-widget"/
    );
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("refuses a bento widget missing its required config, and files nothing", async () => {
    const run = caller().updateView({
      userId: USER,
      viewId: VIEW_ID,
      config: {
        blocks: [
          {
            id: "b1",
            kind: "widget",
            widgetType: "stat-card",
            config: {},
            pos,
          },
        ],
      },
    });
    await expect(run).rejects.toThrow(/stat-card" needs config\.profileSlug/);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("refuses a config the view's type does not accept, and files nothing", async () => {
    const run = caller().updateView({
      userId: USER,
      viewId: VIEW_ID,
      config: { blocks: "not-a-list" },
    });
    await expect(run).rejects.toThrow(/Invalid view config/);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("keeps a block the person placed unchanged without re-judging it, and judges only the new one", async () => {
    // A widget agents may not place, already on the person's bento.
    const kept = {
      id: "mine",
      kind: "widget",
      widgetType: "person-only-widget",
      config: { b: 2, a: 1 },
      pos,
    };
    h.viewRow = {
      workspaceId: WORKSPACE,
      type: "bento",
      config: { blocks: [kept] },
    };
    const keptAgain = { ...kept, config: { a: 1, b: 2 } }; // key order differs
    const ok = await caller().updateView({
      userId: USER,
      viewId: VIEW_ID,
      config: {
        blocks: [
          keptAgain,
          {
            id: "new",
            kind: "widget",
            widgetType: "stat-card",
            config: { profileSlug: "deal" },
            pos,
          },
        ],
      },
    });
    expect(ok).toMatchObject({ status: "proposed" });

    // The same kept block with its config CHANGED is judged again.
    const changed = caller().updateView({
      userId: USER,
      viewId: VIEW_ID,
      config: { blocks: [{ ...kept, config: { a: 9 } }] },
    });
    await expect(changed).rejects.toThrow(/blocks\[0\] "mine": Unknown widget/);
  });

  it("files a placeable bento edit with the config the reviewer will approve", async () => {
    const config = {
      blocks: [
        {
          id: "b1",
          kind: "widget",
          widgetType: "stat-card",
          config: { profileSlug: "deal" },
          pos,
        },
      ],
    };
    const result = await caller().updateView({
      userId: USER,
      viewId: VIEW_ID,
      config,
    });
    expect(result).toMatchObject({
      status: "proposed",
      proposalId: "proposal-1",
    });
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.gate.mock.calls[0]![0]).toMatchObject({
      subjectType: "view",
      action: "update",
      workspaceId: WORKSPACE,
      data: { id: VIEW_ID, config },
    });
  });
});
