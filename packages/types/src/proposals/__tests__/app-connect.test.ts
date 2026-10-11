/**
 * An app asking for access reads ONE way at every door: grouped by space,
 * never a cross product (the W0 security bug flattened exactly that).
 */
import { describe, expect, it } from "vitest";
import {
  describeAppConnectProposal,
  isAppConnectProposal,
  isConnectProposal,
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

  it("reads an AI's request, where `workspaceId: null` is anywhere", () => {
    const AGENT = {
      targetType: "agent",
      proposalType: "connect",
      data: {
        agentUserId: "u1",
        keyId: "k1",
        name: "Claude Code",
        requests: [
          { permission: "entity.note.read", workspaceId: null },
          { permission: "entity.person.create", workspaceId: "ws-sales" },
        ],
      },
    };
    expect(isConnectProposal(AGENT)).toBe(true);
    expect(isAppConnectProposal(AGENT)).toBe(false);
    const s = describeAppConnectProposal(AGENT, NAMES)!;
    expect(s.sentence).toBe(
      "Claude Code asks for access: Read Notes · Anywhere, Create People · Sales"
    );
    expect(s.lines[0]!.workspaceId).toBeNull();
    expect(
      isConnectProposal({ targetType: "entity", proposalType: "connect" })
    ).toBe(false);
  });
});

describe("describeAppConnectProposal carries what the holder reader needs", () => {
  // Rules out: a card that can only print the asks, never what approving enables.
  it("the requests as read, and who asks (app vs AI)", () => {
    const s = describeAppConnectProposal(PROPOSAL, NAMES)!;
    expect(s.holderKind).toBe("app");
    expect(s.requests.length).toBeGreaterThan(0);
    expect(s.requests.every((r) => typeof r.permission === "string")).toBe(
      true
    );
    const ai = describeAppConnectProposal({
      ...PROPOSAL,
      targetType: "agent",
    })!;
    expect(ai.holderKind).toBe("agent");
  });
});
