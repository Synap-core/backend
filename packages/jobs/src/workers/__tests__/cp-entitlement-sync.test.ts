import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * cp-entitlement-sync pulls the pod's plan (`GET /internal/plan`, CP
 * lib/pod-plan.ts — lane cp-link) and its AI availability
 * (`GET /internal/ai-availability`) from its Control Plane:
 *   - a registered pod asks with its own credential, purpose "entitlement",
 *     naming the pod id of its link, and records exactly the CP's answer;
 *   - the AI answer keeps only the availability fields (never the plan name,
 *     balance or packs), wakes the AI holds when AI came back, and tells the
 *     payers' notifier of every pull;
 *   - a failed pull records WHY and never writes an answer: unreachable,
 *     refused, an older CP (404 = unknown, once per pull), another pod;
 *   - a pod with no CP / no link writes nothing;
 *   - a tick pulls what is due: each every 15 min, the AI one on every tick
 *     while a hold waits on AI, and wakes those holds while AI is available;
 *     a failing CP is asked less often; a tick waits its pod's jitter first.
 * The writers have their own suite (database control-plane-link.pglite.test.ts).
 */

const h = vi.hoisted(() => ({
  link: null as unknown,
  authCalls: [] as unknown[],
  recorded: [] as unknown[],
  failures: [] as Array<[string, string]>,
  aiRecorded: [] as unknown[],
  aiFailures: [] as Array<[string, string]>,
  becameAvailable: false,
  planSync: null as null | {
    lastAttemptAt: string;
    outcome: string;
    failures?: number;
  },
  aiSync: null as null | {
    lastAttemptAt: string;
    outcome: string;
    failures?: number;
  },
  aiStored: undefined as unknown,
  availableAfterPull: null as string | null,
  aiHolds: [] as unknown[],
  woken: [] as number[],
  slept: [] as number[],
  notified: [] as unknown[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@synap/database", () => ({
  db: {},
  readControlPlaneLink: async () => h.link,
  podCpAuthHeaders: async (opts: unknown) => {
    h.authCalls.push(opts);
    return {
      via: "pod-jwt",
      headers: { Authorization: "Bearer pod-signed" },
      bearer: "pod-signed",
    };
  },
  recordControlPlaneEntitlement: async (plan: unknown) => {
    h.recorded.push(plan);
  },
  recordControlPlaneEntitlementFailure: async (
    outcome: string,
    message: string
  ) => {
    h.failures.push([outcome, message]);
  },
  readControlPlaneEntitlementSync: async () => h.planSync,
  readPodAiAvailability: async () => ({
    availability: h.aiStored,
    sync: h.aiSync,
  }),
  listHolds: async () => h.aiHolds,
  recordPodAiAvailability: async (answer: Record<string, unknown>) => {
    h.aiRecorded.push(answer);
    return {
      previous: undefined,
      current: { ...answer, availableSince: h.availableAfterPull },
      becameAvailable: h.becameAvailable,
      stale: false,
    };
  },
  recordPodAiAvailabilityFailure: async (outcome: string, message: string) => {
    h.aiFailures.push([outcome, message]);
  },
}));
vi.mock("../hold-resume.js", () => ({
  wakeAiHolds: async (afterSeconds = 0) => {
    h.woken.push(afterSeconds);
  },
}));
vi.mock("@synap-core/core", () => ({ createLogger: () => h.logger }));

const fetchMock = vi.fn();

import {
  CP_ENTITLEMENT_SYNC_CRON,
  CP_ENTITLEMENT_SYNC_QUEUE,
  dueAfterMs,
  handleCpEntitlementSync,
  pullJitterMs,
  pullAiAvailabilityNow,
  registerAiAvailabilityNotifier,
} from "../cp-entitlement-sync.js";

const CP = "https://cp.example.test";
const PLAN = {
  podId: "pod_lab",
  tier: "pro",
  status: "trialing",
  trialEnd: "2026-11-01T00:00:00.000Z",
  lab: false,
};
/** The CP's answer, with the fields the pod must NOT keep. */
const AI = {
  podId: "pod_lab",
  checkedAt: "2026-11-21T10:00:00.000Z",
  billing: {
    readFailed: false,
    account: { kind: "user", id: "acct_1", name: "Founder" },
    plan: "Pro",
    allowanceTokens: 1000,
    remainingTokens: 0,
    percentRemaining: 0,
    state: "empty",
    threshold: null,
    dismissKey: "billing:user:acct_1:pod_lab:2026-12-01:empty",
    resetsAt: "2026-12-01T00:00:00.000Z",
    viewerRole: "pod_owner",
    canTopUp: true,
    action: "top_up",
    actionUrl: "https://synap.live/account/credits",
    packs: [
      {
        id: "p",
        name: "10M",
        tokens: 1,
        priceCents: 1,
        currency: "EUR",
        priced: true,
      },
    ],
  },
};
const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
/** The CP's two doors; each test sets what they answer. */
let doors: { plan: () => unknown; ai: () => unknown };
const NOW = new Date("2026-11-21T10:00:00.000Z");
const ago = (min: number) =>
  new Date(NOW.getTime() - min * 60_000).toISOString();

beforeEach(() => {
  h.link = {
    podId: "pod_lab",
    url: CP,
    issuer: CP,
    since: null,
    source: "enrollment",
  };
  h.authCalls = [];
  h.recorded = [];
  h.failures = [];
  h.aiRecorded = [];
  h.aiFailures = [];
  h.becameAvailable = false;
  h.planSync = null;
  h.aiSync = null;
  h.aiStored = undefined;
  h.availableAfterPull = null;
  h.aiHolds = [];
  h.woken = [];
  h.slept = [];
  h.notified = [];
  registerAiAvailabilityNotifier(async (change) => {
    h.notified.push(change);
  });
  doors = {
    plan: () => answer(200, PLAN),
    ai: () => answer(200, AI),
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    url.startsWith(`${CP}/internal/plan`) ? doors.plan() : doors.ai()
  );
  vi.stubGlobal("fetch", fetchMock);
  process.env.CONTROL_PLANE_URL = CP;
});

const urls = () => fetchMock.mock.calls.map((c) => c[0] as string);
/** A cron tick at NOW; its jitter wait is recorded, never slept. */
const tick = () =>
  handleCpEntitlementSync({}, NOW, async (ms) => {
    h.slept.push(ms);
  });
const ok = (min: number) => ({
  lastAttemptAt: ago(min),
  outcome: "ok" as const,
  message: null,
});

describe("handleCpEntitlementSync — the plan", () => {
  it("pulls with purpose 'entitlement' for its own pod id and records the CP's answer", async () => {
    await handleCpEntitlementSync({ force: true });
    expect(h.authCalls[0]).toMatchObject({
      purpose: "entitlement",
      legacy: "internal-key",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${CP}/internal/plan?podId=pod_lab`);
    expect(init.headers).toEqual({ Authorization: "Bearer pod-signed" });
    expect(h.recorded).toEqual([
      {
        tier: "pro",
        status: "trialing",
        trialEnd: "2026-11-01T00:00:00.000Z",
        lab: false,
      },
    ]);
    expect(h.failures).toEqual([]);
  });

  it("an unreachable CP records why and writes no plan", async () => {
    doors.plan = () => {
      throw new Error("ECONNREFUSED");
    };
    await handleCpEntitlementSync({ force: true });
    expect(h.recorded).toEqual([]);
    expect(h.failures[0]![0]).toBe("unreachable");
  });

  it.each([
    [401, "refused"],
    [403, "refused"],
    [404, "unsupported"],
    [503, "unreachable"],
  ])("HTTP %i is recorded as %s, never as a plan", async (status, outcome) => {
    doors.plan = () => answer(status, { error: "x" });
    await handleCpEntitlementSync({ force: true });
    expect(h.recorded).toEqual([]);
    expect(h.failures[0]![0]).toBe(outcome);
  });

  it("an answer for another pod, or not a plan, is refused", async () => {
    doors.plan = () => answer(200, { ...PLAN, podId: "pod_other" });
    await handleCpEntitlementSync({ force: true });
    doors.plan = () => answer(200, { tier: "enterprise" });
    await handleCpEntitlementSync({ force: true });
    expect(h.recorded).toEqual([]);
    expect(h.failures.map(([o]) => o)).toEqual(["invalid", "invalid"]);
  });

  it("a pod with no CP, or no link, writes nothing and calls nobody", async () => {
    delete process.env.CONTROL_PLANE_URL;
    await handleCpEntitlementSync({ force: true });
    process.env.CONTROL_PLANE_URL = CP;
    h.link = null;
    await handleCpEntitlementSync({ force: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
    expect(h.failures).toEqual([]);
    expect(h.aiRecorded).toEqual([]);
    expect(h.aiFailures).toEqual([]);
  });

  it("a pod configured with the legacy CP_URL alone syncs too (the one CP URL reading)", async () => {
    delete process.env.CONTROL_PLANE_URL;
    process.env.CP_URL = ` ${CP}/ `;
    try {
      await handleCpEntitlementSync({ force: true });
    } finally {
      delete process.env.CP_URL;
    }
    expect(urls()[0]).toBe(`${CP}/internal/plan?podId=pod_lab`);
    expect(h.recorded).toHaveLength(1);
  });
});

describe("handleCpEntitlementSync — the AI availability", () => {
  it("keeps only the availability fields: never the account, plan, balance or packs", async () => {
    await handleCpEntitlementSync({ force: true });
    expect(urls()).toContain(`${CP}/internal/ai-availability?podId=pod_lab`);
    expect(h.aiRecorded).toEqual([
      {
        checkedAt: AI.checkedAt,
        billing: {
          readFailed: false,
          state: "empty",
          threshold: null,
          dismissKey: AI.billing.dismissKey,
          resetsAt: AI.billing.resetsAt,
          viewerRole: "pod_owner",
          canTopUp: true,
          action: "top_up",
          actionUrl: "https://synap.live/account/credits",
        },
      },
    ]);
    // Told of the pull; AI did not come back, so no hold is woken.
    expect(h.notified).toHaveLength(1);
    expect(h.woken).toEqual([]);
  });

  it("a CP from before `actionUrl` answers too; a link that is not https is refused", async () => {
    const { actionUrl: _drop, ...older } = AI.billing;
    doors.ai = () => answer(200, { ...AI, billing: older });
    await handleCpEntitlementSync({ force: true });
    expect(h.aiRecorded[0]).toMatchObject({ billing: { actionUrl: null } });
    doors.ai = () =>
      answer(200, {
        ...AI,
        billing: { ...AI.billing, actionUrl: "javascript:alert(1)" },
      });
    await handleCpEntitlementSync({ force: true });
    expect(h.aiFailures.map(([o]) => o)).toEqual(["invalid"]);
  });

  it("a billing read the CP could not make is stored as such", async () => {
    doors.ai = () =>
      answer(200, {
        ...AI,
        billing: { readFailed: true, code: "BILLING_READ_FAILED", error: "x" },
      });
    await handleCpEntitlementSync({ force: true });
    expect(h.aiRecorded[0]).toEqual({
      checkedAt: AI.checkedAt,
      billing: { readFailed: true },
    });
  });

  it("AI coming back wakes the holds that wait on it", async () => {
    h.becameAvailable = true;
    await handleCpEntitlementSync({ force: true });
    expect(h.woken).toEqual([0]);
  });

  it("a CP without the door is recorded as unsupported, the plan still pulls", async () => {
    doors.ai = () => answer(404, { error: "Not found" });
    await handleCpEntitlementSync({ force: true });
    expect(h.aiFailures.map(([o]) => o)).toEqual(["unsupported"]);
    expect(h.aiRecorded).toEqual([]);
    expect(h.recorded).toHaveLength(1);
    expect(h.notified).toEqual([]);
  });

  it("an answer for another pod is refused", async () => {
    doors.ai = () => answer(200, { ...AI, podId: "pod_other" });
    await handleCpEntitlementSync({ force: true });
    expect(h.aiRecorded).toEqual([]);
    expect(h.aiFailures.map(([o]) => o)).toEqual(["invalid"]);
  });

  it("the re-check door pulls the AI availability alone, now", async () => {
    const pulled = await pullAiAvailabilityNow(NOW);
    expect(pulled).toMatchObject({
      outcome: "ok",
      availability: { billing: { state: "empty" } },
    });
    expect(urls()).toEqual([`${CP}/internal/ai-availability?podId=pod_lab`]);
    h.link = null;
    expect(await pullAiAvailabilityNow(NOW)).toMatchObject({
      outcome: "not_linked",
    });
  });
});

describe("handleCpEntitlementSync — what a tick pulls", () => {
  it("each fact once its last attempt is 15 minutes old", async () => {
    h.planSync = ok(15);
    h.aiSync = ok(3);
    await tick();
    expect(urls()).toEqual([`${CP}/internal/plan?podId=pod_lab`]);

    fetchMock.mockClear();
    h.planSync = ok(3);
    h.aiSync = ok(15);
    await tick();
    expect(urls()).toEqual([`${CP}/internal/ai-availability?podId=pod_lab`]);
  });

  it("nothing due: no call at all", async () => {
    h.planSync = ok(3);
    h.aiSync = ok(3);
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the AI availability on every tick while a hold waits on AI", async () => {
    h.planSync = ok(3);
    h.aiSync = ok(3);
    h.aiHolds = [{ subjectType: "focus_session", subjectId: "s1" }];
    await tick();
    expect(urls()).toEqual([`${CP}/internal/ai-availability?podId=pod_lab`]);
  });

  it("a CP without the door is not asked every tick, even while a hold waits on AI", async () => {
    h.planSync = ok(3);
    h.aiSync = { lastAttemptAt: ago(3), outcome: "unsupported" };
    h.aiHolds = [{ subjectType: "focus_session", subjectId: "s1" }];
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();

    h.aiSync = { lastAttemptAt: ago(15), outcome: "unsupported" };
    await tick();
    expect(urls()).toEqual([`${CP}/internal/ai-availability?podId=pod_lab`]);
  });

  it("a tick that reads AI available wakes the AI holds again (met while true)", async () => {
    h.planSync = ok(3);
    h.aiSync = ok(3);
    h.aiHolds = [{ subjectType: "focus_session", subjectId: "s1" }];
    // Available before this tick, still available: woken again.
    h.availableAfterPull = ago(30);
    await tick();
    expect(h.woken).toEqual([0]);

    // The pull itself saw AI come back: woken once, not twice.
    h.woken = [];
    h.becameAvailable = true;
    h.availableAfterPull = NOW.toISOString();
    await tick();
    expect(h.woken).toEqual([0]);

    // Not available: no wake.
    h.woken = [];
    h.becameAvailable = false;
    h.availableAfterPull = null;
    await tick();
    expect(h.woken).toEqual([]);

    // No hold waits on AI: no wake, whatever the pull says.
    h.aiHolds = [];
    h.availableAfterPull = ago(30);
    h.aiSync = ok(15);
    await tick();
    expect(h.woken).toEqual([]);
  });

  it("a tick with nothing to pull still wakes the AI holds while the stored answer reads available", async () => {
    h.planSync = ok(3);
    h.aiSync = { lastAttemptAt: ago(3), outcome: "refused", failures: 1 };
    h.aiHolds = [{ subjectType: "focus_session", subjectId: "s1" }];
    h.aiStored = { availableSince: ago(30), checkedAt: ago(4) };
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.woken).toEqual([0]);
  });

  it("a refusing or failing CP is asked less and less often, even while a hold waits on AI", async () => {
    expect(dueAfterMs(null)).toBe(14 * 60_000);
    expect(dueAfterMs(ok(0))).toBe(14 * 60_000);
    expect(
      dueAfterMs({
        lastAttemptAt: ago(0),
        outcome: "unsupported",
        message: "404",
        failures: 5,
      })
    ).toBe(14 * 60_000);
    const failing = (failures: number) =>
      dueAfterMs({
        lastAttemptAt: ago(0),
        outcome: "unreachable",
        message: "502",
        failures,
      });
    expect([1, 2, 3, 4, 5, 9].map(failing)).toEqual(
      [1, 2, 4, 8, 16, 16].map((n) => n * 14 * 60_000)
    );

    h.planSync = ok(3);
    h.aiHolds = [{ subjectType: "focus_session", subjectId: "s1" }];
    h.aiSync = { lastAttemptAt: ago(45), outcome: "refused", failures: 3 };
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
    h.aiSync = { lastAttemptAt: ago(57), outcome: "refused", failures: 3 };
    await tick();
    expect(urls()).toEqual([`${CP}/internal/ai-availability?podId=pod_lab`]);
  });

  it("a tick waits its pod's jitter before calling; the startup run does not", async () => {
    const j = pullJitterMs("pod_lab");
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThan(60_000);
    expect(pullJitterMs("pod_lab")).toBe(j);
    expect(
      new Set(["pod_a", "pod_b", "pod_c", "pod_d"].map(pullJitterMs)).size
    ).toBeGreaterThan(1);

    h.planSync = ok(15);
    h.aiSync = ok(3);
    await tick();
    expect(h.slept).toEqual([j]);

    h.slept = [];
    h.planSync = ok(3);
    await tick();
    expect(h.slept).toEqual([]);
  });

  it("stays on its queue name and a 3-minute tick", () => {
    expect(CP_ENTITLEMENT_SYNC_QUEUE).toBe("cp-entitlement-sync");
    expect(CP_ENTITLEMENT_SYNC_CRON).toBe("*/3 * * * *");
  });
});
