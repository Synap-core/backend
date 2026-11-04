/**
 * G7b pod-side: the owner hears that the host's self-heal restarted a service
 * (news) or gave up on one (an ask), once, with why — through
 * NotificationService.create.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
}));
vi.mock("../NotificationService.js", () => ({
  NotificationService: { create: vi.fn() },
}));
vi.mock("../../services/capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: vi.fn(),
}));

const {
  notifyPodHealEvents,
  describePodHealEvent,
  selectPodHealNotices,
  HEAL_NOTICE_LOOKBACK_MS,
  POD_SERVICE_RESTARTED_NOTIFICATION_TYPE,
  POD_SERVICE_HEAL_EXHAUSTED_NOTIFICATION_TYPE,
} = await import("../pod-heal-notice.js");
const { getNotificationDef, needsYouRole } = await import("../registry.js");
type PodHealEvent = import("../pod-heal-notice.js").PodHealEvent;

const NOW = new Date("2026-11-03T12:00:00Z");
const at = (minAgo: number) =>
  new Date(NOW.getTime() - minAgo * 60_000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");

function ev(over: Partial<PodHealEvent> = {}): PodHealEvent {
  return {
    ts: at(5),
    status: "restarted",
    service: "backend",
    restartsInWindow: 1,
    class: "stuck",
    waitedTicks: 2,
    stall: {
      blockedMs: 95_000,
      method: "GET",
      path: "/api/hub/documents/doc-1/content",
    },
    ...over,
  };
}

function fakeDeps(admins: string[], watermark: string | null = null) {
  const created: Array<Record<string, unknown>> = [];
  const state = { watermark, writes: 0, failOn: null as string | null };
  return {
    created,
    state,
    deps: {
      recipients: async () => admins,
      readWatermark: async () => state.watermark,
      writeWatermark: async (ts: string) => {
        state.watermark = ts;
        state.writes++;
      },
      create: async (input: { userId: string }) => {
        if (state.failOn && input.userId === state.failOn)
          throw new Error("db down");
        created.push(input as unknown as Record<string, unknown>);
        return `n-${created.length}`;
      },
      now: () => NOW,
    },
  };
}

describe("the registry rows", () => {
  it("a restart is news (informational, expires); a spent budget is an ask (counts, never expires)", () => {
    const r = getNotificationDef(POD_SERVICE_RESTARTED_NOTIFICATION_TYPE);
    const x = getNotificationDef(POD_SERVICE_HEAL_EXHAUSTED_NOTIFICATION_TYPE);
    expect(needsYouRole(POD_SERVICE_RESTARTED_NOTIFICATION_TYPE)).toBe(
      "informational"
    );
    expect(r?.expiresAfterMs).toBeGreaterThan(0);
    expect(r?.dedupeWindowMs).toBe(30 * 60 * 1000);
    expect(needsYouRole(POD_SERVICE_HEAL_EXHAUSTED_NOTIFICATION_TYPE)).toBe(
      "item"
    );
    expect(x?.expiresAfterMs).toBeUndefined();
    expect(x?.dedupeWindowMs).toBeGreaterThan(0);
    expect(r?.titleTemplate).toContain("{{service}}");
    expect(x?.bodyTemplate).toBe("{{detail}}");
  });
});

describe("describePodHealEvent", () => {
  it("a stuck restart says it was running, how long the pod waited, and what blocked it", () => {
    const d = describePodHealEvent(ev());
    expect(d?.type).toBe(POD_SERVICE_RESTARTED_NOTIFICATION_TYPE);
    expect(d?.detail).toBe(
      "It was running but had stopped answering in time. The pod waited 2 more checks first, in case it recovered on its own. Its last stall blocked it for 95 s, during GET /api/hub/documents/doc-1/content. If it happens again, run `synap doctor` on the pod host."
    );
  });
  it("a dead restart and an unknown one say so, and never invent a stall", () => {
    expect(
      describePodHealEvent(ev({ class: "dead", stall: null }))?.detail
    ).toBe(
      "It had stopped answering: nothing was listening. If it happens again, run `synap doctor` on the pod host."
    );
    expect(
      describePodHealEvent(ev({ class: null, stall: null }))?.detail
    ).toMatch(/^Docker reported it unhealthy\. If/);
  });
  it("a spent budget is the ask, with the count", () => {
    const d = describePodHealEvent(
      ev({ status: "budget_exhausted", restartsInWindow: 3, stall: null })
    );
    expect(d?.type).toBe(POD_SERVICE_HEAL_EXHAUSTED_NOTIFICATION_TYPE);
    expect(d?.detail).toBe(
      "The pod restarted it 3 times in 30 minutes and it is still unhealthy, so it stopped restarting it. Run `synap doctor` on the pod host."
    );
  });
  it("waiting, recovering, alerting and failed restarts tell nobody", () => {
    for (const status of [
      "stuck_waiting",
      "recovered",
      "alert",
      "restart_failed",
      "kratos_config_restored",
    ]) {
      expect(describePodHealEvent(ev({ status }))).toBeNull();
    }
  });
});

describe("selectPodHealNotices", () => {
  it("three restarts read together are ONE notice, the newest", () => {
    const out = selectPodHealNotices(
      [
        ev({ ts: at(20), class: "dead" }),
        ev({ ts: at(10) }),
        ev({ ts: at(15), class: "dead" }),
      ],
      null,
      NOW
    );
    expect(out).toHaveLength(1);
    expect(out[0].event.ts).toBe(at(10));
  });
  it("a restart and a spent budget of one service are two notices; another service is its own", () => {
    const out = selectPodHealNotices(
      [
        ev(),
        ev({ status: "budget_exhausted", ts: at(2) }),
        ev({ service: "realtime" }),
      ],
      null,
      NOW
    );
    expect(out.map((n) => `${n.event.service}|${n.type}`).sort()).toEqual([
      `backend|${POD_SERVICE_HEAL_EXHAUSTED_NOTIFICATION_TYPE}`,
      `backend|${POD_SERVICE_RESTARTED_NOTIFICATION_TYPE}`,
      `realtime|${POD_SERVICE_RESTARTED_NOTIFICATION_TYPE}`,
    ]);
  });
  it("skips what the watermark already handled, and with none, what is older than the lookback", () => {
    expect(
      selectPodHealNotices([ev({ ts: at(10) })], at(10), NOW)
    ).toHaveLength(0);
    expect(selectPodHealNotices([ev({ ts: at(9) })], at(10), NOW)).toHaveLength(
      1
    );
    const old = at(HEAL_NOTICE_LOOKBACK_MS / 60_000 + 1);
    expect(selectPodHealNotices([ev({ ts: old })], null, NOW)).toHaveLength(0);
  });
});

describe("notifyPodHealEvents", () => {
  it("tells every admin once, pod-wide, grouped per service, and moves the watermark", async () => {
    const f = fakeDeps(["owner", "admin"]);
    const events = [
      ev({ ts: at(10) }),
      ev({ ts: at(4) }),
      ev({ status: "stuck_waiting", ts: at(1) }),
    ];
    expect(await notifyPodHealEvents(events, f.deps)).toBe(2);
    expect(f.created.map((c) => c.userId)).toEqual(["owner", "admin"]);
    expect(f.created[0]).toMatchObject({
      type: POD_SERVICE_RESTARTED_NOTIFICATION_TYPE,
      workspaceId: null,
      sourceType: "system",
      sourceId: `pod-heal:backend:${at(4)}`,
      groupKey: "pod-heal:backend",
      data: { service: "backend", status: "restarted", class: "stuck" },
    });
    // the newest line read, even one that tells nobody
    expect(f.state.watermark).toBe(at(1));
    // the same file read again: nothing new
    expect(await notifyPodHealEvents(events, f.deps)).toBe(0);
    expect(f.created).toHaveLength(2);
    expect(f.state.writes).toBe(1);
  });
  it("a failed send keeps the watermark, so the next read retries it", async () => {
    const f = fakeDeps(["owner", "admin"]);
    f.state.failOn = "admin";
    expect(await notifyPodHealEvents([ev()], f.deps)).toBe(1);
    expect(f.state.watermark).toBeNull();
    f.state.failOn = null;
    expect(await notifyPodHealEvents([ev()], f.deps)).toBe(2);
    expect(f.state.watermark).toBe(ev().ts);
  });
  it("a failed watermark read notifies nobody and never throws", async () => {
    const f = fakeDeps(["owner"]);
    f.deps.readWatermark = async () => {
      throw new Error("pod_settings unreadable");
    };
    expect(await notifyPodHealEvents([ev()], f.deps)).toBe(0);
    expect(f.created).toHaveLength(0);
  });
});
