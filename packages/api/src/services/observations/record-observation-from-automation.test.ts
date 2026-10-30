/**
 * An automation's `record_observation` step → `recordObservationFromAutomation`
 * → the ONE writer. Driven through the REAL `recordObservation` (only the
 * event store, the boss and the PR→session resolver are stubbed), so what is
 * asserted is what the pod actually appends and enqueues:
 *   - the observation door's refusals hold here too (namespace, reserved phase,
 *     reserved subject type, the dev-loop contract) and nothing is recorded;
 *   - a fact is recorded for the OWNER in the automation's workspace;
 *   - the trigger hop carries the run's chain (the cycle guard sees it) and
 *     names the owner as producer, as `emitSideEffects` names its actor;
 *   - an AGENT owner is the fact's agent: the event, the trigger hop AND the
 *     dev-loop sweep name it (the sweep runs governed as that agent); a
 *     human owner's sweep runs as the person (no agent named);
 *   - ONE FACT, ONE EVENT: the same fact recorded again (another producer,
 *     a redelivery) writes, triggers and sweeps nothing and returns the
 *     first event; a failed write gives the key back (the observation keys
 *     store is an in-memory stand-in here; its SQL is proven on PGlite in
 *     @synap/database migrations-0372.pglite.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const appended: any[] = [];
const sends: Array<[string, any]> = [];
/** The owner's `users` row the door reads (its `userType`). */
let ownerRows: Array<{ userType: string }> = [];
/** The observation keys table: key → event id (null = claimed, in flight). */
const factKeys = new Map<string, string | null>();
/** The next append throws this, once. */
let appendError: Error | null = null;

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBoss: () => ({
      send: async (queue: string, payload: any) => {
        sends.push([queue, payload]);
        return null;
      },
    }),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => ownerRows }) }),
      }),
    },
    getEventRepository: () => ({
      append: async (e: any) => {
        if (appendError) {
          const err = appendError;
          appendError = null;
          throw err;
        }
        appended.push(e);
        return { id: `row-${appended.length}` };
      },
    }),
    claimObservationKey: async (_db: unknown, key: string) => {
      if (!factKeys.has(key)) {
        factKeys.set(key, null);
        return { owned: true };
      }
      return { owned: false, eventId: factKeys.get(key) ?? null };
    },
    settleObservationKey: async (_db: unknown, key: string, id: string) => {
      factKeys.set(key, id);
    },
    releaseObservationKey: async (_db: unknown, key: string) => {
      if (factKeys.get(key) === null) factKeys.delete(key);
    },
  };
});

vi.mock("../dev-loop/pr-session-resolver.js", async () => ({
  sessionForDevLoopFact: async () => null,
}));

vi.mock("../api-keys.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    apiKeyService: new Proxy(actual.apiKeyService, {
      get: (target, prop) =>
        prop === "checkRateLimit" ? () => true : Reflect.get(target, prop),
    }),
  };
});

const { recordObservationFromAutomation } =
  await import("./record-observation-from-automation.js");

const chain = {
  automationRunId: "run-1",
  automationId: "auto-1",
  chainDepth: 1,
  rootRunId: "run-0",
  chainAutomationIds: ["auto-0", "auto-1"],
};

const record = (over: Record<string, unknown> = {}) =>
  recordObservationFromAutomation({
    type: "dev.pr_merged",
    subjectId: "Synap-core/backend#12",
    data: {
      repo: "Synap-core/backend",
      number: 12,
      url: "https://github.com/Synap-core/backend/pull/12",
      intoDefault: true,
    },
    ownerId: "owner-1",
    workspaceId: WS,
    automationContext: chain,
    ...over,
  } as never);

beforeEach(() => {
  appended.length = 0;
  sends.length = 0;
  ownerRows = [{ userType: "human" }];
  factKeys.clear();
  appendError = null;
});

