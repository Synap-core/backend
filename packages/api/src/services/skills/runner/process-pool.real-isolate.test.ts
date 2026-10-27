/**
 * Code skills run in supervised runner PROCESSES, never in the API process
 * (pod decision R6). Real `child_process.fork`, real isolated-vm isolates, real
 * IPC; the broker side is this test process, as it is the API in production.
 *
 * What it proves: a skill past its memory limit and one that never stops each
 * fail ALONE with a reason while a concurrent skill succeeds; a runner that
 * dies mid-run fails that run loudly and is replaced; a bridge called from a
 * runner reaches the broker's bridge under the run's acting agent; past the
 * queue a run is refused with a typed `busy`; a runner's environment holds no
 * secret (read from the real process, `/proc/<pid>/environ`).
 *
 * Boundary, measured with the negative control (negctl/r2b-1): the memory and
 * loop cases are contained by isolated-vm itself, so they stay green with the
 * isolate back in the API process. What only a process gives — a crash or a
 * kill that takes the runner, not the API — is the kill case, and the
 * environment case is what keeps secrets out of the runner.
 *
 * SKIPPED where the isolated-vm addon is not built (Node 20). Runs on the
 * devbox gate tree (Node 22).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  // A secret the API holds: it must never reach a runner.
  process.env.SYNAP_R2B_SECRET_CANARY = "canary-must-not-cross";
});
import { getActingAgentUserId, runWithActingAgent } from "@synap/database";
import { runIsolate } from "../run-skill-in-sandbox.js";
import {
  createProcessSkillPool,
  RUNNER_ENV_ALLOWLIST,
  SkillRuntimeError,
  type ProcessPoolConfig,
  type ProcessSkillPool,
} from "./process-pool.js";
import {
  inlineSkillRunner,
  SKILL_BRIDGE_NAMES,
  type SkillBridges,
  type SkillJob,
} from "./index.js";

const ivmLoads = await import("isolated-vm").then(
  () => true,
  () => false
);
const onLinux = process.platform === "linux";

const pools: ProcessSkillPool[] = [];
function newPool(config: Partial<ProcessPoolConfig> = {}): ProcessSkillPool {
  const pool = createProcessSkillPool({
    processes: 3,
    isolatesPerProcess: 1,
    queueMax: 8,
    perRequesterMax: 8,
    watchdogGraceMs: 2_000,
    startTimeoutMs: 10_000,
    ...config,
  });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.shutdown()));
});

function job(code: string, timeoutMs = 5_000): SkillJob {
  return {
    code,
    args: {},
    context: { userId: "u-1", workspaceId: null, agentUserId: null },
    timeoutMs,
  };
}

/** Every bridge refuses, except the ones a case gives. */
function bridges(given: Partial<SkillBridges> = {}): SkillBridges {
  const all = {} as SkillBridges;
  for (const name of SKILL_BRIDGE_NAMES) {
    all[name] =
      given[name] ??
      (() => {
        throw new Error(`bridge ${name} is not part of this case`);
      });
  }
  return all;
}

/** A bridge call the case answers when it chooses. */
function gate<T>() {
  let release!: (value: T) => void;
  let called!: () => void;
  const reached = new Promise<void>((r) => (called = r));
  const answer = new Promise<T>((r) => (release = r));
  return {
    reached,
    release,
    bridge: () => {
      called();
      return answer;
    },
  };
}

const ALLOCATE_FOREVER =
  "const keep = []; while (true) keep.push(new Array(100000).fill(Math.random()));";
const LOOP_FOREVER = "while (true) {}";
const SLOW_NORMAL =
  "const r = await hubProtocol.getEntities({}); return r.n + 1;";

const slowEntities = () =>
  new Promise<{ n: number }>((r) => setTimeout(() => r({ n: 41 }), 1_500));

