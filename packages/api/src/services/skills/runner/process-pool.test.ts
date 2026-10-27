/**
 * The pool's waiting rules, proven WITHOUT the native addon (every CI runner):
 * `fork` is a fake runner process that answers the protocol as the test says.
 *
 *   - a runner that never says `ready` is killed past `startTimeoutMs`, and the
 *     runs waiting on it fail with the reason instead of waiting forever;
 *   - a queued run waits at most its own limit (plus a runner's start time),
 *     then fails `busy` without ever reaching a runner;
 *   - one requester holds at most `perRequesterMax` runs (running or waiting);
 *     the next is refused `busy` at once, another requester still gets in;
 *   - a run stopped at its limit says it may have partly run, and names the
 *     acting call (callProvider…) still waiting for its answer.
 *
 * The real-process twin (real fork, real isolate) is
 * `process-pool.real-isolate.test.ts` (devbox).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** "ready": answers `ready` at once · "hang": never does. */
  start: "ready" as "ready" | "hang",
  children: [] as Array<{
    sent: Array<Record<string, unknown>>;
    killed: string | null;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
}));

// The factory runs before this file's own imports are initialised, so it
// imports `node:events` itself.
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  let pid = 1000;
  class FakeRunner extends EventEmitter {
    pid = ++pid;
    connected = true;
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed: string | null = null;
    sent: Array<Record<string, unknown>> = [];
    channel = { ref() {}, unref() {} };
    ref() {}
    unref() {}
    send(msg: Record<string, unknown>, cb?: (err: Error | null) => void) {
      this.sent.push(msg);
      cb?.(null);
      return true;
    }
    kill(signal: string) {
      if (this.killed) return true;
      this.killed = signal;
      this.signalCode = signal;
      this.connected = false;
      setImmediate(() => this.emit("close", null, signal));
      return true;
    }
  }
  return {
    fork: () => {
      const child = new FakeRunner();
      h.children.push(child);
      if (h.start === "ready")
        setImmediate(() =>
          child.emit("message", { type: "ready", pid: child.pid })
        );
      return child;
    },
  };
});

import {
  createProcessSkillPool,
  SkillRuntimeError,
  type ProcessPoolConfig,
  type ProcessSkillPool,
} from "./process-pool.js";
import {
  SKILL_BRIDGE_NAMES,
  type SkillBridges,
  type SkillJob,
} from "./protocol.js";

const pools: ProcessSkillPool[] = [];
function newPool(config: Partial<ProcessPoolConfig> = {}): ProcessSkillPool {
  const pool = createProcessSkillPool({
    processes: 1,
    isolatesPerProcess: 1,
    queueMax: 8,
    perRequesterMax: 8,
    watchdogGraceMs: 0,
    startTimeoutMs: 1_000,
    ...config,
  });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.shutdown()));
  h.children.splice(0);
  h.start = "ready";
});

function job(timeoutMs = 10_000): SkillJob {
  return {
    code: "return 1;",
    args: {},
    context: { userId: "u-1", workspaceId: null, agentUserId: null },
    timeoutMs,
  };
}

function bridges(given: Partial<SkillBridges> = {}): SkillBridges {
  const all = {} as SkillBridges;
  for (const name of SKILL_BRIDGE_NAMES)
    all[name] = given[name] ?? (() => undefined);
  return all;
}

/** The run's outcome, or "still waiting" when it has none after `ms`. */
function settled(p: Promise<unknown>, ms = 1_500) {
  return Promise.race([
    p.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    ),
    new Promise((r) => setTimeout(() => r("still waiting"), ms)),
  ]);
}

const runMessages = (i = 0) =>
  h.children[i]?.sent.filter((m) => m.type === "run") ?? [];
const nextTick = () => new Promise((r) => setImmediate(r));

