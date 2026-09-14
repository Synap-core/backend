/**
 * Seam test — an agent connector pull denied by the gate says WHY, honestly.
 *
 * `pullToImport` gates a SYNTHESIZED capability (`read://<type>`, no `tools`
 * row, `approved: false`), so the gate's "installed but not yet enabled" was a
 * false statement and no enable request is possible. The refusal must say there
 * is nothing to enable, file nothing, and not read upstream.
 */

import { describe, it, expect, vi } from "vitest";

const inserted: unknown[] = [];

vi.mock("./capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({
    decision: "deny",
    reason: "This capability is installed but not yet enabled.",
  }),
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: unknown) => {
    inserted.push(input);
    return { id: "should-not-exist" };
  },
}));

const { pullToImport } = await import("./connector-import-bridge.js");

describe("pullToImport — agent pull on a synthesized capability", () => {
  it("returns an honest 'nothing to enable' reason, reads nothing, files nothing", async () => {
    const read = vi.fn();
    const out = await pullToImport({
      ctx: { workspaceId: "ws-1", userId: "owner-1", trpcCtx: {} },
      connector: {
        type: "unipile",
        kind: "messaging",
        read,
        getMessages: read,
      } as never,
      request: { kind: "messaging", accountId: "a", threadId: "t" } as never,
      gate: { agentUserId: "agent-1" },
    });
    expect(out.gated).toBe("denied");
    expect(out.gateReason).toMatch(
      /^Nothing ran: "unipile" has no installed capability/
    );
    expect(out.gateReason).not.toMatch(/installed but not yet enabled/);
    expect(read).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});
