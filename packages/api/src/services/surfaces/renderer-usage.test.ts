/**
 * Contract test for `buildRendererUsage` — the Surfaces usage-health read.
 * Pins the derivations the Surfaces plane depends on:
 *   · bindings from ALL THREE stores (workspace overlay · profile default ·
 *     per-view ref) group under ONE renderer key;
 *   · a legacy slot key / deprecated column is flagged `legacy: true`;
 *   · a `{kind:"cell"}` key absent from widget_definitions ⇒ `registered:"no"`
 *     + a human gap + `health.status:"degraded"`;
 *   · a `view-adapter` key and an `entity-detail-<slug>` convention key are
 *     FORCED to `"unknown"` — never "no" (no server registry owns them);
 *   · `cellKey` filters to one key;
 *   · `workspaceId` NARROWS but still admits NULL-workspace rows.
 *
 * db / ProfileRepository / scopedDb are mocked — assertions are on the composed
 * shape, not on SQL.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const rowsByTable = new Map<unknown, unknown[]>();
const { mockGetAccessibleProfiles, mockScopedFindMany } = vi.hoisted(() => ({
  mockGetAccessibleProfiles: vi.fn(),
  mockScopedFindMany: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const select = () => {
    let tbl: unknown;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => {
        tbl = t;
        return chain;
      },
      where: () => Promise.resolve(rowsByTable.get(tbl) ?? []),
    };
    return chain;
  };
  return {
    ...actual,
    db: { select },
    getDb: async () => ({}),
    ProfileRepository: class {
      getAccessibleProfiles = mockGetAccessibleProfiles;
    },
  };
});

vi.mock("../../access/scoped-db.js", () => ({
  scopedDb: () => ({ findMany: mockScopedFindMany }),
}));

// The router-side visibility helper is a pure predicate builder; the mocked
// `db.select().where()` ignores it, but importing views.ts would drag the whole
// router graph into the test, so stub it.
vi.mock("../../routers/views.js", () => ({
  viewVisibleWhere: () => undefined,
}));

import { buildRendererUsage } from "./renderer-usage.js";
import { workspaces, views, entities } from "@synap/database";
import type { AccessContext } from "../../access/context.js";

const USER = "user-1";
const WS = "11111111-1111-1111-1111-111111111111";
const access = { withLens: () => access } as unknown as AccessContext;

/** widget_definitions rows: only `shared-card` is a registered active cell. */
const REGISTRY = [
  { typeKey: "shared-card", isActive: true, workspaceId: null },
  { typeKey: "retired-card", isActive: false, workspaceId: null },
];

