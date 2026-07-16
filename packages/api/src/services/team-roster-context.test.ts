import { describe, it, expect } from "vitest";
import {
  formatTeamRosterBlock,
  type TeamRosterMemberLine,
} from "./team-roster-context.js";

describe("formatTeamRosterBlock", () => {
  it("returns null for an empty roster", () => {
    expect(formatTeamRosterBlock([])).toBeNull();
  });

  it("formats name + personId without email (privacy)", () => {
    const members: TeamRosterMemberLine[] = [
      {
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        personId: "person-1",
      },
    ];
    const block = formatTeamRosterBlock(members);
    expect(block).toBe(
      [
        "OUR TEAM (internal — resolve/reuse these people by name/id; do NOT create new contact/client entities for them):",
        "- Ada Lovelace [person:person-1]",
      ].join("\n")
    );
    expect(block).not.toContain("ada@example.com");
  });

  it("omits personId when absent", () => {
    const members: TeamRosterMemberLine[] = [
      { displayName: "Grace Hopper" },
      { displayName: "Alan Turing", email: "  ", personId: null },
    ];
    expect(formatTeamRosterBlock(members)).toBe(
      [
        "OUR TEAM (internal — resolve/reuse these people by name/id; do NOT create new contact/client entities for them):",
        "- Grace Hopper",
        "- Alan Turing",
      ].join("\n")
    );
  });

  it("never puts email in the instruction block", () => {
    const members: TeamRosterMemberLine[] = [
      { displayName: "A", email: "a@x.com" },
      { displayName: "B", personId: "p-b" },
    ];
    const block = formatTeamRosterBlock(members)!;
    expect(block).not.toContain("@");
    expect(block).toContain("- A");
    expect(block).toContain("- B [person:p-b]");
  });
});
