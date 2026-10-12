/**
 * Seam test — a stage worker's irreversible-send CEILING at the two send
 * doors (work model L4, FB2 item 3). Real door code + the real
 * `refuseWorkerSendPastCeiling`; only the three database counts, the
 * connector and the audit sink are stubbed. The sends that go out are owner
 * sends (no capability gate): the ceiling keys on the SESSION, not the actor.
 *
 * Rows rule out:
 *   - a ceiling checked only at run start (a send inside the run goes out);
 *   - an approval replay counting its OWN pending proposal (49 sent + pending
 *     would refuse every replay once anything is queued);
 *   - an approval replay never re-checked (50 sent, still sent);
 *   - a read-method provider call counted as a send;
 *   - a send outside any session read as a worker's;
 *   - the audit row missing the session, so an auto-executed send is never
 *     counted (backend addendum b).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  automationOf: null as string | null,
  sent: 0,
  pending: 0,
  reads: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
}));
const sendMessage = vi.fn(async () => undefined);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    workerAutomationOfSession: async () => {
      h.reads.push("automationOf");
      return h.automationOf;
    },
    countWorkerIrreversibleSentToday: async () => {
      h.reads.push("sent");
      return h.sent;
    },
    countWorkerIrreversibleSendsToday: async () => {
      h.reads.push("sends");
      return h.sent + h.pending;
    },
    db: {
      query: { channels: { findFirst: async () => null } },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
            then: (resolve: (v: unknown) => unknown) => resolve([]),
          }),
        }),
      }),
    },
  };
});

vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => ({ sendMessage }),
}));

vi.mock("../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: async (opts: Record<string, unknown>) => {
    h.audits.push(opts);
    return null;
  },
}));

const { sendExternalMessage, triggerProviderAction, EXTERNAL_DISPATCH_SOURCE } =
  await import("./external-dispatch.js");
const { WORKER_SEND_EVENT_SOURCE } = await import("@synap/database");

const SEND = {
  threadId: "t-1",
  accountId: "",
  body: "hello",
  userId: "owner-1",
  workspaceId: "ws-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  h.automationOf = "auto-1";
  h.sent = 0;
  h.pending = 0;
  h.reads.length = 0;
  h.audits.length = 0;
  sendMessage.mockClear();
});

it("the database counts the source the audit rows are written with", () => {
  expect(WORKER_SEND_EVENT_SOURCE).toBe(EXTERNAL_DISPATCH_SOURCE);
});

describe("sendExternalMessage — worker ceiling", () => {
  it("an agent send inside a worker session past sent+pending is not made", async () => {
    h.sent = 40;
    h.pending = 10;
    const out = await sendExternalMessage({ ...SEND, agentUserId: "agent-1" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/^Not sent: this worker reached today's limit/);
    expect(out.errorClass).toBe("transient");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("under the ceiling it sends, and the audit row carries the session", async () => {
    h.sent = 40;
    h.pending = 9;
    const out = await sendExternalMessage(SEND);
    expect(out.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ sessionId: SEND.sessionId });
  });

  it("an approval replay counts what was SENT, not its own pending proposal", async () => {
    h.sent = 49;
    h.pending = 30;
    const out = await sendExternalMessage({ ...SEND, alreadyApproved: true });
    expect(out.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(h.reads).toContain("sent");
    expect(h.reads).not.toContain("sends");
  });

  it("an approval replay at the ceiling is not sent, even though approved", async () => {
    h.sent = 50;
    const out = await sendExternalMessage({ ...SEND, alreadyApproved: true });
    expect(out.success).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("a session that is not a worker's is never refused", async () => {
    h.automationOf = null;
    h.sent = 500;
    const out = await sendExternalMessage(SEND);
    expect(out.success).toBe(true);
  });

  it("a send with no session reads nothing", async () => {
    h.sent = 500;
    const out = await sendExternalMessage({ ...SEND, sessionId: undefined });
    expect(out.success).toBe(true);
    expect(h.reads).toEqual([]);
  });
});

describe("triggerProviderAction — worker ceiling", () => {
  const CALL = {
    userId: "owner-1",
    provider: "nango://gmail",
    path: "/send",
    workspaceId: "ws-1",
    sessionId: SEND.sessionId,
    agentUserId: "agent-1",
  };

  it("a write past the ceiling is refused before the tool is even resolved", async () => {
    h.sent = 50;
    const out = await triggerProviderAction({ ...CALL, method: "POST" });
    expect(out.success).toBe(false);
    expect(out.status).toBe(429);
    expect(out.error).toMatch(/^Not sent/);
  });

  it("a read is never counted or refused", async () => {
    h.sent = 50;
    const out = await triggerProviderAction({ ...CALL, method: "GET" });
    expect(out.error ?? "").not.toMatch(/^Not sent/);
    expect(h.reads).toEqual([]);
  });
});
