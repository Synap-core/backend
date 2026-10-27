/**
 * Evaluate one skill run in an isolated-vm isolate, with the given bridges as
 * its only way out. The ONE place that loads the addon (tripwire
 * `isolated-vm-lazy-import.test.ts`).
 *
 * Runs in a runner process (`skill-runner-child.ts`, production), where each
 * bridge forwards to the broker over IPC; or in the API process itself
 * (`inline` runner: tests and `pnpm dev` only), where each bridge is the
 * broker's own function. Either way this file never sees an identity: the
 * bridges carry it.
 */

// NOT a static import — see `loadIvm()` below.
import type IvmModule from "isolated-vm";
import { SKILL_STDLIB_BOOTSTRAP } from "../skill-stdlib.js";
import {
  FIRE_AND_FORGET_BRIDGES,
  SKILL_BRIDGE_NAMES,
  type SkillBridges,
  type SkillJob,
} from "./protocol.js";

/** Maximum memory an isolate may allocate, in MB (parity with the IS executor). */
export const ISOLATE_MEMORY_LIMIT_MB = 64;

/**
 * Load `isolated-vm` LAZILY — the fix for a production boot crash.
 *
 * A static `import ivm from "isolated-vm"` executed on every boot of the API,
 * because `execute-capability.ts` reaches this code statically, and crash-looped
 * a pod whose Node had no build of the addon (`No native build was found …`).
 * A flag that gates a call cannot gate a static import — only a dynamic one can.
 *
 * The failure is deliberately NOT swallowed: a skill asked to run in the pod
 * sandbox must fail loudly if the sandbox is unavailable. Silently falling back
 * to another executor would run untrusted code somewhere the caller did not ask
 * for.
 */
let ivmModulePromise: Promise<typeof IvmModule> | null = null;
export async function loadIvm(): Promise<typeof IvmModule> {
  if (!ivmModulePromise) {
    ivmModulePromise = import("isolated-vm")
      .then((m) => m.default ?? (m as unknown as typeof IvmModule))
      .catch((err: unknown) => {
        ivmModulePromise = null; // never cache a failure — a redeploy may fix it
        throw new Error(
          `The pod runs code skills but the isolated-vm native addon could not be loaded ` +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            `isolated-vm 6 ships builds for Node 22 and 24 only. SKILL_RUNTIME=is sends ` +
            `code skills back to the Intelligence Service sandbox (rollback).`
        );
      });
  }
  return ivmModulePromise;
}

/**
 * `signal` aborts the run from outside: the isolate is disposed, which stops
 * it even where its own `timeout` cannot (a skill waiting on a bridge).
 */
export async function evaluateSkill(
  job: SkillJob,
  bridges: SkillBridges,
  signal?: AbortSignal
): Promise<unknown> {
  const ivm = await loadIvm();
  const isolate = new ivm.Isolate({ memoryLimit: ISOLATE_MEMORY_LIMIT_MB });
  const stop = () => {
    if (!isolate.isDisposed) isolate.dispose();
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  // An object crosses into the isolate as a copy; a primitive as itself.
  const intoIsolate = (value: unknown) =>
    value !== null && typeof value === "object"
      ? new ivm.ExternalCopy(value).copyInto()
      : value;

  try {
    const vmContext = await isolate.createContext();
    const jail = vmContext.global;

    await jail.set("__args", new ivm.ExternalCopy(job.args).copyInto());
    await jail.set("__context", new ivm.ExternalCopy(job.context).copyInto());

    for (const name of SKILL_BRIDGE_NAMES) {
      const bridge = bridges[name];
      await jail.set(
        `__${name}`,
        new ivm.Reference(
          FIRE_AND_FORGET_BRIDGES.has(name)
            ? (...a: unknown[]) => {
                bridge(...a);
              }
            : async (...a: unknown[]) => intoIsolate(await bridge(...a))
        )
      );
    }

    // Bootstrap the co-located skill-runtime stdlib inside the isolate — installs
    // every host bridge + web polyfill and is the byte-equal twin of the IS SSOT.
    await vmContext.eval(SKILL_STDLIB_BOOTSTRAP);

    // Async wrapper so skills can use top-level await.
    const wrappedCode = `
      (async function(args, context) {
        ${job.code}
      })(__args, __context)
    `;

    const script = await isolate.compileScript(wrappedCode);

    const result = await script.run(vmContext, {
      timeout: job.timeoutMs,
      promise: true,
      copy: true,
    });

    if (result instanceof ivm.Reference) {
      return result.copy();
    }

    return result;
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
  }
}
