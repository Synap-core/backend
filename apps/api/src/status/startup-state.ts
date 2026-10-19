/**
 * The post-listen boot hooks' OUTCOME, not just "done": `/health` must never
 * read `ready` after the hooks THREW. One un-guarded early hook that throws
 * (`seedDefaultCorsOrigins`, `loadCorsOrigins`, …) skips every hook after it —
 * `ensureSystemProfiles` included — and a "settled" flag set in a `finally`
 * reported that broken boot as a calm success (the empty-vs-failed rule).
 *
 * `running` → `settled` (completed) | `failed` (threw). `settled` resolves
 * either way: a pass that waits for the hooks (the media-copy backfill) must
 * not hang on a failed boot.
 */
export type StartupHooksState = "running" | "settled" | "failed";

export interface StartupTracker {
  state(): StartupHooksState;
  /** Resolves once the run finished — completed OR failed. */
  settled: Promise<void>;
  /** Run the hooks once, recording how they ended; rethrows a failure. */
  run(hooks: () => Promise<void>): Promise<void>;
}

export function createStartupTracker(): StartupTracker {
  let state: StartupHooksState = "running";
  let resolve!: () => void;
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    state: () => state,
    settled,
    async run(hooks) {
      try {
        await hooks();
        state = "settled";
      } catch (err) {
        state = "failed";
        throw err;
      } finally {
        resolve();
      }
    },
  };
}
