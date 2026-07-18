/**
 * CP Project Sync Trigger (P4-lite Wave 1) — IoC slot.
 *
 * ProjectRepository (the ONE mutation door for projects) calls
 * `triggerCpProjectSync()` after every create/update/delete so the pod's
 * project directory announcement to the Control Plane stays fresh between
 * the 30-minute reconcile ticks.
 *
 * @synap/database cannot import @synap/events (circular: events → database),
 * so the actual enqueue (`boss.send("cp-project-sync")`) is injected at boot
 * by @synap/jobs via `registerCpProjectSyncTrigger()` — the same IoC pattern
 * as the mail-feed/event-sync runners. When nothing is registered (tests,
 * scripts, pods without the jobs runtime) the trigger is a silent no-op.
 */

type CpProjectSyncTrigger = () => void | Promise<void>;

let trigger: CpProjectSyncTrigger | null = null;

/** Wired once at boot by @synap/jobs. Last registration wins. */
export function registerCpProjectSyncTrigger(fn: CpProjectSyncTrigger): void {
  trigger = fn;
}

/**
 * Fire-and-forget: never throws, never blocks the mutation that called it.
 * The sync job itself is cheap and idempotent (full-list push), so losing a
 * tick is harmless — the periodic reconcile catches up.
 */
export function triggerCpProjectSync(): void {
  if (!trigger) return;
  try {
    void Promise.resolve(trigger()).catch(() => {
      /* swallowed — reconcile cron is the safety net */
    });
  } catch {
    /* swallowed — reconcile cron is the safety net */
  }
}