describe.skipIf(!ivmLoads)("skill runner pool: containment", () => {
  for (const shape of [
    {
      label: "one run per runner (N=3, K=1)",
      processes: 3,
      isolatesPerProcess: 1,
    },
    {
      label: "three runs on ONE runner (N=1, K=3)",
      processes: 1,
      isolatesPerProcess: 3,
    },
  ]) {
    it(`a skill past its memory limit and one that never stops each fail alone, with a reason, while a concurrent skill succeeds — ${shape.label}`, async () => {
      const pool = newPool(shape);
      const apiPid = process.pid;
      const [oom, loop, normal] = await Promise.allSettled([
        pool.run(job(ALLOCATE_FOREVER), bridges()),
        pool.run(job(LOOP_FOREVER, 1_000), bridges()),
        pool.run(job(SLOW_NORMAL), bridges({ getEntities: slowEntities })),
      ]);
      expect(oom.status).toBe("rejected");
      expect(String((oom as PromiseRejectedResult).reason?.message)).toMatch(
        /memory/i
      );
      expect(loop.status).toBe("rejected");
      expect(String((loop as PromiseRejectedResult).reason?.message)).toMatch(
        /timed out|did not stop/i
      );
      expect(normal).toEqual({ status: "fulfilled", value: 42 });
      // The API side is untouched: same process, and the pool still serves.
      expect(process.pid).toBe(apiPid);
      await expect(
        pool.run(job("return 'still here';"), bridges())
      ).resolves.toBe("still here");
    });
  }

  it("a runner that dies mid-run fails that run loudly with the reason, and is replaced", async () => {
    const pool = newPool({ processes: 1 });
    const hang = gate<unknown>();
    const running = pool.run(
      job("return await hubProtocol.getEntities({});"),
      bridges({ getEntities: hang.bridge })
    );
    await hang.reached;
    const [pid] = pool.pids();
    expect(pid).toBeTypeOf("number");
    expect(pid).not.toBe(process.pid); // the isolate is NOT in this process
    process.kill(pid!, "SIGKILL");
    const err = await running.then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SkillRuntimeError);
    expect((err as SkillRuntimeError).code).toBe("SKILL_RUNTIME_CRASHED");
    expect((err as SkillRuntimeError).message).toMatch(/SIGKILL/);
    // Replaced on demand.
    await expect(pool.run(job("return 7;"), bridges())).resolves.toBe(7);
    expect(pool.pids()).toHaveLength(1);
    expect(pool.pids()[0]).not.toBe(pid);
  });

  it("a run stuck on a bridge past its limit is stopped alone: the caller gets a timeout, a co-tenant finishes, the runner lives", async () => {
    // isolated-vm's own `timeout` does not stop a skill waiting on a bridge
    // (seen on the devbox, 2026-10-26): the broker's watchdog answers the
    // caller and cancels the run in its runner, without killing the runner.
    const pool = newPool({
      processes: 1,
      isolatesPerProcess: 2,
      watchdogGraceMs: 300,
    });
    await pool.warm();
    const [pid] = pool.pids();
    // Three rounds: a cancel that crashed the runner once in a while (the
    // SIGSEGV this case caught) must not pass on luck.
    for (let round = 0; round < 3; round++) {
      const hang = gate<unknown>();
      const started = Date.now();
      const stuck = pool
        .run(
          job("return await hubProtocol.getEntities({});", 300),
          bridges({ getEntities: hang.bridge })
        )
        .then(
          () => null,
          (e: unknown) => e
        );
      await hang.reached;
      const neighbour = pool.run(
        job(SLOW_NORMAL),
        bridges({ getEntities: slowEntities })
      );
      const err = await stuck;
      expect(err).toBeInstanceOf(SkillRuntimeError);
      expect((err as SkillRuntimeError).code).toBe("SKILL_RUNTIME_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(3_000);
      await expect(neighbour).resolves.toBe(42);
      expect(pool.pids()).toEqual([pid]); // cancelled, not killed
    }
    await expect(pool.run(job("return 8;"), bridges())).resolves.toBe(8);
  });
});

