/**
 * The supervised pool of skill runner processes (pod decision R6, 2026-08-01:
 * "sandbox isolation is process-level, never isolated-vm inside the API
 * process"; runtime research, Option B).
 *
 * N children made with `child_process.fork` — NOT worker threads: a V8 abort
 * or OOM in a thread kills the whole API, in a child it kills the child. Each
 * child runs up to K isolates at once; runs past N×K wait in a FIFO queue, and
 * past `queueMax` are refused at once with a typed `busy` error, never queued
 * without bound and never silently dropped.
 *
 * The broker side lives here: a run's bridges (built and bound to the run's
 * async context by the caller) are executed HERE when the child asks, so the
 * child never holds an identity, a session, a verbAct or a credential.
 *
 * Supervision: a run that does not answer within its timeout plus a grace is
 * failed (`timeout`) and cancelled in its child (its bridge waits end, its
 * isolate is disposed); a child that does not stop it within a grace is
 * killed. A child that dies (OOM, abort, kill) fails every run it held with
 * the reason, and is replaced on demand. The API keeps serving.
 * Children are spawned lazily, kept warm, and `unref`'d while idle (an idle
 * pool never keeps the process alive).
 *
 * K > 1 trades blast radius for throughput: the runs sharing a child share its
 * fate (a process-level crash fails them all, loudly) and, should an isolate
 * ever be escaped, its bridges. The sidecar wall (R3) moves the whole pool
 * out of the API container.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogger } from "@synap-core/core";
import {
  SKILL_BRIDGE_NAMES,
  type BrokerMessage,
  type RunnerMessage,
  type SkillBridges,
  type SkillJob,
} from "./protocol.js";

const logger = createLogger({ module: "skill-runner-pool" });

/**
 * The ONLY variables a runner process receives. The child reads none itself;
 * `TZ` keeps a skill's `Date` on the pod's clock, as in the API. Everything
 * else (DATABASE_URL, the vault key, service keys, NODE_OPTIONS…) stays out by
 * construction — an allowlist, so a secret added tomorrow is excluded too.
 */
export const RUNNER_ENV_ALLOWLIST = ["TZ"] as const;

/** Heap of a runner's own (main) isolate; each skill isolate has its own cap. */
const RUNNER_HEAP_MB = 128;

/** A cancelled run that has not stopped after this long gets its runner killed. */
const CANCEL_GRACE_MS = 2_000;

/** After a runner fails to start, no new one is forked for this long. */
const START_RETRY_MS = 5_000;

export type SkillRuntimeErrorCode =
  /** Every slot is busy and the queue is full: retry later. */
  | "SKILL_RUNTIME_BUSY"
  /** The runner process stopped (crash, OOM, kill) while the run was on it. */
  | "SKILL_RUNTIME_CRASHED"
  /** The run did not answer within its timeout plus a grace: its runner was killed. */
  | "SKILL_RUNTIME_TIMEOUT"
  /** No runner can start (e.g. the addon does not load), or the pool is closed. */
  | "SKILL_RUNTIME_UNAVAILABLE";

export class SkillRuntimeError extends Error {
  constructor(
    readonly code: SkillRuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SkillRuntimeError";
  }
}

export interface ProcessPoolConfig {
  /** Runner processes alive at most (N). */
  processes: number;
  /** Isolates one runner evaluates at once (K). */
  isolatesPerProcess: number;
  /** Runs waiting for a slot at most; more are refused `busy`. */
  queueMax: number;
  /** Past `timeoutMs + watchdogGraceMs` without an answer, the runner is killed. */
  watchdogGraceMs: number;
}

export interface ProcessPoolHealth {
  runner: "process";
  /** ready: a runner is up · starting · idle: none spawned yet · unavailable: the last start failed. */
  status: "ready" | "starting" | "idle" | "unavailable";
  reason?: string;
  processes: number;
  running: number;
  queued: number;
  limits: ProcessPoolConfig;
}

