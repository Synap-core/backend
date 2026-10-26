/**
 * The skill runner protocol — what crosses between the BROKER (the API process:
 * identity, governance, every host bridge) and a RUNNER (a process that only
 * evaluates skill code in an isolate).
 *
 * Transport-agnostic on purpose (runtime research, Option B → C): today the
 * messages ride the `child_process.fork` IPC channel with `serialization:
 * "advanced"` (V8 structured clone, so a bridge result keeps its `Date`s exactly
 * as the in-process isolate copy did); a sidecar runner can carry the SAME
 * messages over a websocket as `v8.serialize` frames without touching a bridge.
 *
 *   broker → runner   run            { runId, code, args, context, timeoutMs }
 *   runner → broker   bridge         { runId, callId, name, args }   (callId null: no reply, `log`)
 *   broker → runner   bridge-result  { runId, callId, ok, value | error }
 *   runner → broker   done           { runId, ok, value | error }
 *   runner → broker   ready | fatal  once, at start (the addon loaded, or why not)
 *
 * Nothing about WHO runs the skill crosses: no user, agent, session, verbAct or
 * key. Those stay in the broker's bridges, bound to the run's async context.
 */

/**
 * Every host bridge a skill reaches, by name. The isolate global is `__<name>`
 * (what `SKILL_STDLIB_BOOTSTRAP` calls). A new bridge is a new name here, a
 * builder entry in `buildSkillBridges` (the `SkillBridges` type makes a missing
 * one a build error) and its stdlib line.
 */
export const SKILL_BRIDGE_NAMES = [
  "log",
  "search",
  "getEntities",
  "getDocument",
  "redeemSecret",
  "hostFetch",
  "callProvider",
  "proposeEntity",
] as const;

export type SkillBridgeName = (typeof SKILL_BRIDGE_NAMES)[number];

/**
 * Bridges the stdlib calls with `applySync` and whose result it ignores
 * (`console.*`). A runner forwards them without waiting for a reply.
 */
export const FIRE_AND_FORGET_BRIDGES: ReadonlySet<SkillBridgeName> = new Set([
  "log",
]);

/**
 * The host side of every bridge: plain values in, a plain (structured-clone
 * safe) value or a throw out. Built in the broker, bound to the run's async
 * context, never handed to a runner.
 */
export type SkillBridges = Record<
  SkillBridgeName,
  (...args: unknown[]) => unknown
>;

/** What a runner needs to evaluate one skill run — and nothing else. */
export interface SkillJob {
  code: string;
  args: Record<string, unknown>;
  /** The `context` parameter the skill reads (ids only, never a credential). */
  context: {
    userId: string;
    workspaceId: string | null;
    agentUserId: string | null;
  };
  timeoutMs: number;
}

export type BrokerMessage =
  | ({ type: "run"; runId: string } & SkillJob)
  | {
      type: "bridge-result";
      runId: string;
      callId: number;
      ok: true;
      value: unknown;
    }
  | {
      type: "bridge-result";
      runId: string;
      callId: number;
      ok: false;
      error: string;
    };

export type RunnerMessage =
  | { type: "ready"; pid: number }
  | { type: "fatal"; error: string }
  | {
      type: "bridge";
      runId: string;
      callId: number | null;
      name: SkillBridgeName;
      args: unknown[];
    }
  | { type: "done"; runId: string; ok: true; value: unknown }
  | { type: "done"; runId: string; ok: false; error: string };
