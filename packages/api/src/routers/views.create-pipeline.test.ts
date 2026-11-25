/**
 * A PIPELINE view is a kind's declared lifecycle drawn as columns, so
 * `views.create` (the one create door: tRPC, Hub, MCP `synap_create_view`)
 * refuses one whose kind declares no lifecycle, BEFORE its gate, with the next
 * step. Without it an agent's pipeline was filed as a proposal and approved
 * into a board with no columns.
 *
 * Behavioural through the real `views.create`; mocked: the DB, the gate (to
 * see whether it was reached) and `resolveProfileLifecycle` (the ONE
 * resolution the board itself uses, so "declares a lifecycle" means exactly
 * what the board will draw). What this does NOT see: the lifecycle read
 * itself (covered where it lives), and approve.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const WORKSPACE = "00000000-0000-4000-8000-0000000000e1";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  resolveLifecycle: vi.fn(),
}));

vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = {};
  return { ...actual, db: fakeDb, getDb: vi.fn(async () => fakeDb) };
});
vi.mock("@synap/storage", () => ({
  storage: { buildPath: vi.fn(), upload: vi.fn() },
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
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
}));
vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn().mockResolvedValue({ id: "evt-1" }),
}));
vi.mock("../services/lifecycle/board-lens.js", () => ({
  resolveProfileLifecycle: h.resolveLifecycle,
}));

import { viewsRouter } from "./views.js";

function caller() {
  return viewsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE,
  } as never);
}

beforeEach(() => {
  h.gate.mockReset();
  h.gate.mockResolvedValue({ proposalId: "proposal-1" });
  h.resolveLifecycle.mockReset();
});

describe("views.create — a pipeline needs a kind that declares a lifecycle", () => {
  it("refuses a pipeline with no kind named, and files nothing", async () => {
    const run = caller().create({
      workspaceId: WORKSPACE,
      name: "Deals",
      type: "pipeline",
      config: {},
    });
    await expect(run).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(run).rejects.toThrow(/"profileSlug" is required/);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("refuses a kind with no declared lifecycle with the next step, and files nothing", async () => {
    h.resolveLifecycle.mockRejectedValue(
      new TRPCError({ code: "PRECONDITION_FAILED", message: "no lifecycle" })
    );
    const run = caller().create({
      workspaceId: WORKSPACE,
      name: "Notes",
      type: "pipeline",
      config: { profileSlug: "note" },
    });
    await expect(run).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(run).rejects.toThrow(
      /"note" declares no lifecycle.*synap_declare_lifecycle/
    );
    expect(h.resolveLifecycle).toHaveBeenCalledWith("note", WORKSPACE);
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("files a pipeline of a kind that declares one, storing only the kind", async () => {
    h.resolveLifecycle.mockResolvedValue({ lifecycle: { options: [{}] } });
    const result = await caller().create({
      workspaceId: WORKSPACE,
      name: "Deals",
      type: "pipeline",
      config: { profileSlug: "deal" },
    });
    expect(result).toMatchObject({ status: "proposed" });
    expect(h.resolveLifecycle).toHaveBeenCalledWith("deal", WORKSPACE);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.gate.mock.calls[0]![0]).toMatchObject({
      subjectType: "view",
      action: "create",
      data: { type: "pipeline", config: { profileSlug: "deal" } },
    });
  });
});