describe.skipIf(!ivmLoads)(
  "skill runner pool: the broker keeps identity and every bridge",
  () => {
    it("a bridge called from a runner process runs in the broker under the run's acting agent", async () => {
      const pool = newPool();
      const seen: Array<string | undefined> = [];
      const caller = {
        entities: {
          getEntities: async () => {
            seen.push(getActingAgentUserId());
            return { entities: [{ id: "e-1" }] };
          },
        },
      };
      // The runner starts OUTSIDE every agent scope, as at boot: an IPC
      // message then carries the async context of the fork, so an unbound
      // bridge would read no agent (or, forked during agent A's run, A's
      // identity on every later run). Two agents in a row rule out both.
      await pool.warm();
      const runAs = (agent: string) =>
        runWithActingAgent(agent, () =>
          runIsolate({
            code: "return await hubProtocol.getEntities({ profileSlug: 'task' });",
            args: {},
            context: { userId: "u-1", workspaceId: null, agentUserId: agent },
            timeoutMs: 5_000,
            allowedHosts: [],
            operatorUserId: "u-1",
            workspaceId: null,
            agentUserId: agent,
            caller: caller as never,
            failureSink: {},
            runner: pool,
          })
        );
      const result = await runAs("agent-7");
      await runAs("agent-8");
      expect(result).toEqual({ entities: [{ id: "e-1" }] });
      expect(seen).toEqual(["agent-7", "agent-8"]);
      expect(pool.pids()).not.toContain(process.pid);
    });

    it("a bridge's failure reaches the skill as a catchable error, as in-process", async () => {
      const code =
        "try { await hubProtocol.getEntities({}); return 'no'; } catch (e) { return e.message; }";
      const refuse = bridges({
        getEntities: async () => {
          throw new Error("refused by the gate");
        },
      });
      const pool = newPool();
      await expect(pool.run(job(code), refuse)).resolves.toBe(
        "refused by the gate"
      );
      await expect(inlineSkillRunner.run(job(code), refuse)).resolves.toBe(
        "refused by the gate"
      );
    });

    it("past the queue a run is refused at once with a typed busy error; the others still run", async () => {
      const pool = newPool({
        processes: 1,
        isolatesPerProcess: 1,
        queueMax: 1,
      });
      const hang = gate<{ n: number }>();
      const first = pool.run(
        job(SLOW_NORMAL),
        bridges({ getEntities: hang.bridge })
      );
      await hang.reached;
      const second = pool.run(job("return 2;"), bridges()); // waits in the queue
      const third = await pool.run(job("return 3;"), bridges()).then(
        () => null,
        (e: unknown) => e
      );
      expect(third).toBeInstanceOf(SkillRuntimeError);
      expect((third as SkillRuntimeError).code).toBe("SKILL_RUNTIME_BUSY");
      expect(pool.health()).toMatchObject({ running: 1, queued: 1 });
      hang.release({ n: 0 });
      await expect(first).resolves.toBe(1);
      await expect(second).resolves.toBe(2);
    });
  }
);

describe.skipIf(!ivmLoads || !onLinux)(
  "skill runner pool: what a runner process holds",
  () => {
    it("a runner's environment holds no secret, and it runs with --no-node-snapshot", async () => {
      // Non-vacuity: the broker really holds the secrets the runner must not.
      expect(process.env.DATABASE_URL).toBeTruthy();
      expect(process.env.SYNAP_R2B_SECRET_CANARY).toBe("canary-must-not-cross");

      const pool = newPool();
      expect(pool.health().status).toBe("idle");
      await pool.warm();
      expect(pool.health()).toMatchObject({ status: "ready", processes: 1 });
      const [pid] = pool.pids();
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .filter(Boolean);
      const keys = environ.map((kv) => kv.slice(0, kv.indexOf("=")));
      expect(environ.join("\n")).not.toContain("canary-must-not-cross");
      expect(keys).not.toContain("DATABASE_URL");
      // Every variable is allow-listed, or the IPC channel node itself adds.
      const allowed = new Set<string>(RUNNER_ENV_ALLOWLIST);
      expect(
        keys.filter((k) => !allowed.has(k) && !k.startsWith("NODE_CHANNEL_"))
      ).toEqual([]);
      expect(keys.some((k) => k.startsWith("NODE_CHANNEL_"))).toBe(true); // it IS a forked runner

      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      expect(argv).toContain("--no-node-snapshot");
    });

    it("measures the cost of a runner (logged, not asserted beyond sanity)", async () => {
      const rssKb = (pid: number) =>
        Number(
          /VmRSS:\s+(\d+)/.exec(
            readFileSync(`/proc/${pid}/status`, "utf8")
          )?.[1]
        );
      const pool = newPool({ processes: 1 });
      const t0 = performance.now();
      await pool.warm();
      const coldMs = performance.now() - t0;
      const [pid] = pool.pids();
      const idleKb = rssKb(pid!);
      const time = async (run: () => Promise<unknown>, n = 20) => {
        const s = performance.now();
        for (let i = 0; i < n; i++) await run();
        return (performance.now() - s) / n;
      };
      const processMs = await time(() => pool.run(job("return 1;"), bridges()));
      const inlineMs = await time(() =>
        inlineSkillRunner.run(job("return 1;"), bridges())
      );
      const bridgeMs = await time(() =>
        pool.run(
          job("return await hubProtocol.getEntities({});"),
          bridges({ getEntities: async () => ({ entities: [] }) })
        )
      );
      const afterKb = rssKb(pid!);
      console.info(
        `[r2b-measure] runner cold start ${coldMs.toFixed(0)} ms; runner RSS idle ${(idleKb / 1024).toFixed(1)} MB, after 60 runs ${(afterKb / 1024).toFixed(1)} MB; ` +
          `per run: process ${processMs.toFixed(2)} ms vs inline ${inlineMs.toFixed(2)} ms; one bridge round trip run ${bridgeMs.toFixed(2)} ms`
      );
      expect(processMs).toBeGreaterThan(0);
    });
  }
);
