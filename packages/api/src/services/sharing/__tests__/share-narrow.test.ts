/**
 * `assertCanNarrow` — unshare needs LESS than share: administer the anchor OR
 * write the record. Only the anchor check's REFUSAL may fall through to the
 * record check; a fault (the membership read failing) must surface, never be
 * reinterpreted as "not an admin, try the other way".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  anchorAdmin: vi.fn(),
  workspaceWrite: vi.fn(),
}));
vi.mock("../anchor-admin.js", () => ({ assertAnchorAdmin: h.anchorAdmin }));
vi.mock("../../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: h.workspaceWrite,
}));

import { assertCanNarrow } from "../share-service.js";

const TARGET = {
  kind: "entity" as const,
  id: "e1",
  workspaceId: "w1",
  ownerId: "u1",
};
const ANCHOR = { id: "p1", workspaceId: "w1", userId: "owner" };
const run = () => assertCanNarrow({} as never, "u1", TARGET, ANCHOR);

beforeEach(() => {
  h.anchorAdmin.mockReset();
  h.workspaceWrite.mockReset();
});

describe("assertCanNarrow", () => {
  it("an anchor admin passes without the record check", async () => {
    h.anchorAdmin.mockResolvedValue(undefined);
    await expect(run()).resolves.toBeUndefined();
    expect(h.workspaceWrite).not.toHaveBeenCalled();
  });

  it("not an anchor admin ⇒ the record-write check decides", async () => {
    h.anchorAdmin.mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN", message: "not admin" })
    );
    h.workspaceWrite.mockResolvedValue(undefined);
    await expect(run()).resolves.toBeUndefined();
    expect(h.workspaceWrite).toHaveBeenCalledTimes(1);
  });

  it("a FAULT in the anchor check surfaces; the record check never runs", async () => {
    h.anchorAdmin.mockRejectedValue(new Error("connection terminated"));
    h.workspaceWrite.mockResolvedValue(undefined);
    await expect(run()).rejects.toThrow("connection terminated");
    expect(h.workspaceWrite).not.toHaveBeenCalled();
  });
});
