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
  // Rules out: the card's sentence and the holder's sentence written apart
  // (access model B: one sentence, each tier in its own place).
  it("reads the holder's sentence: each tier in its own place", () => {
    const s = describeAppConnectProposal(PROPOSAL, NAMES)!;
    expect(s.access).toBe("Reads notes in Finance; changes people in Sales.");
    expect(s.sentence).toBe(`synap.live asks for access. ${s.access}`);
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
    expect(s.lines[1]!.where).toBe("Space");
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

  it("reads an AI's request, where `workspaceId: null` is anywhere it can reach", () => {
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
    expect(s.lines.map((l) => l.text)).toEqual([
      "Read Notes · Anywhere you can reach",
      "Create People · Sales",
    ]);
    expect(s.access).toBe(
      "Reads notes anywhere you can reach; changes people in Sales."
    );
    expect(s.lines[0]!.workspaceId).toBeNull();
    expect(s.lines[0]!.place).toEqual({ kind: "unbounded" });
    expect(
      isConnectProposal({ targetType: "entity", proposalType: "connect" })
    ).toBe(false);
  });
});

// Rules out: an app's pod-wide read named "Anywhere" in Relay and the browser
// while consent and pod admin say "Everywhere in your pod".
describe("an app's ask with no space is named as consent names it", () => {
  it("an app reads 'Everywhere in your pod'; an AI 'Anywhere you can reach'", () => {
    const requests = [
      { permission: "entity.decision.read", workspaceId: null },
    ] as const;
    const app = summarizeAppConnectRequest({ appName: "DevPlane", requests });
    expect(app.lines[0]!.where).toBe("Everywhere in your pod");
    const ai = summarizeAppConnectRequest({
      appName: "Claude Code",
      requests,
      holderKind: "agent",
    });
    expect(ai.lines[0]!.where).toBe("Anywhere you can reach");
  });

  // Rules out: a blank space id read as "no space" (`|| null`), which made it
  // a pod-wide read; and a stored scope that contradicts its space.
  it("a request whose place does not parse is unreadable, never pod-wide", () => {
    const bad = (request: Record<string, unknown>) =>
      describeAppConnectProposal({
        ...PROPOSAL,
        data: { name: "x", requests: [request] },
      });
    expect(bad({ permission: "entity.note.read", workspaceId: "" })).toBeNull();
    expect(
      bad({ permission: "entity.note.read", workspaceId: "w", scope: "pod" })
    ).toBeNull();
    expect(
      bad({ permission: "entity.note.read", workspaceId: null, scope: "pod" })
        ?.lines[0]?.where
    ).toBe("Everywhere in your pod");
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