function setup(opts?: {
  workspaceRows?: unknown[];
  viewRows?: unknown[];
  profiles?: unknown[];
  registry?: unknown[];
}) {
  rowsByTable.clear();
  rowsByTable.set(workspaces, opts?.workspaceRows ?? []);
  rowsByTable.set(views, opts?.viewRows ?? []);
  rowsByTable.set(entities, [{ value: 7 }]);
  mockGetAccessibleProfiles.mockResolvedValue(opts?.profiles ?? []);
  mockScopedFindMany.mockResolvedValue(opts?.registry ?? REGISTRY);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildRendererUsage", () => {
  it("groups bindings from all three stores under one key", async () => {
    setup({
      workspaceRows: [
        {
          id: WS,
          name: "Builder",
          settings: {
            profileRenderers: {
              contact: {
                "entity-detail": { kind: "cell", cellKey: "shared-card" },
              },
            },
          },
        },
      ],
      profiles: [
        {
          id: "prof-1",
          slug: "contact",
          displayName: "Contact",
          workspaceId: null,
          defaultRenderers: {
            "entity-detail": { kind: "cell", cellKey: "shared-card" },
          },
        },
      ],
      viewRows: [
        {
          id: "view-1",
          name: "Contacts board",
          type: "kanban",
          workspaceId: WS,
          config: { rendererRef: { kind: "cell", cellKey: "shared-card" } },
        },
      ],
    });

    const { usage, perEntityOverrideCount } = await buildRendererUsage({
      userId: USER,
      access,
    });

    expect(usage).toHaveLength(1);
    const row = usage[0]!;
    expect(row.key).toBe("shared-card");
    expect(row.kind).toBe("cell");
    expect(row.registered).toBe("yes");
    expect(row.health).toEqual({
      status: "ok",
      bindingCount: 3,
      staleCount: 0,
    });
    expect(row.bindings.map((b) => b.store).sort()).toEqual([
      "profile",
      "view",
      "workspace",
    ]);
    expect(row.gaps).toEqual([]);
    expect(perEntityOverrideCount).toBe(7);
  });

  it("marks a legacy slot key and a deprecated profile column as legacy", async () => {
    setup({
      workspaceRows: [
        {
          id: WS,
          name: "Builder",
          settings: {
            profileRenderers: {
              contact: { detail: { kind: "cell", cellKey: "shared-card" } },
            },
          },
        },
      ],
      profiles: [
        {
          id: "prof-1",
          slug: "contact",
          displayName: "Contact",
          workspaceId: null,
          defaultRenderers: {},
          defaultDetailRenderer: { kind: "cell", cellKey: "shared-card" },
        },
      ],
    });

    const { usage } = await buildRendererUsage({ userId: USER, access });
    const bindings = usage[0]!.bindings;
    expect(bindings).toHaveLength(2);
    expect(bindings.every((b) => b.legacy === true)).toBe(true);
    const ws = bindings.find((b) => b.store === "workspace")!;
    expect(ws.contentKind).toBe("detail");
    // The deprecated column reports the ContentKind that replaced it (0112).
    const prof = bindings.find((b) => b.store === "profile")!;
    expect(prof.contentKind).toBe("entity-detail");
  });

  it('flags an unregistered cell key as registered:"no" with a gap', async () => {
    setup({
      workspaceRows: [
        {
          id: WS,
          name: "Builder",
          settings: {
            profileRenderers: {
              contact: {
                "entity-detail": { kind: "cell", cellKey: "old-card" },
              },
            },
          },
        },
      ],
    });

    const { usage } = await buildRendererUsage({ userId: USER, access });
    expect(usage).toHaveLength(1);
    expect(usage[0]!.registered).toBe("no");
    expect(usage[0]!.health).toEqual({
      status: "degraded",
      bindingCount: 1,
      staleCount: 1,
    });
    expect(usage[0]!.gaps).toEqual([
      'Workspace "Builder" binds contact→entity-detail to unregistered cell "old-card"',
    ]);
  });

  it('forces "unknown" (never "no") for view-adapter + frontend-convention keys', async () => {
    setup({
      viewRows: [
        {
          id: "view-1",
          name: "Board",
          type: "kanban",
          workspaceId: WS,
          config: {
            render: {
              rendererRef: { kind: "view-adapter", adapterKey: "kanban-v2" },
            },
          },
        },
      ],
      workspaceRows: [
        {
          id: WS,
          name: "Builder",
          settings: {
            profileRenderers: {
              contact: {
                "entity-detail": {
                  kind: "cell",
                  cellKey: "entity-detail-contact",
                },
              },
            },
          },
        },
      ],
    });

    const { usage } = await buildRendererUsage({ userId: USER, access });
    const byKey = Object.fromEntries(usage.map((u) => [u.key, u]));
    expect(byKey["kanban-v2"]!.kind).toBe("view-adapter");
    expect(byKey["kanban-v2"]!.registered).toBe("unknown");
    expect(byKey["kanban-v2"]!.health.status).toBe("unknown");
    expect(byKey["entity-detail-contact"]!.registered).toBe("unknown");
    expect(byKey["entity-detail-contact"]!.gaps).toEqual([]);
  });

  it("filters to one key when cellKey is given", async () => {
    setup({
      workspaceRows: [
        {
          id: WS,
          name: "Builder",
          settings: {
            profileRenderers: {
              contact: {
                "entity-detail": { kind: "cell", cellKey: "shared-card" },
                collection: { kind: "cell", cellKey: "other-card" },
              },
            },
          },
        },
      ],
    });

    const { usage } = await buildRendererUsage({
      userId: USER,
      access,
      cellKey: "shared-card",
    });
    expect(usage.map((u) => u.key)).toEqual(["shared-card"]);
  });

  it("narrowing by workspaceId still includes NULL-workspace rows", async () => {
    setup({
      profiles: [
        {
          id: "prof-global",
          slug: "contact",
          displayName: "Contact",
          workspaceId: null, // pod-wide profile — must survive the narrow
          defaultRenderers: {
            "entity-detail": { kind: "cell", cellKey: "shared-card" },
          },
        },
      ],
      viewRows: [
        {
          id: "view-global",
          name: "Pod view",
          type: "table",
          workspaceId: null, // NULL-workspace view — must survive the narrow
          config: { rendererRef: { kind: "cell", cellKey: "shared-card" } },
        },
      ],
    });

    const { usage } = await buildRendererUsage({
      userId: USER,
      access,
      workspaceId: WS,
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]!.bindings.map((b) => b.workspaceId)).toEqual([null, null]);
    expect(usage[0]!.health.bindingCount).toBe(2);
  });
});
