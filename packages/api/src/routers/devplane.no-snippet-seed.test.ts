/**
 * DevPlane is retired and a snippet is the person's own text: opening the
 * DevPlane app must never write a `snippet` row. `seedDefaultSnippets` used to
 * write twelve legacy `@{arg:x}` prompts into the pod-wide kind and guard on
 * "this user has any snippet". It is now a no-op that says so.
 *
 * DB and the entity materializer are mocked; nothing reaches Postgres.
 * NEGATIVE CONTROL: restoring the writing branch (materializeEntity per
 * default) turns "writes nothing" red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, materialize } = vi.hoisted(() => ({
  mockDb: {
    query: {
      workspaceMembers: {
        findFirst: vi.fn().mockResolvedValue({ role: "owner" }),
      },
      workspaces: {
        findFirst: vi.fn().mockResolvedValue({ archivedAt: null }),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  materialize: vi.fn(),
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
  return {
    ...actual,
    db: mockDb,
    getDb: vi.fn().mockResolvedValue(mockDb),
    materializeEntity: materialize,
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
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

import { devplaneRouter } from "./devplane.js";

const caller = () =>
  devplaneRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: "00000000-0000-4000-8000-000000000010",
  } as never);

describe("devplane.seedDefaultSnippets (retired)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes nothing and reports that nothing was seeded", async () => {
    const out = await caller().seedDefaultSnippets();
    expect(out).toMatchObject({ seeded: false });
    expect(materialize).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
