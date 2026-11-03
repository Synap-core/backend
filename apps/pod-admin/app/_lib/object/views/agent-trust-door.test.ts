import { describe, expect, it } from "vitest";
import { agentTrustDoor } from "./agent-trust-door";

describe("agentTrustDoor: where an agent's trust is changed", () => {
  it("an admin gets a link to the console page that widens or revokes it, narrowed to this agent", () => {
    expect(agentTrustDoor("admin", "agent-1")).toEqual({
      kind: "link",
      href: "/governance/agents?agent=agent-1",
      label: "What it may do in each space",
    });
  });

  it("a member is told who can change it, never a link that answers /forbidden", () => {
    const door = agentTrustDoor("member", "agent-1");
    expect(door.kind).toBe("note");
  });

  it("is the console's page, never the app's Settings: what an agent may do is running the pod (decision 94cd8636)", () => {
    for (const role of ["admin", "member"] as const) {
      expect(JSON.stringify(agentTrustDoor(role, "agent-1"))).not.toMatch(
        /desktop|synap:\/\/|Settings ›/
      );
    }
  });
});
