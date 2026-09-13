/**
 * A sync-origin event does NOT open an automation run
 * unless the automation opted in with `triggerConfig.includeSyncOrigin: true`.
 *
 * Driven through `handleAutomationTriggerMatch` (the real match loop → the real
 * run-creation door), asserting whether `automation-execute` was enqueued — not
 * just the predicate's shape. Mock harness mirrors the webhook test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn();

let selectResults: Array<Array<Record<string, unknown>>> = [];
let selectCall = 0;

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.where = chain;
  p.set = chain;
  p.values = (v: unknown) => {
    insertValues(v);
    return p;
  };
  p.onConflictDoNothing = () => p;
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

vi.mock("@synap/events", () => ({
  getBoss: () => ({ send: bossSend }),
}));

vi.mock("@synap-core/core", () => ({
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
    select: () => {
      const result = selectResults[selectCall] ?? [];
      selectCall += 1;
      return makeThenable(result);
    },
    insert: () => makeThenable([{ id: "run-1" }]),
    update: () => makeThenable(undefined),
  },
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  drizzleSql: () => ({}),
  automations: { id: "id", workspaceId: "workspace_id", runCount: 0 },
  automationRuns: {},
  automationClaims: { id: "id" },
  playbookAutomations: {},
  workspaceMembers: {},
  workspaces: {},
}));

const { handleAutomationTriggerMatch, shouldSkipSyncOrigin } =
  await import("./automation-trigger-matcher.js");

const EVENT = {
  eventType: "entity.create.completed",
  subjectId: "ent-1",
  userId: "owner-1",
  workspaceId: "ws-1",
  data: { profileSlug: "person", source: "linkedin" },
};

function automation(triggerConfig: Record<string, unknown>) {
  return {
    id: "auto-1",
    workspaceId: "ws-1",
    metadata: {},
    triggerConfig: {
      eventPattern: "entity.create.completed",
      ...triggerConfig,
    },
  };
}

function executeEnqueued(): boolean {
  return bossSend.mock.calls.some((c) => c[0] === "automation-execute");
}

beforeEach(() => {
  bossSend.mockClear();
  insertValues.mockClear();
  selectCall = 0;
  selectResults = [];
});

describe("automation matcher — origin: 'sync'", () => {
  it("skips an event automation for a sync-origin event (no run, no dispatch)", async () => {
    selectResults = [[automation({})]];
    await handleAutomationTriggerMatch({ data: { ...EVENT, origin: "sync" } });
    expect(executeEnqueued()).toBe(false);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("fires an automation that opted in with includeSyncOrigin: true", async () => {
    selectResults = [[automation({ includeSyncOrigin: true })]];
    await handleAutomationTriggerMatch({ data: { ...EVENT, origin: "sync" } });
    expect(executeEnqueued()).toBe(true);
  });

  it("an ordinary (non-sync) event still fires the same automation", async () => {
    selectResults = [[automation({})]];
    await handleAutomationTriggerMatch({ data: { ...EVENT } });
    expect(executeEnqueued()).toBe(true);
  });

  it("the predicate: only an explicit true opts in", () => {
    expect(shouldSkipSyncOrigin("sync", {})).toBe(true);
    expect(shouldSkipSyncOrigin("sync", null)).toBe(true);
    expect(
      shouldSkipSyncOrigin("sync", {
        includeSyncOrigin: "true" as unknown as boolean,
      })
    ).toBe(true);
    expect(shouldSkipSyncOrigin("sync", { includeSyncOrigin: true })).toBe(
      false
    );
    expect(shouldSkipSyncOrigin(undefined, {})).toBe(false);
  });
});
