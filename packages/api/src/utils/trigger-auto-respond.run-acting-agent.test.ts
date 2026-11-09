import { describe, it, expect, vi, beforeEach } from "vitest";
/**
 * A playbook RUN turn always acts as an AI (founder, 2026-11-09: "a run acts
 * as the AI agent used for it"). The A2AI job's `agentUserId` is what the pod
 * signs as the turn's `act.sub` and what the IS names on every write, so it
 * decides whether the run's writes are governed as an agent (the ladder,
 * proposals) or as the person (applied, no review).
 *
 * Live 2026-11-09: in Content OS no unique house agent resolved, the run turn
 * named none, and "Plan Next Content" applied `update_entities` with no
 * proposal; in Brand the same kind of run was governed as the house agent.
 *
 * Pins: a run turn takes the space's house agent when routing resolves one,
 * else the person's own Synap AI enrolled in the space (`ensureAgentUser`),
 * else (a personal run) the person's Synap AI; a turn that is not a run keeps
 * routing's answer, including none.
 */
const sent: Array<Record<string, unknown>> = [];
const h = vi.hoisted(() => ({
  house: undefined as string | undefined,
  workspaceId: "ws-1" as string | null,
  ensureAgentUser: vi.fn(async (_u: string, _w: string) => "personal-in-ws"),
  ensurePersonalAgentUser: vi.fn(async (_u: string) => "personal-pod-wide"),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        channels: {
          findFirst: async () => ({
            id: "chan-1",
            userId: "user-1",
            workspaceId: h.workspaceId,
            channelType: "run",
          }),
        },
        messages: { findFirst: async () => ({ metadata: null }) },
        focusSessions: { findFirst: async () => ({ id: "sess-1" }) },
      },
    },
  };
});
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
}));
vi.mock("../services/messaging/turn-principal.js", () => ({
  resolveTurnPrincipal: async () => ({ userId: "user-1" }),
}));
vi.mock("./intelligence-routing.js", () => ({
  resolveIntelligenceService: async () => ({
    endpoint: "http://is.local",
    serviceApiKey: "key",
    serviceId: "is-1",
    agentUserId: h.house,
  }),
}));
vi.mock("../routers/channels/helpers.js", () => ({
  ensureAgentUser: (u: string, w: string) => h.ensureAgentUser(u, w),
}));
vi.mock("./personal-agent-user.js", () => ({
  ensurePersonalAgentUser: (u: string) => h.ensurePersonalAgentUser(u),
}));
vi.mock("@synap/jobs", () => ({
  A2AI_TRIGGER_QUEUE: "a2ai",
  A2AI_TRIGGER_JOB_OPTIONS: {},
  getBoss: () => ({
    send: async (_q: string, data: Record<string, unknown>) => {
      sent.push(data);
      return "job-1";
    },
  }),
}));

const { triggerAutoRespond } = await import("./trigger-auto-respond.js");

const base = {
  channelId: "chan-1",
  userMessageId: "msg-1",
  content: "Plan next content.",
  sourceUserId: "user-1",
  agentType: "meta",
  focusSessionId: "sess-1",
};
const run = {
  playbookId: "pb-1",
  intents: [],
  verbs: [],
  capabilitiesRead: "ok" as const,
};

describe("a run turn always acts as an AI", () => {
  beforeEach(() => {
    sent.length = 0;
    h.house = undefined;
    h.workspaceId = "ws-1";
    h.ensureAgentUser.mockClear();
    h.ensurePersonalAgentUser.mockClear();
  });

  it("the space's house agent, when routing resolves exactly one", async () => {
    h.house = "house-1";
    expect(await triggerAutoRespond({ ...base, run })).toBe(true);
    expect(sent[0]!.agentUserId).toBe("house-1");
    expect(h.ensureAgentUser).not.toHaveBeenCalled();
  });

  it("no house agent in the space ⇒ the person's Synap AI, enrolled there", async () => {
    expect(await triggerAutoRespond({ ...base, run })).toBe(true);
    expect(h.ensureAgentUser).toHaveBeenCalledWith("user-1", "ws-1");
    expect(sent[0]!.agentUserId).toBe("personal-in-ws");
  });

  it("a personal run (no space) ⇒ the person's Synap AI", async () => {
    h.workspaceId = null;
    expect(await triggerAutoRespond({ ...base, run })).toBe(true);
    expect(h.ensurePersonalAgentUser).toHaveBeenCalledWith("user-1");
    expect(h.ensureAgentUser).not.toHaveBeenCalled();
    expect(sent[0]!.agentUserId).toBe("personal-pod-wide");
  });

  it("a turn that is not a run keeps routing's answer, none included", async () => {
    expect(await triggerAutoRespond(base)).toBe(true);
    expect(sent[0]!.agentUserId).toBeUndefined();
    expect(h.ensureAgentUser).not.toHaveBeenCalled();
    expect(h.ensurePersonalAgentUser).not.toHaveBeenCalled();
  });
});