describe("skill runner pool: nothing waits forever", () => {
  it("a runner that never says ready is killed past its start limit; the run waiting on it fails with the reason", async () => {
    h.start = "hang";
    const pool = newPool({ startTimeoutMs: 50 });
    const out = await settled(pool.run(job(), bridges()));
    expect(out).toMatchObject({ error: expect.any(SkillRuntimeError) });
    const err = (out as { error: SkillRuntimeError }).error;
    expect(err.code).toBe("SKILL_RUNTIME_UNAVAILABLE");
    expect(err.message).toMatch(/did not start within/);
    expect(h.children[0]!.killed).toBe("SIGKILL");
    expect(pool.health()).toMatchObject({ status: "unavailable" });
  });

  it("a queued run waits at most its own limit plus a runner's start, then fails busy and never reaches a runner", async () => {
    const pool = newPool({ startTimeoutMs: 20 });
    const first = pool.run(job(), bridges()); // holds the only slot
    await nextTick();
    await nextTick();
    expect(runMessages()).toHaveLength(1);
    const started = Date.now();
    const out = await settled(pool.run(job(50), bridges()));
    expect(out).toMatchObject({ error: expect.any(SkillRuntimeError) });
    const err = (out as { error: SkillRuntimeError }).error;
    expect(err.code).toBe("SKILL_RUNTIME_BUSY");
    expect(err.message).toMatch(/was not started\. Nothing ran/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(runMessages()).toHaveLength(1); // the second never reached the runner
    expect(pool.health()).toMatchObject({ queued: 0, running: 1 });
    void first.catch(() => undefined);
  });
});

describe("skill runner pool: one requester cannot take every turn", () => {
  it("past its share a requester is refused busy at once; another requester still runs; a finished run frees the share", async () => {
    const pool = newPool({ isolatesPerProcess: 4, perRequesterMax: 2 });
    const a1 = pool.run(job(), bridges(), { requester: "agent-1" });
    const a2 = pool.run(job(), bridges(), { requester: "agent-1" });
    const refused = await settled(
      pool.run(job(), bridges(), { requester: "agent-1" }),
      200
    );
    expect(refused).toMatchObject({ error: expect.any(SkillRuntimeError) });
    const err = (refused as { error: SkillRuntimeError }).error;
    expect(err.code).toBe("SKILL_RUNTIME_BUSY");
    expect(err.message).toMatch(/already has 2 skills running or waiting/);

    const other = pool.run(job(), bridges(), { requester: "person-2" });
    await nextTick();
    await nextTick();
    expect(runMessages()).toHaveLength(3); // a1, a2 and the other requester's

    // One of agent-1's runs finishes: its share frees one turn.
    const firstRunId = runMessages()[0]!.runId;
    h.children[0]!.emit("message", {
      type: "done",
      runId: firstRunId,
      ok: true,
      value: 1,
    });
    await expect(a1).resolves.toBe(1);
    const a3 = pool.run(job(), bridges(), { requester: "agent-1" });
    await nextTick();
    expect(runMessages()).toHaveLength(4);
    for (const p of [a2, other, a3]) void p.catch(() => undefined);
  });

  it("a run without a requester is not counted (tests, internal callers)", async () => {
    const pool = newPool({ isolatesPerProcess: 4, perRequesterMax: 1 });
    const runs = [pool.run(job(), bridges()), pool.run(job(), bridges())];
    await nextTick();
    await nextTick();
    expect(runMessages()).toHaveLength(2);
    for (const p of runs) void p.catch(() => undefined);
  });
});

describe("skill runner pool: a stopped run says it may have partly run", () => {
  it("names the acting call still waiting for its answer", async () => {
    const pool = newPool();
    const never = new Promise(() => undefined);
    const run = pool.run(
      job(30),
      bridges({ callProvider: () => never, search: () => never })
    );
    await nextTick();
    await nextTick();
    const runId = runMessages()[0]!.runId;
    // The skill is waiting on a provider POST and on a search (a read).
    h.children[0]!.emit("message", {
      type: "bridge",
      runId,
      callId: 1,
      name: "callProvider",
      args: ["google", "POST", "/x"],
    });
    h.children[0]!.emit("message", {
      type: "bridge",
      runId,
      callId: 2,
      name: "search",
      args: ["q"],
    });
    const out = await settled(run);
    const err = (out as { error: SkillRuntimeError }).error;
    expect(err).toBeInstanceOf(SkillRuntimeError);
    expect(err.code).toBe("SKILL_RUNTIME_TIMEOUT");
    expect(err.message).toMatch(/may have partly run/);
    expect(err.message).toMatch(/its callProvider call still waiting/);
    expect(err.message).not.toMatch(/search/); // a read changes nothing
  });

  it("with nothing pending it still says what ran stays done", async () => {
    const pool = newPool();
    const run = pool.run(job(30), bridges());
    const out = await settled(run);
    const err = (out as { error: SkillRuntimeError }).error;
    expect(err.code).toBe("SKILL_RUNTIME_TIMEOUT");
    expect(err.message).toMatch(
      /may have partly run: anything it did before the limit stays done\./
    );
  });
});
