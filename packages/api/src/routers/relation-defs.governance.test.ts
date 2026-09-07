import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

// FALLBACK, deliberately NOT `importOriginal`: loading the real
// `permission-check.js` here transitively pulls `@synap/jobs`
// (automation-run-reaper -> post-run-summary), which reads `isNull` off this
// file's intentional `@synap/database` class-stub and dies with
// `No "isNull" export is defined on the "@synap/database" mock`. So the export
// list is named by hand. `proposedMessageFor` is stubbed to IDENTITY, which
// matches the real function on every non-join-gate path; do NOT assert
// join-gate prose through this mock — it would assert the stub, not the source.
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({})),
  proposedMessageFor: (_type: unknown, message: string) => message,
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "audit-1" })),
}));

vi.mock("../access/index.js", () => ({
  scopedDb: vi.fn(),
  AccessContext: { from: vi.fn() },
}));

vi.mock("@synap/database", async () => {
  const drizzle =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  class RelationDefRepository {
    async create(input: Record<string, unknown>) {
      h.createCalls.push(input);
      return { ...input, createdAt: new Date(), updatedAt: new Date() };
    }
  }
  return {
    and: drizzle.and,
    asc: drizzle.asc,
    eq: drizzle.eq,
    getDb: vi.fn(async () => ({})),
    RelationDefRepository,
    db: {
      query: {
        syncGeneration: {
          findFirst: vi.fn(async () => ({
            role: "primary",
            splitBrainDetected: false,
          })),
        },
        workspaceMembers: {
          findFirst: vi.fn(async () => ({ role: "owner" })),
        },
        workspaces: {
          findFirst: vi.fn(async () => ({ archivedAt: null })),
        },
      },
    },
  };
});

vi.mock("@synap/database/schema", () => ({
  relationDefs: { slug: "slug" },
  workspaceMembers: { workspaceId: "workspaceId", userId: "userId" },
  workspaces: { id: "id" },
}));

import { createContext } from "../context.js";
import { relationDefsRouter } from "./relation-defs.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";

async function callerCtx() {
  const ctx = await createContext(new Request("http://localhost:3000"));
  ctx.authenticated = true;
  ctx.userId = "user-1";
  ctx.workspaceId = "workspace-1";
  return ctx;
}

describe("relationDefs.create governance", () => {
  beforeEach(() => {
    h.createCalls.length = 0;
    vi.mocked(checkPermissionOrPropose).mockResolvedValue({} as never);
  });

  it("materializes an approved relationship type with a stable id", async () => {
    const caller = relationDefsRouter.createCaller(await callerCtx());
    const result = await caller.create({
      slug: "advises",
      displayName: "Advises",
    });

    expect(result.status).toBe("created");
    expect(h.createCalls[0]).toMatchObject({
      slug: "advises",
      displayName: "Advises",
      workspaceId: "workspace-1",
    });
    expect(typeof h.createCalls[0]?.id).toBe("string");
  });

  it("returns a proposal without writing the definition", async () => {
    vi.mocked(checkPermissionOrPropose).mockResolvedValueOnce({
      proposalId: "proposal-1",
    } as never);
    const caller = relationDefsRouter.createCaller(await callerCtx());
    const result = await caller.create({
      slug: "advises",
      displayName: "Advises",
    });

    expect(result).toMatchObject({
      status: "proposed",
      proposalId: "proposal-1",
    });
    expect(h.createCalls).toHaveLength(0);
  });
});
