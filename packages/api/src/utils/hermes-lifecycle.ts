/**
 * Hermes background-task lifecycle diff.
 *
 * Pure function that compares the previous task row against the IS-reported
 * delta (from `updateTaskExecution`) and returns the realtime events that
 * should fire. Extracted so the decision logic is unit-testable without
 * hitting the DB or Socket.IO bridge.
 *
 * Granularity rule (per eve-channels-design §5.2): emit only on macro
 * lifecycle transitions — started, completed, failed. Internal sub-agent
 * progress events do NOT pass through here.
 */

import type {
  HermesTaskCompletedEvent,
  HermesTaskFailedEvent,
  HermesTaskStartedEvent,
} from "@synap-core/types/events";

/** What we know about the task BEFORE the update applies. */
export interface HermesPrevTask {
  action: string;
  workspaceId?: string | null;
  lastRunAt?: Date | null;
  successCount?: number;
  failureCount?: number;
  errorMessage?: string | null;
}

/** Subset of the `updateTaskExecution` input we actually inspect. */
export interface HermesUpdateInput {
  taskId: string;
  lastRunAt?: Date;
  successCount?: number;
  failureCount?: number;
  errorMessage?: string;
  status?: "active" | "paused" | "error";
}

/**
 * Tagged union of lifecycle emits. Each variant carries the event name and
 * payload — caller invokes `emitTyped(name, payload, target)` per item.
 */
export type HermesLifecycleEmit =
  | { event: "hermes:task:started"; payload: HermesTaskStartedEvent }
  | { event: "hermes:task:completed"; payload: HermesTaskCompletedEvent }
  | { event: "hermes:task:failed"; payload: HermesTaskFailedEvent };

/**
 * Compare `prev` (DB row before the update) against `input` (the update
 * payload IS just sent) and return any lifecycle emits that fire.
 *
 * Order/precedence:
 *   1. Started   — new `lastRunAt` distinct from prev's.
 *   2. Failed    — failureCount up, errorMessage set, or status="error".
 *      Failed wins over Completed when both signals are set in the same
 *      update (defensive: an IS that bumps both counters is clearly
 *      reporting a failure).
 *   3. Completed — successCount went up.
 *
 * `now` is injected to keep the function pure (tests pass a fixed clock).
 */
export function diffHermesLifecycle(
  prev: HermesPrevTask | null,
  input: HermesUpdateInput,
  now: Date = new Date()
): HermesLifecycleEmit[] {
  const out: HermesLifecycleEmit[] = [];
  const kind = prev?.action ?? "unknown";

  // STARTED — IS just stamped a new lastRunAt (claimed the run).
  if (
    input.lastRunAt &&
    (!prev?.lastRunAt || input.lastRunAt.getTime() !== prev.lastRunAt.getTime())
  ) {
    out.push({
      event: "hermes:task:started",
      payload: {
        taskId: input.taskId,
        kind,
        startedAt: input.lastRunAt.toISOString(),
      },
    });
  }

  // FAILED — failureCount went up, errorMessage was set, or status flipped.
  const failed =
    (input.failureCount !== undefined &&
      input.failureCount > (prev?.failureCount ?? 0)) ||
    (input.errorMessage !== undefined && input.errorMessage.length > 0) ||
    input.status === "error";

  if (failed) {
    out.push({
      event: "hermes:task:failed",
      payload: {
        taskId: input.taskId,
        error: input.errorMessage ?? prev?.errorMessage ?? "unknown error",
        failedAt: now.toISOString(),
      },
    });
    return out; // Failed is terminal — don't also emit completed.
  }

  // COMPLETED — successCount incremented.
  if (
    input.successCount !== undefined &&
    input.successCount > (prev?.successCount ?? 0)
  ) {
    const baseStart = prev?.lastRunAt ?? input.lastRunAt ?? now;
    const durationMs = Math.max(0, now.getTime() - baseStart.getTime());
    out.push({
      event: "hermes:task:completed",
      payload: {
        taskId: input.taskId,
        durationMs,
        completedAt: now.toISOString(),
      },
    });
  }

  return out;
}
