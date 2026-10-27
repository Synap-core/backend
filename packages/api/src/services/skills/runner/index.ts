/**
 * The skill runner seam: WHERE a code skill's isolate runs, never what it may
 * do (that is the broker's bridges, `run-skill-in-sandbox.ts`).
 *
 *   process  (default)  a supervised pool of child processes (`process-pool.ts`).
 *   inline              the isolate in the calling process: tests and
 *                       `pnpm dev` only, refused in production (pod decision
 *                       R6: never isolated-vm inside the API process).
 *
 * Chosen by `SKILL_RUNNER` (`process` | `inline`); the pool's size by
 * `SKILL_RUNNER_PROCESSES`, `SKILL_RUNNER_ISOLATES_PER_PROCESS`,
 * `SKILL_RUNNER_QUEUE_MAX` and `SKILL_RUNNER_PER_REQUESTER_MAX` (forwarded by
 * `deploy/docker-compose.yml`, held by `deploy/__tests__/skill-runtime-deploy.test.sh`).
 *
 * WHO runs code skills is `skillRuntime()`: the pod, by default since R2
 * (code-runtime plan v2), or the Intelligence Service only as a rollback
 * (`SKILL_RUNTIME=is`) until W6 deletes that path. The one door that picks is
 * `services/skills/run-skill.ts`.
 */
import { createLogger } from "@synap-core/core";
import {
  createProcessSkillPool,
  SkillRuntimeError,
  type ProcessPoolConfig,
  type ProcessPoolHealth,
  type ProcessSkillPool,
  type SkillRunOptions,
} from "./process-pool.js";
import type { SkillBridges, SkillJob } from "./protocol.js";
import { evaluateSkill } from "./skill-isolate.js";

export {
  SkillRuntimeError,
  type SkillRuntimeErrorCode,
  type SkillRunOptions,
} from "./process-pool.js";
export type { SkillBridges, SkillJob } from "./protocol.js";
export { SKILL_BRIDGE_NAMES } from "./protocol.js";

const logger = createLogger({ module: "skill-runner" });

export interface SkillRunner {
  readonly kind: "inline" | "process";
  run(
    job: SkillJob,
    bridges: SkillBridges,
    options?: SkillRunOptions
  ): Promise<unknown>;
}

export const inlineSkillRunner: SkillRunner = {
  kind: "inline",
  // No pool, so no per-requester count; evaluateSkill's third argument is its
  // abort signal, never the options.
  run: (job, bridges) => evaluateSkill(job, bridges),
};

export type SkillRuntimeHealth =
  | { runner: "intelligence-service" }
  | { runner: "inline" }
  | ProcessPoolHealth
  | { runner: "refused"; status: "unavailable"; reason: string };

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function poolConfigFromEnv(): ProcessPoolConfig {
  const isolatesPerProcess = intFromEnv("SKILL_RUNNER_ISOLATES_PER_PROCESS", 4);
  return {
    processes: intFromEnv("SKILL_RUNNER_PROCESSES", 2),
    isolatesPerProcess,
    queueMax: intFromEnv("SKILL_RUNNER_QUEUE_MAX", 32),
    // One runner's worth by default: a burst from one agent leaves the other
    // runner's slots and the queue to everyone else.
    perRequesterMax: intFromEnv(
      "SKILL_RUNNER_PER_REQUESTER_MAX",
      isolatesPerProcess
    ),
    watchdogGraceMs: 5_000,
    startTimeoutMs: 10_000,
  };
}

/** Where code skills run on this pod. */
export type SkillRuntimeName = "pod" | "intelligence-service";

/**
 * The pod runs code skills (R2). `SKILL_RUNTIME=is` sends them back to the
 * Intelligence Service: a rollback switch, never a fallback — a pod runtime
 * that cannot start fails the run (`SKILL_RUNTIME_UNAVAILABLE`), it does not
 * quietly move to the IS.
 */
export function skillRuntime(): SkillRuntimeName {
  return process.env.SKILL_RUNTIME === "is" ? "intelligence-service" : "pod";
}

const INLINE_REFUSED =
  "SKILL_RUNNER=inline is refused in production: code skills never run inside the API process (pod decision R6).";

let pool: ProcessSkillPool | null = null;

function processPool(): ProcessSkillPool {
  pool ??= createProcessSkillPool(poolConfigFromEnv());
  return pool;
}

/** The runner code skills use on this pod, from `SKILL_RUNNER`. */
export function getSkillRunner(): SkillRunner {
  if (process.env.SKILL_RUNNER === "inline") {
    if (process.env.NODE_ENV === "production") {
      return {
        kind: "inline",
        run: () =>
          Promise.reject(
            new SkillRuntimeError("SKILL_RUNTIME_UNAVAILABLE", INLINE_REFUSED)
          ),
      };
    }
    return inlineSkillRunner;
  }
  return processPool();
}

/** `/health`'s `skillRuntime`: where code skills run and whether they can. */
export function skillRuntimeHealth(): SkillRuntimeHealth {
  if (skillRuntime() === "intelligence-service")
    return { runner: "intelligence-service" };
  if (process.env.SKILL_RUNNER === "inline") {
    return process.env.NODE_ENV === "production"
      ? { runner: "refused", status: "unavailable", reason: INLINE_REFUSED }
      : { runner: "inline" };
  }
  return processPool().health();
}

/**
 * Boot: when this pod runs code skills, start one runner now, so `/health`
 * says at once whether the runtime can start (the addon loads) instead of at
 * the first skill run. Never throws; a failure is logged and read on /health.
 */
export async function warmSkillRuntime(): Promise<void> {
  if (skillRuntime() === "intelligence-service") return;
  if (process.env.SKILL_RUNNER === "inline") return;
  await processPool().warm();
  const health = processPool().health();
  if (health.status === "ready") {
    logger.info(
      { limits: health.limits },
      "skill runtime ready (process pool)"
    );
  } else {
    logger.error(
      { health },
      "skill runtime NOT ready: code skills will fail until fixed"
    );
  }
}
