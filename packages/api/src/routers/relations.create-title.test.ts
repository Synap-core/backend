/**
 * What `relations.create` FILES with the gate: the edge's endpoints and type,
 * and NO synthetic `title`. It used to send `"<id8> --type--> <id8>"`, which the
 * card then showed as the relation's name — two raw id prefixes. The read names
 * an edge by its endpoints (`sourceLabel`/`targetLabel`, `objectRefs`).
 *
 * Harness: the partial-mock shape of relations.unlink-and-expose-proposals.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockCheckPermission } = vi.hoisted(() => {
  const SRC = "00000000-0000-4000-8000-000000000001";
  const TGT = "00000000-0000-4000-8000-000000000002";
  const WS = "00000000-0000-4000-8000-000000000010";
  const mockDatabase = {
    query: {
      entities: {
        findMany: vi.fn(async () => [
          { id: SRC, workspaceId: WS },
          { id: TGT, workspaceId: WS },
        ]),
        findFirst: vi.fn(async () => undefined),
      },
    },
  };
  return {
    mockGetDb: vi.fn(async () => mockDatabase),
    mockCheckPermission: vi.fn(),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: mockGetDb,
    eventRepository: { __shared: true },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermission,
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { relationsRouter } from "./relations.js";

const USER = "00000000-0000-4000-8000-0000000000aa";
const SRC = "00000000-0000-4000-8000-000000000001";
const TGT = "00000000-0000-4000-8000-000000000002";
const WS = "00000000-0000-4000-8000-000000000010";

const caller = relationsRouter.createCaller({
  authenticated: true,
  userId: USER,
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPermission.mockResolvedValue({ proposalId: "prop-1" });
});

describe("relations.create — the proposal carries no synthetic title", () => {
  it("files endpoints + type, and no '<id8> --type--> <id8>' string anywhere", async () => {
    const res = await caller.create({
      sourceEntityId: SRC,
      targetEntityId: TGT,
      type: "same_subject",
      workspaceId: WS,
    });

    expect(res).toEqual({ status: "proposed", proposalId: "prop-1" });
    expect(mockCheckPermission).toHaveBeenCalledTimes(1);
    const opts = mockCheckPermission.mock.calls[0]![0];
    expect(opts.subjectType).toBe("relation");
    expect(opts.action).toBe("create");
    expect(opts.data).toMatchObject({
      sourceEntityId: SRC,
      targetEntityId: TGT,
      type: "same_subject",
    });
    expect(opts.data).not.toHaveProperty("title");
    expect(JSON.stringify(opts.data)).not.toContain("-->");
  });
});
