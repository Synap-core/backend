/**
 * The adapter's merge of `proposalUpdates` into a tool result (ticket
 * 437d7370). The read itself is pinned in
 * `services/proposals/proposal-updates-digest.pglite.test.ts`.
 *
 * NOT covered here: that `executeMCPToolViaHubProtocol` calls it for an agent
 * (one line before `withUiStructuredContent`); driving the whole adapter needs
 * the session, caller and workspace-lens machinery mocked.
 */
import { describe, it, expect } from "vitest";
import { withProposalUpdates } from "./adapter.js";
import type { ProposalUpdate } from "../../services/proposals/proposal-updates-digest.js";

const UPDATE: ProposalUpdate = {
  id: "df94aeac-b66d-47f7-ba77-27df3bdf6e6f",
  status: "approved",
  change: "settings/settings.update",
  reviewedAt: "2026-10-25T17:26:14.242Z",
  reviewUrl: "/open/df94aeac-b66d-47f7-ba77-27df3bdf6e6f",
};

describe("withProposalUpdates", () => {
  it("adds the digest to the JSON payload, keeping every other key", () => {
    const out = withProposalUpdates(
      {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, id: "x" }) },
        ],
      },
      [UPDATE]
    );
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload).toEqual({ ok: true, id: "x", proposalUpdates: [UPDATE] });
    expect(out.content).toHaveLength(1);
  });

  it("appends it as its own JSON block to a plain-text result", () => {
    const out = withProposalUpdates(
      { content: [{ type: "text", text: "Agent proposal limit reached." }] },
      [UPDATE]
    );
    expect(out.content).toHaveLength(2);
    expect(JSON.parse((out.content[1] as { text: string }).text)).toEqual({
      proposalUpdates: [UPDATE],
    });
  });

  it("leaves the result untouched when there is nothing to tell, or the read failed", () => {
    const result = {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    };
    expect(withProposalUpdates(result, [])).toBe(result);
    expect(withProposalUpdates(result, null)).toBe(result);
  });
});
