/**
 * A skill runner process: evaluates skill code in isolates, and nothing else.
 *
 * Forked by `process-pool.ts` with a scrubbed environment (no database URL, no
 * vault key, nothing secret) and `--no-node-snapshot` (isolated-vm requires it
 * on Node ≥ 20). It holds no identity and no credential: every bridge a skill
 * calls is a `bridge` message to the broker, which runs it under the run's
 * identity and answers. A V8 abort or OOM here kills this process, never the
 * API. Imports only `node:` builtins, isolated-vm and the stdlib, so it can
 * run as a sidecar with the same messages (see `protocol.ts`).
 */
import { evaluateSkill, loadIvm } from "./skill-isolate.js";
import {
  FIRE_AND_FORGET_BRIDGES,
  SKILL_BRIDGE_NAMES,
  type BrokerMessage,
  type RunnerMessage,
  type SkillBridges,
} from "./protocol.js";

function send(msg: RunnerMessage): void {
  process.send?.(msg);
}

const pending = new Map<
  number,
  {
    runId: string;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }
>();
let nextCallId = 1;
/** The runs in flight, to stop one the broker cancels. */
const running = new Map<string, AbortController>();

/** Bridges that forward to the broker for ONE run. */
function forwardingBridges(runId: string): SkillBridges {
  const bridges = {} as SkillBridges;
  for (const name of SKILL_BRIDGE_NAMES) {
    bridges[name] = FIRE_AND_FORGET_BRIDGES.has(name)
      ? (...args: unknown[]) => {
          send({ type: "bridge", runId, callId: null, name, args });
        }
      : (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            const callId = nextCallId++;
            pending.set(callId, { runId, resolve, reject });
            send({ type: "bridge", runId, callId, name, args });
          });
  }
  return bridges;
}

async function run(msg: Extract<BrokerMessage, { type: "run" }>) {
  const stop = new AbortController();
  running.set(msg.runId, stop);
  try {
    const value = await evaluateSkill(
      {
        code: msg.code,
        args: msg.args,
        context: msg.context,
        timeoutMs: msg.timeoutMs,
      },
      forwardingBridges(msg.runId),
      stop.signal
    );
    send({ type: "done", runId: msg.runId, ok: true, value });
  } catch (err) {
    send({
      type: "done",
      runId: msg.runId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running.delete(msg.runId);
  }
}

/**
 * After its bridge waits end, how long a cancelled run gets to stop before its
 * isolate is disposed. Disposing an isolate still blocked in a bridge wait
 * (`applySyncPromise`) crashed the runner (SIGSEGV, devbox 2026-10-26); once
 * the wait is answered the isolate is back in JS, where disposal is the
 * documented way to stop it.
 */
const DISPOSE_AFTER_CANCEL_MS = 250;

/** Stop a run past its limit: its bridge waits end, then its isolate is disposed. */
function cancel(runId: string) {
  for (const [callId, call] of pending) {
    if (call.runId !== runId) continue;
    pending.delete(callId);
    call.reject(new Error("The skill ran past its time limit."));
  }
  setTimeout(() => running.get(runId)?.abort(), DISPOSE_AFTER_CANCEL_MS);
}

process.on("message", (raw: unknown) => {
  const msg = raw as BrokerMessage;
  if (msg.type === "run") {
    void run(msg);
    return;
  }
  if (msg.type === "cancel") {
    cancel(msg.runId);
    return;
  }
  const call = pending.get(msg.callId);
  if (!call) return;
  pending.delete(msg.callId);
  if (msg.ok) call.resolve(msg.value);
  else call.reject(new Error(msg.error));
});

// The broker is our only reason to exist: when it goes, so do we.
process.on("disconnect", () => process.exit(0));

loadIvm().then(
  () => send({ type: "ready", pid: process.pid }),
  (err: unknown) => {
    const fatal: RunnerMessage = {
      type: "fatal",
      error: err instanceof Error ? err.message : String(err),
    };
    // Exit once the reason is on the wire, so the broker can say why.
    // @types/node types process.send without the (message, callback) overload.
    if (process.send)
      process.send(fatal, undefined, undefined, () => process.exit(1));
    else process.exit(1);
  }
);
