/**
 * Agents inside a computer (0395, plan 31470fd5 §10 test 6): the default for
 * each row is decided by EVIDENCE, never by the hostname. On 2 Nov the page
 * reconnected devbox because its name matched (`defaultReuseId`) and re-keyed
 * a running worker; these pin that a hostname match picks the COMPUTER only.
 */
import { describe, expect, it } from "vitest";
import {
  DEVICE_IN_USE_WINDOW_MS,
  approveDecision,
  defaultAgentActions,
  defaultReuseId,
  deviceTitle,
  recommendRowAction,
  untouchedAgents,
  type DeviceRequest,
  type EvidenceAgent,
} from "./index.js";

const NOW = Date.parse("2026-11-03T00:00:00Z");
const used = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const agent = (over: Partial<EvidenceAgent> = {}): EvidenceAgent => ({
  id: "a-crm",
  agentType: "claude-code",
  seat: null,
  role: null,
  newestKeyId: "k-crm",
  liveKeyLastUsedAt: used(60_000),
  ...over,
});

const rec = (over: Partial<Parameters<typeof recommendRowAction>[0]> = {}) =>
  recommendRowAction({
    row: { agentType: "claude-code" },
    seat: "agent",
    heldKeyIds: [],
    agents: [agent()],
    now: NOW,
    ...over,
  });

describe("recommendRowAction — by evidence", () => {
  it("a new OS user next to an agent in use: add, never reconnect", () => {
    expect(rec()).toEqual({ action: "add", agentId: null, reason: "in-use" });
  });
  it("an older CLI (no seat, nothing held) next to an agent used in 24 h: add", () => {
    expect(rec({ seat: null })).toEqual({
      action: "add",
      agentId: null,
      reason: "in-use",
    });
  });
  it("the seat holding the agent's newest key reconnects it", () => {
    expect(rec({ seat: "antoine", heldKeyIds: ["k-crm"] })).toEqual({
      action: "reconnect",
      agentId: "a-crm",
      reason: "held",
    });
  });
  it("an agent idle for 24 h is reconnected, even from an older CLI", () => {
    const idle = [
      agent({ liveKeyLastUsedAt: used(DEVICE_IN_USE_WINDOW_MS + 1) }),
    ];
    expect(rec({ seat: null, agents: idle })).toMatchObject({
      action: "reconnect",
      reason: "idle",
    });
  });
  it("this seat's own agent is reconnected; another seat's is left alone", () => {
    const seated = [agent({ seat: "antoine" })];
    expect(rec({ seat: "antoine", agents: seated })).toMatchObject({
      action: "reconnect",
      reason: "this-seat",
    });
    expect(rec({ seat: "agent", agents: seated })).toEqual({
      action: "add",
      agentId: null,
      reason: "other-seat",
    });
    // An older CLI cannot prove it is antoine: it never takes a seated agent.
    expect(
      rec({
        seat: null,
        agents: [agent({ seat: "antoine", liveKeyLastUsedAt: null })],
      })
    ).toMatchObject({ action: "add", reason: "other-seat" });
  });
  it("a job is its own agent: the CRM worker never matches the dev worker", () => {
    const crm = [agent({ role: "crm-worker", liveKeyLastUsedAt: null })];
    expect(
      rec({
        row: { agentType: "claude-code", role: "dev-worker" },
        agents: crm,
      })
    ).toEqual({ action: "add", agentId: null, reason: "new" });
  });
});

const REQUEST: DeviceRequest = {
  requestId: "11111111-1111-4111-8111-111111111111",
  status: "pending",
  clientName: "synap-cli",
  hostname: "devbox",
  platform: "linux",
  agents: [
    {
      agentType: "claude-code",
      name: "Claude Code",
      displayName: "Claude Code on devbox",
    },
  ],
  requesterIp: null,
  userAgent: null,
  createdAt: used(60_000),
  expiresAt: used(-540_000),
  keyTtlDays: 90,
  accessName: "AI — read & propose",
  seat: "agent",
  rows: [
    {
      key: "claude-code:",
      agentType: "claude-code",
      role: null,
      roleLabel: null,
      name: "Claude Code",
    },
  ],
  reusableComputers: [
    {
      id: "m-devbox",
      name: "devbox",
      createdAt: used(86_400_000 * 20),
      agents: [
        {
          id: "a-crm",
          name: "CRM worker",
          agentType: "claude-code",
          role: "crm-worker",
          seat: "antoine",
          lastSeenAt: used(120_000),
          workerServedAt: used(120_000),
          live: true,
        },
        {
          id: "a-cc",
          name: "Claude Code",
          agentType: "claude-code",
          role: null,
          seat: null,
          lastSeenAt: used(60_000),
          live: true,
        },
      ],
      recommended: [
        {
          rowKey: "claude-code:",
          action: "add",
          agentId: null,
          reason: "in-use",
        },
      ],
    },
  ],
};

describe("the page's defaults", () => {
  it("the hostname picks the computer, the evidence picks each agent's action", () => {
    expect(defaultReuseId(REQUEST)).toBe("m-devbox");
    expect(defaultAgentActions(REQUEST, "m-devbox")).toEqual([
      {
        rowKey: "claude-code:",
        agentType: "claude-code",
        role: null,
        roleLabel: null,
        action: "add",
        agentId: null,
      },
    ]);
    expect(
      deviceTitle(
        REQUEST,
        "m-devbox",
        "devbox",
        defaultAgentActions(REQUEST, "m-devbox")
      )
    ).toBe("Add an agent to devbox?");
  });
  it("every agent of the computer stays as it is when nothing is reconnected", () => {
    const actions = defaultAgentActions(REQUEST, "m-devbox");
    expect(
      untouchedAgents(REQUEST, "m-devbox", actions).map((a) => a.id)
    ).toEqual(["a-crm", "a-cc"]);
  });
  it("the decision sends the per-row action, and the page's mode only on adds", () => {
    const decision = approveDecision(REQUEST, "abcd-efgh", {
      agents: [],
      actions: [
        ...defaultAgentActions(REQUEST, "m-devbox"),
        {
          rowKey: "claude-code:x",
          agentType: "claude-code",
          role: null,
          roleLabel: null,
          action: "reconnect",
          agentId: "a-cc",
        },
      ],
      reuseComputerId: "m-devbox",
      computerName: "devbox",
      agentWriteMode: "pod-default",
    });
    expect(decision.agentActions).toEqual([
      {
        agentType: "claude-code",
        role: null,
        roleLabel: null,
        action: "add",
        agentId: null,
        writeMode: "pod-default",
      },
      // A reconnect keeps its own permission (D6): no writeMode sent.
      {
        agentType: "claude-code",
        role: null,
        roleLabel: null,
        action: "reconnect",
        agentId: "a-cc",
      },
    ]);
  });
  it("a pod older than 0395 (no rows) gets the old decision, no per-row field", () => {
    const old: DeviceRequest = { ...REQUEST, rows: undefined };
    const decision = approveDecision(old, "abcd-efgh", {
      agents: ["claude-code"],
      actions: defaultAgentActions(old, "m-devbox"),
      reuseComputerId: "m-devbox",
      computerName: "devbox",
    });
    expect(decision.agentActions).toBeUndefined();
    expect(decision.agents).toEqual(["claude-code"]);
  });
});
