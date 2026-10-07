/**
 * An app asking for access reads ONE way at every door: grouped by space,
 * never a cross product (the W0 security bug flattened exactly that).
 */
import { describe, expect, it } from "vitest";
import {
  describeAppConnectProposal,
  isAppConnectProposal,
  summarizeAppConnectRequest,
} from "../intent.js";

// The shape `rest/apps.ts` POST /apps/:id/connect files.
const PROPOSAL = {
  targetType: "app",
  proposalType: "connect",
  data: {
    appId: "a1",
    publicId: "app_d2f2",
    name: "synap.live",
    requests: [
      { permission: "entity.person.create", workspaceId: "ws-sales" },
      { permission: "entity.note.read", workspaceId: "ws-fin" },
    ],
  },
};
const NAMES = { "ws-sales": "Sales", "ws-fin": "Finance" };

describe("app/connect proposal words", () => {
  it("reads the founder's sentence", () => {
    expect(describeAppConnectProposal(PROPOSAL, NAMES)?.sentence).toBe(
      "synap.live asks for access: Create People · Sales, Read Notes · Finance"
    );
  });

  it("groups per space — never 'Create People, Read Notes' across both spaces", () => {
    const s = describeAppConnectProposal(PROPOSAL, NAMES)!;
    expect(s.lines).toHaveLength(2);
    expect(s.lines.map((l) => l.what)).toEqual(["Create People", "Read Notes"]);
    for (const l of s.lines) expect(l.what).not.toMatch(/,|;/);
  });

  it("merges two asks in one space into that space's line", () => {
    const s = summarizeAppConnectRequest({
      appName: "CRM sync",
      requests: [
        { permission: "entity.person.create", workspaceId: "w" },
        { permission: "entity.person.read", workspaceId: "w" },
      ],
      workspaceNames: { w: "Sales" },
    });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]!.where).toBe("Sales");
  });

  it("a stored workspaceName wins; an unknown space never shows its id", () => {
    const s = summarizeAppConnectRequest({
      appName: "x",
      requests: [
        {
          permission: "entity.person.create",
          workspaceId: "w1",
          workspaceName: "Ops",
        },
        { permission: "entity.person.create", workspaceId: "uuid-123" },
      ],
    });
    expect(s.lines[0]!.where).toBe("Ops");
    expect(s.lines[1]!.where).toBe("1 Space");
    expect(s.sentence).not.toContain("uuid-123");
  });

  it("is null for other proposals and for unreadable data (fallback, not a half sentence)", () => {
    expect(
      isAppConnectProposal({ targetType: "app", proposalType: "revoke" })
    ).toBe(false);
    expect(
      describeAppConnectProposal({
        targetType: "entity",
        proposalType: "connect",
        data: PROPOSAL.data,
      })
    ).toBeNull();
    expect(
      describeAppConnectProposal({
        ...PROPOSAL,
        data: { name: "x", requests: [{ permission: 3 }] },
      })
    ).toBeNull();
  });
});