interface Run {
  runId: string;
  job: SkillJob;
  bridges: SkillBridges;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  slot: Slot | null;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface Slot {
  child: ChildProcess;
  ready: boolean;
  exited: boolean;
  runs: Map<string, Run>;
  /** Why the broker stopped this child, when it did (else it died on its own). */
  killReason: string | null;
  /**
   * Runs failed past their limit and cancelled, until the runner answers
   * `done` for them (they still hold an isolate): runId → the kill timer.
   */
  draining: Map<string, ReturnType<typeof setTimeout>>;
  /** The child's own last words (`fatal`), when it could not start. */
  fatal: string | null;
  readyWaiters: Array<() => void>;
}

/**
 * The runner entry next to this module: the bundled `skill-runner-child.js` in
 * a build (a tsup entry), or — when this module runs from TypeScript source
 * (tsx dev, vitest) — `skill-runner-child.ts` under tsx's loader.
 */
function runnerEntry(): { modulePath: string; execArgv: string[] } {
  const execArgv = [
    // isolated-vm: "If you are using a version of nodejs 20.x or later, you
    // must pass --no-node-snapshot".
    "--no-node-snapshot",
    `--max-old-space-size=${RUNNER_HEAP_MB}`,
  ];
  const here = import.meta.url;
  if (!here.endsWith(".ts")) {
    return {
      modulePath: fileURLToPath(new URL("./skill-runner-child.js", here)),
      execArgv,
    };
  }
  const tsxLoader = pathToFileURL(createRequire(here).resolve("tsx")).href;
  return {
    modulePath: fileURLToPath(new URL("./skill-runner-child.ts", here)),
    execArgv: [...execArgv, "--import", tsxLoader],
  };
}

function runnerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of RUNNER_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function isBridgeName(
  name: unknown
): name is (typeof SKILL_BRIDGE_NAMES)[number] {
  return (SKILL_BRIDGE_NAMES as readonly unknown[]).includes(name);
}

export interface ProcessSkillPool {
  readonly kind: "process";
  run(job: SkillJob, bridges: SkillBridges): Promise<unknown>;
  health(): ProcessPoolHealth;
  /** Start one runner if none is alive; resolves once it is ready or failed. */
  warm(): Promise<void>;
  /** The live runners' pids (diagnostics and tests). */
  pids(): number[];
  /** Fail what waits, kill every runner. */
  shutdown(): Promise<void>;
}

export function createProcessSkillPool(
  config: ProcessPoolConfig
): ProcessSkillPool {
  const slots: Slot[] = [];
  const queue: Run[] = [];
  let lastStartError: string | null = null;
  let spawnPausedUntil = 0;
  let closed = false;

  const running = () => slots.reduce((n, s) => n + s.runs.size, 0);

  function holdOpen(slot: Slot, on: boolean) {
    if (on) {
      slot.child.ref();
      slot.child.channel?.ref();
    } else {
      slot.child.unref();
      slot.child.channel?.unref();
    }
  }

  function finish(run: Run, outcome: { value: unknown } | { error: Error }) {
    if (run.settled) return;
    run.settled = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    const slot = run.slot;
    if (slot) {
      slot.runs.delete(run.runId);
      if (slot.runs.size === 0 && !slot.exited) holdOpen(slot, false);
    }
    if ("error" in outcome) run.reject(outcome.error);
    else run.resolve(outcome.value);
  }

  function reply(slot: Slot, msg: BrokerMessage) {
    if (slot.exited || !slot.child.connected) return;
    slot.child.send(msg, (err) => {
      if (err)
        logger.warn({ err }, "skill runner: a reply did not reach the runner");
    });
  }

  function onBridge(
    slot: Slot,
    msg: Extract<RunnerMessage, { type: "bridge" }>
  ) {
    // The child is untrusted: it may only reach the bridges of a run it holds,
    // by a known name.
    const run = slot.runs.get(msg.runId);
    if (
      !run ||
      run.settled ||
      !isBridgeName(msg.name) ||
      !Array.isArray(msg.args)
    ) {
      if (typeof msg.callId === "number")
        reply(slot, {
          type: "bridge-result",
          runId: String(msg.runId),
          callId: msg.callId,
          ok: false,
          error: "unknown run or bridge",
        });
      return;
    }
    const bridge = run.bridges[msg.name];
    if (msg.callId === null) {
      try {
        bridge(...msg.args);
      } catch (err) {
        logger.warn({ err, bridge: msg.name }, "skill runner: a bridge threw");
      }
      return;
    }
    const callId = msg.callId;
    Promise.resolve()
      .then(() => bridge(...msg.args))
      .then(
        (value) =>
          reply(slot, {
            type: "bridge-result",
            runId: run.runId,
            callId,
            ok: true,
            value,
          }),
        (err: unknown) =>
          reply(slot, {
            type: "bridge-result",
            runId: run.runId,
            callId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
      );
  }

  function onMessage(slot: Slot, msg: RunnerMessage) {
    if (typeof msg !== "object" || msg === null) return;
    switch (msg.type) {
      case "ready":
        slot.ready = true;
        lastStartError = null;
        for (const w of slot.readyWaiters.splice(0)) w();
        pump();
        return;
      case "fatal":
        slot.fatal = String(msg.error);
        return;
      case "bridge":
        onBridge(slot, msg);
        return;
      case "done": {
        const drained = slot.draining.get(msg.runId);
        if (drained) {
          // A cancelled run stopped: its isolate is free again.
          clearTimeout(drained);
          slot.draining.delete(msg.runId);
          pump();
          return;
        }
        const run = slot.runs.get(msg.runId);
        if (!run) return;
        finish(
          run,
          msg.ok ? { value: msg.value } : { error: new Error(msg.error) }
        );
        pump();
        return;
      }
    }
  }

  function onExit(
    slot: Slot,
    code: number | null,
    signal: NodeJS.Signals | null
  ) {
    if (slot.exited) return;
    slot.exited = true;
    for (const t of slot.draining.values()) clearTimeout(t);
    slot.draining.clear();
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    for (const w of slot.readyWaiters.splice(0)) w();
    const how = signal ? `signal ${signal}` : `exit code ${code}`;

    if (!slot.ready && !slot.killReason) {
      // It never started (a ready runner holds no run before its handshake).
      // No new runner is forked for a while — no fork storm — and the runs
      // that cannot be served now fail with the reason, never a fallback.
      startFailure(
        slot.fatal ?? `the skill runner process exited at start (${how})`
      );
      return;
    }

    if (slot.runs.size > 0 || !closed) {
      logger.warn(
        {
          pid: slot.child.pid,
          how,
          killReason: slot.killReason,
          runs: slot.runs.size,
        },
        "skill runner: a runner process stopped"
      );
    }
    for (const run of [...slot.runs.values()]) {
      finish(run, {
        error: new SkillRuntimeError(
          "SKILL_RUNTIME_CRASHED",
          `The skill runtime process stopped (${how}) while this skill ran` +
            (slot.killReason
              ? `: ${slot.killReason}.`
              : ` — likely out of memory or a crash in the isolate.`)
        ),
      });
    }
    pump();
  }

  function spawn(): Slot {
    const { modulePath, execArgv } = runnerEntry();
    const child = fork(modulePath, [], {
      execArgv,
      env: runnerEnv(),
      serialization: "advanced",
    });
    const slot: Slot = {
      child,
      ready: false,
      exited: false,
      runs: new Map(),
      killReason: null,
      draining: new Map(),
      fatal: null,
      readyWaiters: [],
    };
    child.on("message", (msg) => onMessage(slot, msg as RunnerMessage));
    // `close`, not `exit`: it comes after the last IPC message (a `fatal`).
    child.on("close", (code, signal) => onExit(slot, code, signal));
    child.on("error", (err) => {
      logger.error({ err }, "skill runner: runner process error");
      slot.fatal ??= err.message;
      // A spawn failure emits no `close`; a live child is stopped so it does.
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        child.kill("SIGKILL");
      } else {
        onExit(slot, child.exitCode, child.signalCode);
      }
    });
    holdOpen(slot, false);
    slots.push(slot);
    return slot;
  }

  function dispatch(slot: Slot, run: Run) {
    run.slot = slot;
    slot.runs.set(run.runId, run);
    holdOpen(slot, true);
    const limitMs = run.job.timeoutMs + config.watchdogGraceMs;
    run.timer = setTimeout(() => {
      // Past its limit (a skill waiting on a bridge is beyond the isolate's
      // own timeout): the caller is answered now, the runner is asked to stop
      // the run, and only a runner that does not is killed.
      logger.warn(
        { pid: slot.child.pid, runId: run.runId, limitMs },
        "skill runner: a run passed its limit — cancelled"
      );
      finish(run, {
        error: new SkillRuntimeError(
          "SKILL_RUNTIME_TIMEOUT",
          `The skill did not finish within its ${Math.round(run.job.timeoutMs / 1000)} s limit and was stopped.`
        ),
      });
      slot.draining.set(
        run.runId,
        setTimeout(() => {
          logger.warn(
            { pid: slot.child.pid, runId: run.runId },
            "skill runner: a cancelled run did not stop — runner killed"
          );
          slot.killReason =
            "another skill on the same runtime process could not be stopped";
          slot.child.kill("SIGKILL");
        }, CANCEL_GRACE_MS)
      );
      reply(slot, { type: "cancel", runId: run.runId });
    }, limitMs);
    reply(slot, { type: "run", runId: run.runId, ...run.job });
  }

  /**
   * A runner could not start. Forking pauses for `START_RETRY_MS`; when no
   * runner is ready to take them, the waiting runs fail now with the reason.
   */
  function startFailure(reason: string) {
    lastStartError = reason;
    spawnPausedUntil = Date.now() + START_RETRY_MS;
    logger.error({ reason }, "skill runner: a runner process could not start");
    pump();
  }

  function unavailable(): SkillRuntimeError {
    return new SkillRuntimeError(
      "SKILL_RUNTIME_UNAVAILABLE",
      `The pod's skill runtime is unavailable: ${lastStartError}`
    );
  }

  function pump() {
    if (closed) return;
    // A runner being killed takes nothing new.
    const live = () => slots.filter((s) => !s.exited && !s.killReason);
    const load = (s: Slot) => s.runs.size + s.draining.size;
    // Spread before sharing: one fresh runner per waiting run, up to N, so a
    // run shares a runner (and its fate) only when N are already up.
    let empty = live().filter((s) => load(s) === 0).length;
    while (
      queue.length > empty &&
      slots.length < config.processes &&
      Date.now() >= spawnPausedUntil
    ) {
      try {
        spawn();
        empty++;
      } catch (err) {
        startFailure(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    if (queue.length > 0 && slots.length === 0) {
      // Nothing is up, stopping or allowed to start yet: say so now, never hang.
      for (const run of queue.splice(0)) finish(run, { error: unavailable() });
      return;
    }
    const starting = live().some((s) => !s.ready);
    while (queue.length > 0) {
      const slot = live()
        .filter((s) => s.ready && load(s) < config.isolatesPerProcess)
        .sort((a, b) => load(a) - load(b))[0];
      if (!slot) return; // the next `ready`, `done` or `close` pumps again
      if (load(slot) > 0 && starting) return; // a fresh runner is on its way
      dispatch(slot, queue.shift()!);
    }
  }

  return {
    kind: "process",

    run(job, bridges) {
      if (closed) {
        return Promise.reject(
          new SkillRuntimeError(
            "SKILL_RUNTIME_UNAVAILABLE",
            "The skill runtime is shut down."
          )
        );
      }
      if (queue.length >= config.queueMax) {
        return Promise.reject(
          new SkillRuntimeError(
            "SKILL_RUNTIME_BUSY",
            `The pod's skill runtime is busy: ${running()} skills running and ${queue.length} waiting ` +
              `(at most ${config.processes * config.isolatesPerProcess} at once, ${config.queueMax} waiting). Try again shortly.`
          )
        );
      }
      return new Promise((resolve, reject) => {
        queue.push({
          runId: randomUUID(),
          job,
          bridges,
          resolve,
          reject,
          slot: null,
          timer: null,
          settled: false,
        });
        pump();
      });
    },

    health() {
      const live = slots.filter((s) => !s.exited && !s.killReason);
      const status = live.some((s) => s.ready)
        ? "ready"
        : lastStartError
          ? "unavailable"
          : live.length > 0
            ? "starting"
            : "idle";
      return {
        runner: "process",
        status,
        ...(status === "unavailable" && lastStartError
          ? { reason: lastStartError }
          : {}),
        processes: live.length,
        running: running(),
        queued: queue.length,
        limits: { ...config },
      };
    },

    async warm() {
      if (closed) return;
      let slot = slots.find((s) => !s.exited);
      if (!slot) {
        try {
          slot = spawn();
        } catch (err) {
          lastStartError = err instanceof Error ? err.message : String(err);
          return;
        }
      }
      if (slot.ready) return;
      const s = slot;
      await new Promise<void>((resolve) => s.readyWaiters.push(resolve));
    },

    pids() {
      return slots
        .filter((s) => !s.exited && s.child.pid !== undefined)
        .map((s) => s.child.pid!);
    },

    async shutdown() {
      closed = true;
      for (const run of queue.splice(0))
        finish(run, {
          error: new SkillRuntimeError(
            "SKILL_RUNTIME_UNAVAILABLE",
            "The skill runtime is shut down."
          ),
        });
      await Promise.all(
        slots.splice(0).map(
          (slot) =>
            new Promise<void>((resolve) => {
              if (slot.exited) return resolve();
              slot.child.once("close", () => resolve());
              slot.killReason = "the skill runtime was shut down";
              slot.child.kill("SIGKILL");
            })
        )
      );
    },
  };
}
