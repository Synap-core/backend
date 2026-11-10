/**
 * `workspaces.setPrimarySurface` — the ONE runtime writer of a space's start
 * page (the browser's tRPC route, and MCP `synap_set_start_page` through
 * `setStartPageDoor`) — refuses a cell that cannot open in the space BEFORE
 * its gate. Without it an agent's start page was filed as a proposal and
 * approved into a space that opens blank.
 *
 * Behavioural through the real procedure and the real renderables catalog
 * (`listRenderables`: built-ins + this space's installed rows). Mocked: the DB
 * (the installed `widget_definitions` rows) and the gate (to see whether it
 * was reached). What this does NOT see: the approve replay, the browser open.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE = "00000000-0000-4000-8000-0000000000d1";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  preview: vi.fn(),
  installed: [] as Array<Record<string, unknown>>,
  catalogReads: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = {
    query: {
      widgetDefinitions: {
        findMany: vi.fn(async () => {
          h.catalogReads++;
          return h.installed;
        }),
      },
    },
  };
  return { ...actual, db: fakeDb, getDb: vi.fn(async () => fakeDb) };
});
vi.mock("@synap/storage", () => ({
  storage: { buildPath: vi.fn(), upload: vi.fn() },
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(),
  getBoss: vi.fn(),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
  getSyncGenerationState: vi.fn(async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 0,
  })),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: h.gate,
  previewPermissionDecision: h.preview,
}));

import { workspacesRouter } from "./workspaces.js";

function caller() {
  return workspacesRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as never);
}

beforeEach(() => {
  h.gate.mockReset();
  h.gate.mockResolvedValue({ granted: false, proposalId: "proposal-1" });
  h.preview.mockReset();
  h.preview.mockResolvedValue({ decision: "propose" });
  h.installed = [];
  h.catalogReads = 0;
});

describe("workspaces.setPrimarySurface checks the start page opens before the gate", () => {
  it("refuses a cell this space cannot open, and files nothing", async () => {
    const run = caller().setPrimarySurface({
      workspaceId: WORKSPACE,
      primarySurface: { kind: "cell", cellKey: "generated:not-here" },
    });
    await expect(run).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(run).rejects.toThrow(/No cell "generated:not-here" can open/);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("refuses a caller the gate would deny before reading the space's cells", async () => {
    h.preview.mockResolvedValue({ decision: "deny", reason: "Not a member" });
    const run = caller().setPrimarySurface({
      workspaceId: WORKSPACE,
      primarySurface: { kind: "cell", cellKey: "generated:lead-desk" },
    });
    await expect(run).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.catalogReads).toBe(0);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("files a cell installed in this space, with the reviewer's reason", async () => {
    h.installed = [
      {
        id: "w1",
        typeKey: "generated:lead-desk",
        name: "Lead desk",
        workspaceId: WORKSPACE,
        isActive: true,
        configSchema: {},
        source: "ai",
      },
    ];
    const result = await caller().setPrimarySurface({
      workspaceId: WORKSPACE,
      primarySurface: { kind: "cell", cellKey: "generated:lead-desk" },
      reasoning: "Open the lead pipeline app first",
    });
    expect(result).toMatchObject({ status: "proposed" });
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.gate.mock.calls[0]![0]).toMatchObject({
      workspaceId: WORKSPACE,
      subjectType: "workspace",
      action: "update",
      reasoning: "Open the lead pipeline app first",
      data: {
        operation: "set_primary_surface",
        primarySurface: { kind: "cell", cellKey: "generated:lead-desk" },
      },
    });
  });

  it("files a website start page without reading the cell catalog", async () => {
    await caller().setPrimarySurface({
      workspaceId: WORKSPACE,
      primarySurface: { kind: "url", url: "https://leads.example.com" },
    });
    expect(h.catalogReads).toBe(0);
    expect(h.gate).toHaveBeenCalledTimes(1);
  });
});
