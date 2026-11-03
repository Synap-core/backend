/**
 * `defineCell` refuses, at define time, a source that cannot mount in its
 * frame (decision Q9, plan 9ad4b2fc lane 16) — whichever door came in, an
 * approval of a proposal included. Before this, nothing looked at the source
 * when it was written, and the desktop refused deps only at mount: a person
 * could approve a cell that then failed on every open.
 *
 * Proven here, against the real writer with only `getDb` faked:
 *  1. A refused source writes NOTHING and emits nothing; the error is a
 *     `CellDefinitionError` (every door's 400) naming the line and the fix.
 *  2. Advice (colour, alt text) never blocks: the row is written and the
 *     advice comes back with it.
 *  3. A row KEPT as `mcp-app` / `builtin` (mechanism omitted on a re-push) is
 *     not a Synap frame: not checked.
 *  4. A stored egress grant still counts on a source-only re-push.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  storedRows: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => h.storedRows }) }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.inserted.push(v);
          return {
            onConflictDoUpdate: () => ({
              returning: async () => [
                { id: "w1", createdAt: new Date(1), updatedAt: new Date(1) },
              ],
            }),
            returning: async () => [{ id: "w1" }],
          };
        },
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [] }) }),
      }),
    }),
  };
});
vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: (e: Record<string, unknown>) => h.events.push(e),
}));

const { defineCell, CellDefinitionError, CellSourceRefusedError } =
  await import("./define-cell.js");

const WS = "11111111-1111-4111-8111-111111111111";
const base = (extra: Record<string, unknown> = {}) => ({
  name: "Deal Funnel",
  workspaceId: WS,
  userId: "u-1",
  rendererSource: "export default () => null;",
  ...extra,
});

beforeEach(() => {
  h.storedRows = [];
  h.inserted = [];
  h.events = [];
});

describe("defineCell refuses what cannot mount", () => {
  it.each([
    [
      "a frame module importing a library the host does not provide",
      {
        rendererSource:
          'import { BarChart } from "recharts";\nexport default () => null;',
      },
      'Line 1 imports "recharts"',
    ],
    [
      "runtime deps",
      { deps: { "chart.js": "4.4.0" } },
      "`deps` names chart.js",
    ],
    [
      "an HTML page loading a CDN script",
      {
        rendererSource:
          '<!doctype html>\n<html><head>\n<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>\n</head></html>',
      },
      'Line 3 loads the script "https://cdn.jsdelivr.net/npm/chart.js"',
    ],
    [
      "a fetch to an origin the frame may not reach",
      {
        rendererSource:
          'export default () => {\n  fetch("https://api.example.com/x");\n  return null;\n};',
      },
      "Line 2 requests",
    ],
  ])("%s", async (_label, extra, expected) => {
    const err = await defineCell(base(extra)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CellSourceRefusedError);
    expect(err).toBeInstanceOf(CellDefinitionError);
    expect((err as Error).message).toContain(expected);
    expect((err as Error).message).toContain("How to fix it:");
    expect(h.inserted).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });
});

describe("advice never blocks", () => {
  it("writes the row and hands the advice back", async () => {
    const res = await defineCell(
      base({
        rendererSource:
          'export default () => <div style={{ color: "#ff0000" }}><img src="data:,"/></div>;',
      })
    );
    expect(h.inserted).toHaveLength(1);
    expect(res.advice.map((a) => a.code)).toEqual([
      "raw_colour",
      "image_without_alt",
    ]);
  });

  it("a clean source has no advice", async () => {
    const res = await defineCell(base());
    expect(res.advice).toEqual([]);
  });
});

describe("what is not drawn in a Synap frame is not checked", () => {
  const CDN_PAGE =
    '<!doctype html><html><head><script src="https://cdn.example/x.js"></script></head></html>';

  it("an explicit mcp-app source", async () => {
    await expect(
      defineCell(base({ rendererType: "mcp-app", rendererSource: CDN_PAGE }))
    ).resolves.toMatchObject({ advice: [] });
    expect(h.inserted).toHaveLength(1);
  });

  it("a re-push onto a row kept as mcp-app, mechanism omitted", async () => {
    h.storedRows = [{ rendererType: "mcp-app", externalHosts: null }];
    await expect(
      defineCell(base({ rendererSource: CDN_PAGE }))
    ).resolves.toBeDefined();
  });
});

describe("a stored egress grant counts on a source-only re-push", () => {
  const FETCH =
    'export default () => { fetch("https://api.vendor.com/v1"); return null; };';

  it("granted origin: written", async () => {
    h.storedRows = [
      { rendererType: "frame", externalHosts: ["https://api.vendor.com"] },
    ];
    await expect(
      defineCell(base({ rendererType: "frame", rendererSource: FETCH }))
    ).resolves.toBeDefined();
    expect(h.inserted).toHaveLength(1);
  });

  it("no grant: refused", async () => {
    h.storedRows = [{ rendererType: "frame", externalHosts: null }];
    await expect(
      defineCell(base({ rendererType: "frame", rendererSource: FETCH }))
    ).rejects.toBeInstanceOf(CellSourceRefusedError);
  });

  it("an explicit list wins over the stored one", async () => {
    h.storedRows = [
      { rendererType: "frame", externalHosts: ["https://api.vendor.com"] },
    ];
    await expect(
      defineCell(
        base({
          rendererType: "frame",
          rendererSource: FETCH,
          externalHosts: [],
        })
      )
    ).rejects.toBeInstanceOf(CellSourceRefusedError);
  });
});
