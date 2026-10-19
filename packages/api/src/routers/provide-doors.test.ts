/**
 * The two provide doors' own refusals, through the real procedures:
 *
 *   - `focusSessions.provideOptions` — the person's sheet: never an agent key,
 *     and the answer door's refusal words for a slot it would not take.
 *   - `connectors.session` with `answerFor` (connect-and-answer) — a person who
 *     owns the owed slot, an ask for a connection, an integration that IS the
 *     asked service; only then is the session started (pinned to that
 *     integration) and the intent recorded. A refused call starts nothing and
 *     records nothing.
 *
 * The services behind them are pinned by
 * `services/focus-sessions/__tests__/provide-answer.pglite.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  owed: null as unknown,
  keyDenied: false,
  integrations: [] as Array<{
    uniqueKey: string;
    provider: string;
    displayName: string;
  }>,
  sessions: [] as Array<{ userId: string; provider: string }>,
  intents: [] as Array<Record<string, unknown>>,
  createFails: false,
}));

vi.mock("../services/focus-sessions/provide-options.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadOwedProvideAsk: async () => h.owed,
  readProvideOptions: async () => ({ kind: "file" }),
}));
vi.mock("../services/focus-sessions/provide-connect.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordProvideConnectIntent: async (p: Record<string, unknown>) => {
    h.intents.push(p);
    return p;
  },
}));
vi.mock("../utils/assert-key-may-write.js", () => ({
  assertKeyMayWrite: async () => {
    if (h.keyDenied) {
      const { TRPCError } = await import("@trpc/server");
      throw new TRPCError({ code: "FORBIDDEN", message: "key" });
    }
  },
}));
vi.mock("../connectors/index.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveBroker: async () => ({
    ok: true,
    broker: {
      mode: "local",
      listIntegrationsResult: async () => ({
        ok: true,
        integrations: h.integrations,
      }),
      createSession: async (userId: string, provider: string) => {
        if (h.createFails) throw new Error("broker down");
        h.sessions.push({ userId, provider });
        return { sessionToken: "tok", redirectUrl: "https://connect.test/x" };
      },
      getConnectUrl: () => "https://connect.test",
    },
  }),
}));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { connectorsRouter } from "./connectors-trpc.js";
import { focusSessionsRouter } from "./focus-sessions.js";
import type { Context } from "../types/context.js";

const SESSION = "0b9f3c1e-6c55-4a43-9a43-2f8a2b7f1c11";
const ctxFor = (agentUserId?: string) =>
  ({
    authenticated: true,
    userId: "person-1",
    ...(agentUserId ? { agentUserId } : {}),
  }) as unknown as Context;
const owedConnection = (service = "gmail") => ({
  session: { id: SESSION, workspaceId: "ws", projectId: null },
  expectedLabel: "Mail account",
  provide: { kind: "connection", service },
  askFingerprint: "fp1",
});
const answerFor = {
  sessionId: SESSION,
  expectedLabel: "mail account",
  askFingerprint: "fp1",
};
// A workspace is named so the door never falls back to reading one.
const session = (input: Record<string, unknown>, agentUserId?: string) =>
  connectorsRouter
    .createCaller(ctxFor(agentUserId))
    .session({ workspaceId: "ws-1", ...input } as never);

beforeEach(() => {
  h.owed = owedConnection();
  h.keyDenied = false;
  h.integrations = [
    { uniqueKey: "google-mail", provider: "google-mail", displayName: "Gmail" },
  ];
  h.sessions.length = 0;
  h.intents.length = 0;
  h.createFails = false;
});

describe("focusSessions.provideOptions", () => {
  const read = (agentUserId?: string) =>
    focusSessionsRouter
      .createCaller(ctxFor(agentUserId))
      .provideOptions({ sessionId: SESSION, expectedLabel: "Mail account" });

  it("an agent key never reads the person's sheet", async () => {
    await expect(read("agent-1")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("someone else's session reads as not found; a re-asked one as ask_changed", async () => {
    h.owed = { status: "not_found" };
    await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.owed = { status: "ask_changed" };
    await expect(read()).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/^ask_changed:/),
    });
  });

  it("the person reads it", async () => {
    await expect(read()).resolves.toEqual({ kind: "file" });
  });
});

describe("connectors.session with answerFor", () => {
  it("starts a session pinned to the asked service and records the intent", async () => {
    const r = await session({ answerFor });
    expect(h.sessions).toEqual([
      { userId: "person-1", provider: "google-mail" },
    ]);
    expect(h.intents).toEqual([
      {
        sessionId: SESSION,
        userId: "person-1",
        label: "Mail account",
        provider: "google-mail",
        askFingerprint: "fp1",
      },
    ]);
    expect(r).toMatchObject({
      token: "tok",
      answerFor: {
        sessionId: SESSION,
        expectedLabel: "Mail account",
        providerId: "google-mail",
      },
    });
  });

  it.each([
    ["an agent key", { agent: "agent-1" }, "FORBIDDEN"],
    ["a key without session writes", { keyDenied: true }, "FORBIDDEN"],
    ["someone else's session", { owed: { status: "not_found" } }, "NOT_FOUND"],
    ["a re-asked slot", { owed: { status: "ask_changed" } }, "CONFLICT"],
    [
      "an ask for a secret",
      {
        owed: {
          ...owedConnection(),
          provide: { kind: "secret", name: "Stripe key" },
        },
      },
      "BAD_REQUEST",
    ],
    [
      "a service this pod does not offer",
      { owed: owedConnection("notion") },
      "PRECONDITION_FAILED",
    ],
    [
      "a provider other than the asked service",
      { providerId: "slack" },
      "BAD_REQUEST",
    ],
  ] as const)(
    "refuses %s, starting and recording nothing",
    async (_c, setup, code) => {
      const s = setup as {
        agent?: string;
        keyDenied?: boolean;
        owed?: unknown;
        providerId?: string;
      };
      if (s.keyDenied) h.keyDenied = true;
      if (s.owed) h.owed = s.owed;
      await expect(
        session(
          { answerFor, ...(s.providerId ? { providerId: s.providerId } : {}) },
          s.agent
        )
      ).rejects.toMatchObject({ code });
      expect(h.sessions).toEqual([]);
      expect(h.intents).toEqual([]);
    }
  );

  it("a session the broker could not start records no intent", async () => {
    h.createFails = true;
    await expect(session({ answerFor })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(h.intents).toEqual([]);
  });

  it("without answerFor nothing changes: no slot read, no intent", async () => {
    h.owed = { status: "not_found" };
    await expect(session({ providerId: "google-mail" })).resolves.toMatchObject(
      { token: "tok" }
    );
    expect(h.intents).toEqual([]);
  });
});
