/**
 * `views.update` (the tRPC door, and the apply half of Hub `views.updateView`)
 * holds a PIPELINE to the create rule: its kind must declare a lifecycle, or
 * the board has no columns.
 *
 * The defect it pins (review rev-code, finding 6310e11b): only `views.create`
 * ran `assertPipelineHasLifecycle`; an update that pointed a pipeline at a
 * kind with no lifecycle, or switched a view's type to `pipeline`, was saved
 * and opened an empty board.
 *
 * Behavioural through the real `views.update`; mocked: the DB (the stored
 * view), the write (to see whether it was reached) and
 * `resolveProfileLifecycle` (the ONE resolution the board uses).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const VIEW_ID = "00000000-0000-4000-8000-0000000000d1";
const USER = "user-1";

const h = vi.hoisted(() => ({
  viewRow: {} as Record<string, unknown>,
  update: vi.fn(),
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
  const fakeDb = {
    query: { views: { findFirst: vi.fn(async () => h.viewRow) } },
  };
  return {
    ...actual,
    db: fakeDb,
    getDb: vi.fn(async () => fakeDb),
    ViewRepository: class {
      update = h.update;
    },
  };
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
    userId: USER,
  } as never);
}

beforeEach(() => {
  // A personal view (no workspace): the access check is the owner match.
  h.viewRow = {
    id: VIEW_ID,
    workspaceId: null,
    userId: USER,
    type: "pipeline",
    name: "Deals",
    config: { profileSlug: "deal" },
    query: null,
    metadata: {},
  };
  h.update.mockReset();
  h.update.mockResolvedValue({ id: VIEW_ID });
  h.resolveLifecycle.mockReset();
});

const noLifecycle = () =>
  h.resolveLifecycle.mockRejectedValue(
    new TRPCError({ code: "PRECONDITION_FAILED", message: "no lifecycle" })
  );

describe("views.update — a pipeline's kind must declare a lifecycle", () => {
  it("refuses pointing a pipeline at a kind with no lifecycle, and saves nothing", async () => {
    noLifecycle();
    const run = caller().update({
      id: VIEW_ID,
      config: { profileSlug: "note" },
    });
    await expect(run).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(run).rejects.toThrow(
      /"note" declares no lifecycle.*synap_declare_lifecycle/
    );
    expect(h.resolveLifecycle).toHaveBeenCalledWith("note", null);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("refuses switching a view to a pipeline of a kind with no lifecycle (the stored config)", async () => {
    h.viewRow = {
      ...h.viewRow,
      type: "list",
      config: { profileSlug: "note" },
    };
    noLifecycle();
    const run = caller().update({ id: VIEW_ID, type: "pipeline" });
    await expect(run).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("CONTROL — saves a pipeline pointed at a kind that declares one", async () => {
    h.resolveLifecycle.mockResolvedValue({ lifecycle: { options: [{}] } });
    const res = await caller().update({
      id: VIEW_ID,
      config: { profileSlug: "lead" },
    });
    expect(res).toMatchObject({ status: "updated" });
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("CONTROL — a rename of a pipeline does not re-judge its kind", async () => {
    noLifecycle();
    const res = await caller().update({ id: VIEW_ID, name: "Renamed" });
    expect(res).toMatchObject({ status: "updated" });
    expect(h.resolveLifecycle).not.toHaveBeenCalled();
  });
});
