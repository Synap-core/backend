import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `artifacts.setState` on a POD-PERSONAL row.
 *
 * Since 0245 `artifacts.workspace_id` is NULLABLE — a workspace-less session
 * records its outputs pod-personal, which is the COMMON case, not the edge one.
 * The door gated the write with `assertWorkspaceWrite(db, userId, {
 * workspaceId: existing.workspaceId })` and passed NO `ownerId`. That helper
 * treats a NULL-workspace row with no owner as SYSTEM-MANAGED and throws
 * FORBIDDEN, so every pod-personal artifact was un-keepable, un-sweepable and
 * un-re-placeable by the very user who owns it — a whole lane of the desk dead.
 *
 * DB-free: `@synap/database` is partially mocked (real tables/operators kept).
 */

const findFirstSpy = vi.fn();
const setSpy = vi.fn();
/** What the mocked membership lookup answers. `null` ⇒ not a member. */
let membership: { role: string } | null = null;

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const database = {
    query: new Proxy({} as Record<string, unknown>, {
      get: (_t, table) =>
        table === "artifacts"
          ? { findFirst: findFirstSpy }
          : { findFirst: async () => undefined },
    }),
    select: (...args: unknown[]) =>
      (actual.db as { select: (...a: unknown[]) => unknown }).select(...args),
    insert: () => {
      const chain: Record<string, unknown> = {
        values: () => chain,
        onConflictDoNothing: () => chain,
        onConflictDoUpdate: () => chain,
        returning: async () => [],
        then: (resolve: (v: unknown) => void) => resolve([]),
      };
      return chain;
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        setSpy(patch);
        return {
          where: () => ({
            returning: async () => [{ ...ROW, ...patch }],
          }),
        };
      },
    }),
  };
  return {
    ...actual,
    getWorkspaceMembership: async () => membership,
    db: database,
    getDb: async () => database,
  };
});

const ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: null as string | null,
  userId: "user-1",
  kind: "document",
  title: "Launch spec",
  state: "working",
  placement: "desk",
};

const { artifactsRouter } = await import("./artifacts.js");
const caller = (userId = "user-1") =>
  artifactsRouter.createCaller({ userId, authenticated: true } as never);

beforeEach(() => {
  vi.clearAllMocks();
  membership = null;
  findFirstSpy.mockResolvedValue({ ...ROW });
});

describe("artifacts.setState — pod-personal rows (0245)", () => {
  it("lets the OWNER keep a NULL-workspace artifact", async () => {
    const updated = await caller().setState({
      id: ROW.id,
      state: "kept",
    });
    expect(updated.state).toBe("kept");
    // The keep stamp is written, so this is the real transition, not a no-op.
    expect(setSpy.mock.calls[0]![0]).toMatchObject({ state: "kept" });
    expect(setSpy.mock.calls[0]![0]).toHaveProperty("keptAt");
  });

  it("lets the OWNER sweep and re-place a NULL-workspace artifact", async () => {
    await caller().setState({
      id: ROW.id,
      state: "swept",
      placement: "library",
    });
    expect(setSpy.mock.calls[0]![0]).toMatchObject({
      state: "swept",
      placement: "library",
    });
  });

  it("still refuses a WORKSPACE artifact when the caller is not a member", async () => {
    // The owner fallback must not widen the workspace branch: a row WITH a
    // workspace stays membership-gated (the row is loaded owner-scoped, so this
    // is the ex-member / removed-membership case).
    findFirstSpy.mockResolvedValue({ ...ROW, workspaceId: "ws-1" });
    membership = null;
    await expect(
      caller().setState({ id: ROW.id, state: "kept" })
    ).rejects.toThrow(/not a member/i);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("allows a WORKSPACE artifact for an editor member", async () => {
    findFirstSpy.mockResolvedValue({ ...ROW, workspaceId: "ws-1" });
    membership = { role: "editor" };
    const updated = await caller().setState({ id: ROW.id, state: "kept" });
    expect(updated.state).toBe("kept");
  });
});
