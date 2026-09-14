/**
 * D1 floor — `defineCell` refuses while an AGENT principal is acting.
 *
 * Every cell-definition door converges here (MCP synap_create_cell, hub
 * /cells/define, hub /cells/install, package install, the approve executor).
 * Hub `/cells/install` had no gate and `/cells/define` skipped its gate when no
 * agentUserId reached it — both now refuse for an agent. The governed doors
 * propose before reaching this line; an approval runs outside the agent scope.
 */

import { describe, it, expect, vi } from "vitest";

const getDb = vi.fn(async () => {
  throw new Error("db reached");
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb };
});
vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: vi.fn(),
}));

const { runWithActingAgent } = await import("@synap/database");
const { defineCell, AGENT_CELL_REQUIRES_PROPOSAL } =
  await import("./define-cell.js");

const BASE = {
  name: "Vendor Panel",
  rendererSource: "export default () => null;",
  userId: "u-1",
};

describe("defineCell — acting-agent floor (D1)", () => {
  it("an agent principal is refused before the database is touched", async () => {
    getDb.mockClear();
    await expect(
      runWithActingAgent("agent-1", () => defineCell(BASE))
    ).rejects.toMatchObject({
      code: AGENT_CELL_REQUIRES_PROPOSAL,
      message: expect.stringContaining("synap_create_cell"),
    });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("no agent in scope (a person, or the approval of a proposal) reaches the write", async () => {
    getDb.mockClear();
    await expect(defineCell(BASE)).rejects.toThrow("db reached");
    expect(getDb).toHaveBeenCalledTimes(1);
  });
});
