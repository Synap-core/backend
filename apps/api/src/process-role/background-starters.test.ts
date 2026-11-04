/**
 * The role switch (plan P6): which starters each SYNAP_PROCESS_ROLE runs.
 *
 *   all    = exactly what one process started before the split, in its order;
 *   api    = no pg-boss worker, no cron clock, no boot one-shot that notifies;
 *   worker = no startup hook, no request-side LISTEN, no sign-in probe.
 *
 * The pg-boss starters are RUN (with @synap/jobs replaced by spies), so "api
 * starts no workers" is read from the doors it called, not from a key list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const jobs = vi.hoisted(() => ({
  startBoss: vi.fn(async () => undefined),
  createAllQueues: vi.fn(async () => undefined),
  registerAllWorkers: vi.fn(async () => undefined),
  registerCronSchedules: vi.fn(async () => undefined),
  startLocalSyncDriver: vi.fn(),
}));
vi.mock("@synap/jobs", () => jobs);

import {
  BACKGROUND_STARTERS,
  startBackground,
  startersFor,
  type BackgroundStarter,
  type StarterContext,
} from "./background-starters.js";
import type { ProcessRole } from "@synap/jobs";

const keys = (role: ProcessRole, phase: "boot" | "listening") =>
  startersFor(role, phase).map((s) => s.key);

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const ctxFor = (role: ProcessRole, localMode = false): StarterContext => ({
  role,
  localMode,
  log: quietLog,
  boss: { started: false },
});
const starter = (key: string) => {
  const s = BACKGROUND_STARTERS.find((x) => x.key === key);
  if (!s) throw new Error(`no starter ${key}`);
  return s;
};

afterEach(() => {
  for (const f of Object.values(jobs)) f.mockClear();
});

describe("all = the one process as it ran before the split", () => {
  it("boot phase: what index.ts started after serve(), in order", () => {
    expect(keys("all", "boot")).toEqual([
      "event-loop-watch",
      "kratos-cors-probe",
      "control-plane-issuer-probe",
      "startup-hooks",
      "skill-runtime-warm",
      "document-title-backfill",
      "retire-unasked-decision-asks",
      "session-changed-listener",
    ]);
  });

  it("listening phase: the serve() callback, in order", () => {
    expect(keys("all", "listening")).toEqual([
      "side-effect-reactors",
      "local-sync-driver",
      "pg-boss-workers",
      "jobs-ioc-slots",
      "boot-one-shots",
      "cron-schedules",
      "media-backfills",
    ]);
  });

  it("runs no starter that exists only for a split pod", () => {
    const all = new Set([...keys("all", "boot"), ...keys("all", "listening")]);
    expect(all.has("pg-boss-send")).toBe(false);
    expect(all.has("event-stream-relay-listener")).toBe(false);
  });
});

describe("api: the request side, no background work", () => {
  const api = () => [...keys("api", "boot"), ...keys("api", "listening")];

  it("starts no pg-boss worker, cron clock or boot one-shot", () => {
    for (const k of [
      "pg-boss-workers",
      "cron-schedules",
      "boot-one-shots",
      "local-sync-driver",
    ]) {
      expect(api(), k).not.toContain(k);
    }
  });

  it("sends jobs, runs the startup hooks and relays the worker's events", () => {
    for (const k of [
      "pg-boss-send",
      "startup-hooks",
      "session-changed-listener",
      "event-stream-relay-listener",
      "side-effect-reactors",
      "jobs-ioc-slots",
    ]) {
      expect(api(), k).toContain(k);
    }
  });

  it("its pg-boss starter starts pg-boss and creates the queues, and works none", async () => {
    const ctx = ctxFor("api");
    await startBackground(ctx, "listening", [starter("pg-boss-send")]);
    expect(jobs.startBoss).toHaveBeenCalledTimes(1);
    expect(jobs.createAllQueues).toHaveBeenCalledTimes(1);
    expect(jobs.registerAllWorkers).not.toHaveBeenCalled();
    expect(jobs.registerCronSchedules).not.toHaveBeenCalled();
    expect(ctx.boss.started).toBe(true);
  });
});

describe("worker: the background side, no request side", () => {
  const worker = () => [
    ...keys("worker", "boot"),
    ...keys("worker", "listening"),
  ];

  it("starts no startup hook, request-side LISTEN, probe or hook-bound backfill", () => {
    for (const k of [
      "startup-hooks",
      "session-changed-listener",
      "event-stream-relay-listener",
      "kratos-cors-probe",
      "control-plane-issuer-probe",
      "document-title-backfill",
      "retire-unasked-decision-asks",
      "media-backfills",
      "pg-boss-send",
    ]) {
      expect(worker(), k).not.toContain(k);
    }
  });

  it("works the jobs: pg-boss workers, crons, one-shots, reactors", () => {
    for (const k of [
      "pg-boss-workers",
      "cron-schedules",
      "boot-one-shots",
      "side-effect-reactors",
      "jobs-ioc-slots",
      "event-loop-watch",
    ]) {
      expect(worker(), k).toContain(k);
    }
  });

  it("its pg-boss starter registers the workers, then the crons follow", async () => {
    const ctx = ctxFor("worker");
    await startBackground(ctx, "listening", [
      starter("pg-boss-workers"),
      starter("cron-schedules"),
    ]);
    expect(jobs.startBoss).toHaveBeenCalledTimes(1);
    expect(jobs.registerAllWorkers).toHaveBeenCalledTimes(1);
    expect(jobs.registerCronSchedules).toHaveBeenCalledTimes(1);
    expect(ctx.boss.started).toBe(true);
  });

  it("a pg-boss that failed to start schedules no cron (as the one process did)", async () => {
    jobs.startBoss.mockRejectedValueOnce(new Error("db down"));
    const ctx = ctxFor("worker");
    await startBackground(ctx, "listening", [
      starter("pg-boss-workers"),
      starter("cron-schedules"),
    ]);
    expect(ctx.boss.started).toBe(false);
    expect(jobs.registerCronSchedules).not.toHaveBeenCalled();
  });
});

describe("LOCAL_MODE", () => {
  it("runs the local sync driver and no pg-boss", async () => {
    const ctx = ctxFor("all", true);
    await startBackground(ctx, "listening", [
      starter("local-sync-driver"),
      starter("pg-boss-workers"),
      starter("cron-schedules"),
    ]);
    expect(jobs.startLocalSyncDriver).toHaveBeenCalledTimes(1);
    expect(jobs.startBoss).not.toHaveBeenCalled();
    expect(jobs.registerCronSchedules).not.toHaveBeenCalled();
  });
});

describe("the table and its runner", () => {
  it("every starter names at least one role and a unique key", () => {
    const seen = new Set<string>();
    for (const s of BACKGROUND_STARTERS) {
      expect(s.runsIn.length, s.key).toBeGreaterThan(0);
      for (const r of s.runsIn) expect(["all", "api", "worker"]).toContain(r);
      expect(seen.has(s.key), s.key).toBe(false);
      seen.add(s.key);
      expect(s.why.length, s.key).toBeGreaterThan(10);
    }
  });

  it("every starter of a split role also runs in all, except the split-only ones", () => {
    // `all` is api ∪ worker minus what exists only because there are two
    // processes; anything else missing from `all` would be a regression of
    // the one-process pod.
    const splitOnly = new Set(["pg-boss-send", "event-stream-relay-listener"]);
    for (const s of BACKGROUND_STARTERS) {
      if (splitOnly.has(s.key)) continue;
      expect(s.runsIn, s.key).toContain("all");
    }
  });

  it("awaits a starter, does not await a detached one, and survives a failure", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const table: BackgroundStarter[] = [
      {
        key: "slow-detached",
        runsIn: ["all"],
        phase: "boot",
        detached: true,
        why: "test: kicked off, not awaited",
        start: async () => {
          await gate;
          order.push("slow-detached");
        },
      },
      {
        key: "throws",
        runsIn: ["all"],
        phase: "boot",
        why: "test: a failure is logged, the boot goes on",
        start: () => {
          throw new Error("boom");
        },
      },
      {
        key: "after",
        runsIn: ["all"],
        phase: "boot",
        why: "test: runs after the failure",
        start: () => {
          order.push("after");
        },
      },
      {
        key: "other-role",
        runsIn: ["worker"],
        phase: "boot",
        why: "test: not this role",
        start: () => {
          order.push("other-role");
        },
      },
    ];
    const errors: unknown[] = [];
    const ctx = {
      ...ctxFor("all"),
      log: { ...quietLog, error: (o: unknown) => errors.push(o) },
    };
    const started = await startBackground(ctx, "boot", table);
    expect(started).toEqual(["slow-detached", "throws", "after"]);
    expect(order).toEqual(["after"]);
    expect(errors).toHaveLength(1);
    release();
    await gate;
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["after", "slow-detached"]);
  });
});
