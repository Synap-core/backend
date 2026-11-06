import { describe, it, expect, vi, beforeEach } from "vitest";
/**
 * The ONE turn door carries a playbook run's tool profile onto the A2AI job
 * (lean run tools, founder 2026-11-05): the kickoff and the continuation name
 * it, the worker forwards it as the IS `run`. Without this pin the door could
 * drop it while the executor and worker tests (which mock the door and the
 * transport) stay green.
 */
const sent: Array<Record<string, unknown>> = [];

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
            workspaceId: "ws-1",
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
    agentUserId: "agent-1",
  }),
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
  content: "Package the idea bank.",
  sourceUserId: "user-1",
  agentType: "meta",
  focusSessionId: "sess-1",
};

describe("triggerAutoRespond carries a run's tool profile", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("a run turn ⇒ the job carries `run` verbatim", async () => {
    const run = {
      playbookId: "pb-1",
      intents: ["publish_post"],
      verbs: ["postiz_schedule_post"],
      capabilitiesRead: "ok" as const,
    };
    expect(await triggerAutoRespond({ ...base, run })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.run).toEqual(run);
  });

  it("any other turn ⇒ no `run` key (the IS gives the normal agent)", async () => {
    expect(await triggerAutoRespond(base)).toBe(true);
    expect(sent[0]).not.toHaveProperty("run");
  });
});
