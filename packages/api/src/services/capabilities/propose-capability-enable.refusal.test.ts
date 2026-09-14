/**
 * The ONE refusal every gate door returns (`resolveNotEnabledRefusal`), and the
 * two filing paths `proposeCapabilityEnable` adds for the remaining doors:
 * TOOL rows, and the OWNER-attributed request an unattended run files.
 *
 * Each case rules out a named wrong rule — see the test titles.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const PACK = { id: "cap-mail", name: "Mail" };
const inserted: any[] = [];
let openOwnerRequest: Array<{ id: string }> = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const isProposals = table === (actual as any).proposals;
            const rows = isProposals
              ? openOwnerRequest
              : table === (actual as any).tools
                ? [{ id: "tool-send", name: "gmail_send" }]
                : [];
            return {
              limit: async () => rows,
              then: (resolve: (v: unknown) => unknown) => resolve(rows),
            };
          },
        }),
      }),
    },
  };
});

vi.mock("./capability-registry.js", () => ({
  containerMemberKey: (kind: string, id: string) => `${kind}:${id}`,
  loadContainerRefs: async (m: { toolIds: string[]; skillIds: string[] }) =>
    new Map([
      ...m.toolIds.map((id) => [`tool:${id}`, PACK] as const),
      ...m.skillIds.map((id) => [`skill:${id}`, PACK] as const),
    ]),
}));

vi.mock("../links/links-service.js", () => ({
  getCapabilityMemberParts: async () => [
    { kind: "tool", id: "tool-send", capabilityId: PACK.id },
  ],
}));

vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: any) => {
    inserted.push(input);
    return { id: `prop-${inserted.length}` };
  },
}));

const {
  resolveNotEnabledRefusal,
  proposeCapabilityEnable,
  notEnabledHumanMessage,
  notInstalledMessage,
} = await import("./propose-capability-enable.js");

const TOOL = { kind: "tool" as const, id: "tool-send", name: "gmail_send" };
const BASE = { userId: "owner-1", workspaceId: "ws-1", reason: "gate text" };

describe("resolveNotEnabledRefusal — the one refusal", () => {
  beforeEach(() => {
    inserted.length = 0;
    openOwnerRequest = [];
  });

  it("agent on a not-enabled TOOL → one request carrying toolIds, message says nothing ran + review link", async () => {
    const out = await resolveNotEnabledRefusal({
      ...BASE,
      capability: { ...TOOL, approved: false },
      installed: true,
      agentUserId: "agent-1",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].data.toolIds).toEqual(["tool-send"]);
    expect(inserted[0].data.skillIds).toEqual([]);
    expect(out.enableProposal?.status).toBe("proposed");
    expect(out.message).toMatch(/^Nothing ran/);
    expect(out.message).toMatch(/Review: /);
  });

  it("human on a not-enabled row → no request, Settings pointer (rules out 'everyone proposes')", async () => {
    const out = await resolveNotEnabledRefusal({
      ...BASE,
      capability: { ...TOOL, approved: false },
      installed: true,
      agentUserId: null,
    });
    expect(inserted).toHaveLength(0);
    expect(out.enableProposal).toBeUndefined();
    expect(out.message).toBe(notEnabledHumanMessage("gmail_send"));
  });

  it("no row (synthesized capability) → says there is nothing to enable, files nothing, even for an agent", async () => {
    const out = await resolveNotEnabledRefusal({
      ...BASE,
      capability: { ...TOOL, approved: false },
      installed: false,
      agentUserId: "agent-1",
    });
    expect(inserted).toHaveLength(0);
    expect(out.message).toBe(notInstalledMessage("gmail_send"));
    expect(out.message).not.toMatch(/installed but not enabled/);
  });

  it("policy deny on an ENABLED row → the gate's reason, untouched (rules out 'every deny is not-enabled')", async () => {
    const out = await resolveNotEnabledRefusal({
      ...BASE,
      capability: { ...TOOL, approved: true },
      installed: true,
      agentUserId: "agent-1",
    });
    expect(out).toEqual({ message: "gate text" });
    expect(inserted).toHaveLength(0);
  });
});

describe("proposeCapabilityEnable — owner-attributed (unattended) filing", () => {
  beforeEach(() => {
    inserted.length = 0;
    openOwnerRequest = [];
  });

  it("files one owner request when none is open", async () => {
    const offers = await proposeCapabilityEnable({
      refused: [TOOL],
      userId: "owner-1",
      workspaceId: "ws-1",
      agentUserId: null,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].agentUserId).toBeNull();
    expect(offers[0]).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
    });
  });

  it("reuses the OPEN owner request on the same pack instead of filing a second one each cron tick", async () => {
    openOwnerRequest = [{ id: "prop-open" }];
    const offers = await proposeCapabilityEnable({
      refused: [TOOL],
      userId: "owner-1",
      workspaceId: "ws-1",
      agentUserId: null,
    });
    expect(inserted).toHaveLength(0);
    expect(offers[0]).toMatchObject({
      status: "proposed",
      proposalId: "prop-open",
    });
  });
});
