import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { proposalHeading } from "./proposal-heading";

/** The row `requestAccess` files (`services/app-connect.ts`). */
const appConnectRow = {
  targetType: "app",
  targetName: null,
  proposalType: "connect",
};
const payload = {
  appId: "11111111-aaaa-4bbb-8ccc-111111111111",
  publicId: "app_d2f2",
  name: "synap.live",
  requests: [
    {
      permission: "entity.person.create",
      workspaceId: "ws-1",
      workspaceName: "Sales",
    },
    {
      permission: "entity.note.read",
      workspaceId: "ws-2",
      workspaceName: "Finance",
    },
  ],
};

describe("the review page heading", () => {
  it("a tool run reads as its action and its tool, never 'Run Tool'", () => {
    const row = {
      targetType: "capability",
      targetName: null,
      proposalType: "capability.run",
      review: {
        toolRun: {
          action: "Create server",
          tool: "Hetzner cloud",
          parameters: [],
        },
      },
    };
    expect(proposalHeading(row, {}).heading).toBe(
      "Create server · Hetzner cloud"
    );
    expect(
      proposalHeading(
        {
          ...row,
          review: { toolRun: { action: "Create server", parameters: [] } },
        },
        {}
      ).heading
    ).toBe("Create server");
  });

  it("an app/connect request reads '<app> asks for access', one line per space", () => {
    const h = proposalHeading(appConnectRow, payload);
    expect(h.heading).toBe("synap.live asks for access");
    expect(h.heading).not.toMatch(/Connect/);
    expect(h.appConnect?.lines.map((l) => l.text)).toEqual([
      "Create People · Sales",
      "Read Notes · Finance",
    ]);
  });

  it("an unreadable request falls back to the generic verb + noun, never a half-read sentence", () => {
    const h = proposalHeading(appConnectRow, { name: "x" });
    expect(h.appConnect).toBeNull();
    expect(h.heading).not.toBe("");
  });

  it("any other proposal keeps its imperative verb + noun", () => {
    const h = proposalHeading(
      { targetType: "workspace", targetName: "Sales", proposalType: "create" },
      {}
    );
    expect(h.appConnect).toBeNull();
    expect(h.heading).toMatch(/^Create/);
  });

  it("an agent's held-writes pack names the agent, never 'Held writes Agent'", () => {
    const row = {
      targetType: "agent",
      targetName: null,
      proposalType: "held_writes",
      agentActorName: "Claude-code",
    };
    const pack = { day: "2026-10-27", agentUserId: "a1", deferredWrites: [] };
    const h = proposalHeading(row, pack);
    expect(h.heading).toBe(
      "Writes held for review: Claude-code, 2026-10-27, 0 items"
    );
    expect(h.heading).not.toMatch(/Held writes|Agent/);
    // No name the pod resolved: still never the raw token or "Agent".
    expect(
      proposalHeading({ ...row, agentActorName: null }, pack).heading
    ).toBe("Writes held for review: 2026-10-27, 0 items");
    expect(proposalHeading({ ...row, agentActorName: null }, {}).heading).toBe(
      "Writes held for review"
    );
  });

  it("the decision card (page and Review drawer) renders the lines in place of the raw payload", () => {
    const src = readFileSync(join(__dirname, "ProposalReviewCard.tsx"), "utf8");
    expect(src).toMatch(/proposalHeading\(p, payload\)/);
    expect(src).toMatch(/appConnect \? \(/);
    expect(src).toMatch(/appConnect\.lines\.map/);
  });
});
