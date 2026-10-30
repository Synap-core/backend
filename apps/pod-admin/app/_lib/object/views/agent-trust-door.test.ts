import { describe, expect, it } from "vitest";
import { agentTrustDoor } from "./agent-trust-door";

describe("agentTrustDoor: where an agent's trust is changed", () => {
  it("an admin gets a link to the console page that widens or revokes it", () => {
    expect(agentTrustDoor("admin")).toEqual({
      kind: "link",
      href: "/governance/agents",
      label: "Change what it may do without asking",
    });
  });

  it("a member is told who can change it, never a link that answers /forbidden", () => {
    const door = agentTrustDoor("member");
    expect(door.kind).toBe("note");
  });

  it("never sends anyone to the desktop app", () => {
    for (const role of ["admin", "member"] as const) {
      expect(JSON.stringify(agentTrustDoor(role))).not.toMatch(
        /desktop|synap:\/\/|Settings ›/
      );
    }
  });
});
