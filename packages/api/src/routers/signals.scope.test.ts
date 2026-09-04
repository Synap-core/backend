/**
 * `signals.list` / `signals.count` — CONTAINER SCOPE FORWARDING.
 *
 * The signals router owns no access logic: it calls `proposals.groups`,
 * `notifCenter.list` and `events.read` through their own routers, and the one
 * query it does own (`listDecidedProposals`) goes through the SAME predicate
 * builder the proposals queue uses. So the thing that can actually break when a
 * scope is added is not a predicate — it is a scope silently NOT being
 * forwarded, which yields a pod-wide list wearing a container's label. That is
 * the exact "declared input with no reader" severance this repo keeps paying
 * for, and it is what these tests pin.
 *
 * DB-FREE: every downstream door is mocked at its module boundary (partial
 * mocks via `importOriginal`, so the real `ProposalStatus` / drizzle helpers
 * still resolve) and the assertions read the FORWARDED INPUT.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const groupsSpy = vi.fn();
const notifListSpy = vi.fn();
const eventsReadSpy = vi.fn();
const scopeConditionsSpy = vi.fn();
const resolveAutomationStepRunIdsSpy = vi.fn();

vi.mock("./proposals.js", () => ({
  proposalsRouter: { createCaller: () => ({ groups: groupsSpy }) },
}));

vi.mock("./notif-center.js", () => ({
  notifCenterRouter: { createCaller: () => ({ list: notifListSpy }) },
}));

vi.mock("./events.js", () => ({
  eventsRouter: { createCaller: () => ({ read: eventsReadSpy }) },
}));

vi.mock("./proposals/scope-conditions.js", () => ({
  buildProposalScopeConditions: (...args: unknown[]) => {
    scopeConditionsSpy(...args);
    return [];
  },
  resolveAutomationStepRunIds: (...args: unknown[]) => {
    resolveAutomationStepRunIdsSpy(...args);
    return Promise.resolve([]);
  },
}));

// Partial mock: keep every real export (ProposalStatus, the drizzle operators
// the router composes with) and replace ONLY the connection. A total
// `() => ({})` here would silently kill every other import in this module the
// moment the router grows one — the documented failure mode.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
  };
  return { ...actual, db: chain };
});

const { signalsRouter } = await import("./signals.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => signalsRouter.createCaller(ctx);

beforeEach(() => {
  vi.clearAllMocks();
  groupsSpy.mockResolvedValue({
    groups: [],
    distinct: 0,
    scanTruncated: false,
  });
  notifListSpy.mockResolvedValue({ notifications: [] });
  eventsReadSpy.mockResolvedValue([]);
});

describe("signals.list — needs-you lens forwards the container scope", () => {
  it("forwards sessionId / projectId / automationId to proposals.groups", async () => {
    await caller().list({
      lens: "needs-you",
      sessionId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      automationId: "33333333-3333-4333-8333-333333333333",
    });

    expect(groupsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        automationId: "33333333-3333-4333-8333-333333333333",
        status: "pending",
      })
    );
  });

  it("EXCLUDES the notification half under a container scope", async () => {
    await caller().list({
      lens: "needs-you",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    // A scoped needs-you is proposals-only: `notifications` carries no
    // session/project/automation column, so including it would mix this
    // container's proposals with every unread notification in the pod.
    expect(notifListSpy).not.toHaveBeenCalled();
  });

  it("KEEPS the notification half when only the workspace lens is used", async () => {
    await caller().list({ lens: "needs-you", workspaceId: "ws-1" });
    expect(notifListSpy).toHaveBeenCalledTimes(1);
    expect(groupsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" })
    );
  });

  it("keeps the pod-wide call byte-identical to before the widening", async () => {
    await caller().list({ lens: "needs-you" });
    expect(notifListSpy).toHaveBeenCalledTimes(1);
    const [arg] = groupsSpy.mock.calls[0] as [Record<string, unknown>];
    expect(arg.sessionId).toBeUndefined();
    expect(arg.projectId).toBeUndefined();
    expect(arg.automationId).toBeUndefined();
  });
});

describe("signals.list — history lens forwards the container scope", () => {
  it("forwards sessionId to events.read (the first reader of events.session_id)", async () => {
    await caller().list({
      lens: "history",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(eventsReadSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "11111111-1111-4111-8111-111111111111",
      })
    );
  });

  it("forwards the whole scope to the shared proposal predicate builder", async () => {
    await caller().list({
      lens: "history",
      workspaceId: "ws-1",
      sessionId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
    });
    expect(scopeConditionsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        sessionId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
      }),
      "user-1"
    );
  });

  it("walks automationId through step runs (proposals carries no automationId column)", async () => {
    await caller().list({
      lens: "history",
      automationId: "33333333-3333-4333-8333-333333333333",
    });
    expect(resolveAutomationStepRunIdsSpy).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333"
    );
  });

  it("SUPPRESSES the events half under a project scope rather than returning it unnarrowed", async () => {
    await caller().list({
      lens: "history",
      projectId: "22222222-2222-4222-8222-222222222222",
    });
    // `events` has no `project_id` column. A pod-wide event feed rendered
    // beside a project-narrowed proposals feed would misreport both.
    expect(eventsReadSpy).not.toHaveBeenCalled();
  });

  it("still reads events under a plain workspace lens", async () => {
    await caller().list({ lens: "history", workspaceId: "ws-1" });
    expect(eventsReadSpy).toHaveBeenCalledTimes(1);
  });
});

describe("signals.count — same scope, same proposals-only rule", () => {
  it("forwards the container scope and drops the notification half", async () => {
    await caller().count({
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(groupsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "11111111-1111-4111-8111-111111111111",
      })
    );
    expect(notifListSpy).not.toHaveBeenCalled();
  });

  it("is unchanged for the pod-wide badge (AttentionBand / useNeedsYouCount)", async () => {
    await caller().count();
    expect(notifListSpy).toHaveBeenCalledTimes(1);
    const [arg] = groupsSpy.mock.calls[0] as [Record<string, unknown>];
    expect(arg).toEqual(
      expect.objectContaining({ status: "pending", workspaceId: undefined })
    );
  });
});
