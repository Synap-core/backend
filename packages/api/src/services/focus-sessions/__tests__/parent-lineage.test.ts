/**
 * `withParentSessionId` / `attachParentSessionIds` — the tRPC read-side
 * projection of `session --spawned_from--> session` lineage, mirroring the
 * MCP handlers' `synap_get_session` / `synap_list_sessions`
 * (`routers/mcp/handlers/session.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getParentSessionIdMock, getParentSessionIdsMock } = vi.hoisted(() => ({
  getParentSessionIdMock: vi.fn(async (_id: string) => null as string | null),
  getParentSessionIdsMock: vi.fn(
    async (_ids: string[]) => new Map<string, string>()
  ),
}));

vi.mock("@synap/database", () => ({
  getParentSessionId: getParentSessionIdMock,
  getParentSessionIds: getParentSessionIdsMock,
}));

import {
  withParentSessionId,
  attachParentSessionIds,
} from "../parent-lineage.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withParentSessionId (get)", () => {
  it("a root session (no spawned_from edge) carries parentSessionId: null", async () => {
    getParentSessionIdMock.mockResolvedValueOnce(null);
    const result = await withParentSessionId({ id: "root-1", goal: "x" });
    expect(result.parentSessionId).toBeNull();
    expect(result.id).toBe("root-1");
    expect(getParentSessionIdMock).toHaveBeenCalledWith("root-1");
  });

  it("a child session carries its parent's id", async () => {
    getParentSessionIdMock.mockResolvedValueOnce("parent-1");
    const result = await withParentSessionId({ id: "child-1", goal: "y" });
    expect(result.parentSessionId).toBe("parent-1");
  });
});

describe("attachParentSessionIds (list)", () => {
  it("stamps each row from ONE batched lookup, root sessions get null", async () => {
    getParentSessionIdsMock.mockResolvedValueOnce(
      new Map([["child-1", "parent-1"]])
    );
    const rows = await attachParentSessionIds([
      { id: "child-1", goal: "y" },
      { id: "root-1", goal: "x" },
    ]);
    expect(rows).toEqual([
      { id: "child-1", goal: "y", parentSessionId: "parent-1" },
      { id: "root-1", goal: "x", parentSessionId: null },
    ]);
    expect(getParentSessionIdsMock).toHaveBeenCalledTimes(1);
    expect(getParentSessionIdsMock).toHaveBeenCalledWith(["child-1", "root-1"]);
  });

  it("an empty page short-circuits without a query", async () => {
    const rows = await attachParentSessionIds([]);
    expect(rows).toEqual([]);
    expect(getParentSessionIdsMock).not.toHaveBeenCalled();
  });
});
