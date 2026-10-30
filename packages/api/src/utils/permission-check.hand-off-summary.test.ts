import { describe, expect, it } from "vitest";
import { buildProposalSummary } from "./permission-check.js";

/**
 * An agent's HAND-OFF proposal names the session and the agent it goes to —
 * not "Assign agent Session …", which never said WHO gets the work. The
 * payload is the one `gateAgentHandOff` sends (`agentName` is display-only),
 * pinned end-to-end in `agent-hand-off.pglite.test.ts`.
 */
describe("buildProposalSummary — handing a session to an agent", () => {
  it("names the session and the agent", () => {
    expect(
      buildProposalSummary("focus_session", "assign_agent", {
        id: "s",
        goal: "Fix the worker",
        addAgentId: "a",
        agentName: "Claude Code devbox",
      })
    ).toBe('Hand job "Fix the worker" to Claude Code devbox');
  });

  it("an unnamed agent still reads as a hand-off", () => {
    expect(
      buildProposalSummary("focus_session", "assign_agent", {
        id: "s",
        goal: null,
        addAgentId: "a",
        agentName: null,
      })
    ).toBe("Hand a job to another agent");
  });
});