describe("record_observation — the observation door's refusals", () => {
  it.each([
    ["an unregistered namespace", { type: "entity.create" }, /namespace/],
    ["a reserved phase", { type: "dev.commit.completed" }, /lifecycle phase/],
    [
      "a reserved subject type",
      { type: "dev.commit", subjectType: "focus_session" },
      /reserved/,
    ],
    [
      "a dev-loop fact off its contract",
      { data: { repo: "Synap-core/backend", number: "12" } },
      /refused: dev\.pr_merged: number/,
    ],
  ])("refuses %s and records nothing", async (_label, over, reason) => {
    await expect(record(over)).rejects.toThrow(reason);
    expect(appended).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});

describe("record_observation — recorded through the one writer", () => {
  it("records the fact for the owner in the automation's workspace", async () => {
    const { id } = await record();
    expect(id).toBe("row-1");
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: "dev.pr_merged",
      userId: "owner-1",
      workspaceId: WS,
      data: { subjectRef: "Synap-core/backend#12", number: 12 },
    });
    expect(appended[0].agentUserId).toBeUndefined();
  });

  it("the trigger hop carries the run's chain and names the owner", async () => {
    await record();
    const hop = sends.find(([q]) => q === "automation-trigger-match");
    expect(hop, "no trigger hop enqueued").toBeDefined();
    expect(hop![1]).toMatchObject({
      eventType: "dev.pr_merged",
      workspaceId: WS,
      eventId: "row-1",
      producerAgentUserId: "owner-1",
      automationContext: chain,
    });
  });
});

describe("record_observation — who the dev-loop sweep runs as", () => {
  const sweepJob = () => sends.find(([q]) => q === "dev-loop-observation");

  it("a human owner: the sweep runs as the person, no agent named", async () => {
    await record();
    expect(sweepJob(), "no dev-loop sweep enqueued").toBeDefined();
    expect(sweepJob()![1]).toMatchObject({
      userId: "owner-1",
      producerAgentUserId: null,
    });
  });

  it("an agent owner: the event, the trigger hop and the sweep all name the agent", async () => {
    ownerRows = [{ userType: "agent" }];
    await record();
    expect(appended[0].agentUserId).toBe("owner-1");
    const hop = sends.find(([q]) => q === "automation-trigger-match");
    expect(hop![1].producerAgentUserId).toBe("owner-1");
    expect(sweepJob()![1]).toMatchObject({
      userId: "owner-1",
      producerAgentUserId: "owner-1",
    });
  });
});

describe("record_observation — one fact, one event", () => {
  it("the same fact again records, triggers and sweeps nothing, and returns the first event", async () => {
    const first = await record();
    const sendsAfterFirst = sends.length;
    expect(sendsAfterFirst).toBeGreaterThan(0);

    const again = await record({
      // Another producer: a different source, the same fact in the world.
      data: {
        repo: "synap-core/BACKEND",
        number: 12,
        url: "https://github.com/Synap-core/backend/pull/12",
        intoDefault: true,
        source: "devbox-pr-gap-filler",
      },
    });
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect(appended).toHaveLength(1);
    expect(sends).toHaveLength(sendsAfterFirst);
  });

  it("another PR is another fact", async () => {
    await record();
    await record({
      subjectId: "Synap-core/backend#13",
      data: {
        repo: "Synap-core/backend",
        number: 13,
        url: "https://github.com/Synap-core/backend/pull/13",
        intoDefault: true,
      },
    });
    expect(appended).toHaveLength(2);
  });

  it("a failed write gives the key back, so the retry records the fact", async () => {
    appendError = new Error("events table unavailable");
    await expect(record()).rejects.toThrow(/unavailable/);
    expect(appended).toHaveLength(0);
    const retry = await record();
    expect(retry.duplicate).toBeUndefined();
    expect(appended).toHaveLength(1);
  });

  it("a type with no key (a free-form dev.* fact) is recorded every time", async () => {
    await record({ type: "dev.commit", data: { repo: "Synap-core/backend" } });
    await record({ type: "dev.commit", data: { repo: "Synap-core/backend" } });
    expect(appended).toHaveLength(2);
  });
});

describe("record_observation — a fact a hold may wait on", () => {
  const holdJobs = () => sends.filter(([q]) => q === "hold-resume");

  it("a merge wakes the hold-resume job with the hold's own spelling of the PR", async () => {
    await record({
      data: {
        repo: "Synap-core/Backend",
        number: 12,
        url: "https://github.com/Synap-core/backend/pull/12",
        intoDefault: true,
      },
    });
    expect(holdJobs().map(([, d]) => d)).toEqual([
      { devFact: "pr:synap-core/backend#12" },
    ]);
  });

  it("a fact no hold can wait on (a PR opened) wakes nothing", async () => {
    await record({ type: "dev.pr_opened", subjectId: "Synap-core/backend#14" });
    expect(holdJobs()).toEqual([]);
  });
});
