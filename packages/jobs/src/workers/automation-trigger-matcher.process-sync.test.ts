/**
 * The trigger hop hands the process engine WHO produced the event. Without the
 * producer, an agent's status write would be followed as the session owner's
 * and walk a human gate (process-sync.ts). Driven through the real
 * `handleAutomationTriggerMatch`; the process engine is the recorder.
 */

import { describe, it, expect, vi } from "vitest";

const syncCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

function thenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.where = chain;
  p.set = chain;
  p.values = chain;
  p.onConflictDoNothing = () => p;
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

vi.mock("../utils/process-sync.js", () => ({
  syncProcessOnEvent: async (ev: Record<string, unknown>) => {
    syncCalls.push(ev);
    return [];
  },
}));
vi.mock("@synap/events", () => ({ getBoss: () => ({ send: vi.fn() }) }));
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    query: {
      focusSessions: { findFirst: () => Promise.resolve(null) },
      links: { findMany: () => Promise.resolve([]) },
    },
    select: () => thenable([]),
    insert: () => thenable([]),
    update: () => thenable(undefined),
  },
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  drizzleSql: () => ({}),
}));

const { handleAutomationTriggerMatch } =
  await import("./automation-trigger-matcher.js");

describe("trigger hop → process engine", () => {
  it("passes the event's producer through", async () => {
    await handleAutomationTriggerMatch({
      data: {
        eventType: "entity.update.completed",
        subjectId: "post-1",
        userId: "owner-1",
        workspaceId: "ws-1",
        data: { changedKeys: ["post-status"], "post-status": "Published" },
        producerAgentUserId: "agent-1",
      },
    });
    expect(syncCalls).toEqual([
      expect.objectContaining({
        subjectId: "post-1",
        producerAgentUserId: "agent-1",
      }),
    ]);
  });
});
