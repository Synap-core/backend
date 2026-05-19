/**
 * Background Tasks Service
 *
 * Shared CRUD logic used by both the tRPC `backgroundTasks.*` router and the
 * Hub Protocol REST `/background-tasks` endpoints. Both surfaces validate
 * the same way, write the same audit events, and emit the same side-effects.
 *
 * Permission semantics: tasks are user-scoped. Every read/write filters on
 * `userId` so a Hub key never sees tasks owned by another user, even if the
 * caller fabricates an id.
 *
 * Action validation: `action` MUST be in the BACKGROUND_TASK_ACTIONS registry
 * — this is enforced HERE so tRPC and Hub REST cannot drift apart.
 */
import { randomUUID } from "crypto";
import { type SQL } from "drizzle-orm";
import { db, eq, and, desc, backgroundTasks } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";

import { auditLog } from "../utils/audit-log.js";
import { emitTyped } from "../utils/event-emit.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { isValidAction, listActions } from "./background-task-actions.js";

const logger = createLogger({ module: "background-tasks-service" });

/** Status discriminator from the schema enum. */
export type BackgroundTaskStatus = "active" | "paused" | "error";
export type BackgroundTaskType = "cron" | "event" | "interval";

/** Filters accepted by `listBackgroundTasks`. Mirrors the tRPC schema. */
export interface ListBackgroundTasksFilter {
  userId: string;
  workspaceId?: string;
  status?: BackgroundTaskStatus | "all";
  type?: BackgroundTaskType;
  limit?: number;
  offset?: number;
}

export interface CreateBackgroundTaskInput {
  userId: string;
  workspaceId?: string;
  name: string;
  description?: string;
  type: BackgroundTaskType;
  schedule?: string;
  action: string;
  context?: Record<string, unknown>;
}

export interface UpdateBackgroundTaskInput {
  id: string;
  userId: string;
  name?: string;
  description?: string;
  schedule?: string;
  action?: string;
  context?: Record<string, unknown>;
  status?: BackgroundTaskStatus;
  /** Optional explicit next-run-at (ISO string or Date). */
  nextRunAt?: Date | string;
}

/**
 * Custom error class for action-validation failures. Callers can catch this
 * specifically and surface the registry to the client. tRPC maps it to
 * BAD_REQUEST; Hub REST returns 400 with the action list in `details`.
 */
export class InvalidActionError extends Error {
  readonly validActions: Array<{ id: string; description: string }>;
  constructor(action: string) {
    super(
      `Invalid action '${action}'. Use one of the registered ids or 'custom' for free-form prompts.`
    );
    this.name = "InvalidActionError";
    this.validActions = listActions();
  }
}

/**
 * Custom error for forbidden permission outcomes — distinguishes "no access"
 * from "proposal-required" so Hub REST returns 403 vs 202.
 */
export class BackgroundTaskPermissionError extends Error {
  readonly kind: "denied" | "proposed";
  readonly proposalId?: string;
  constructor(args: {
    kind: "denied" | "proposed";
    reason?: string;
    proposalId?: string;
  }) {
    super(args.reason ?? args.kind);
    this.name = "BackgroundTaskPermissionError";
    this.kind = args.kind;
    this.proposalId = args.proposalId;
  }
}

/**
 * List tasks. Always includes `userId` as a filter — never trust the client
 * to scope, even on the Hub path.
 */
export async function listBackgroundTasks(
  filter: ListBackgroundTasksFilter
): Promise<{ tasks: (typeof backgroundTasks.$inferSelect)[] }> {
  const conditions: SQL[] = [eq(backgroundTasks.userId, filter.userId)];
  if (filter.workspaceId) {
    conditions.push(eq(backgroundTasks.workspaceId, filter.workspaceId));
  }
  if (filter.status && filter.status !== "all") {
    conditions.push(eq(backgroundTasks.status, filter.status));
  }
  if (filter.type) {
    conditions.push(eq(backgroundTasks.type, filter.type));
  }
  const rows = await db.query.backgroundTasks.findMany({
    where: and(...conditions),
    orderBy: [desc(backgroundTasks.createdAt)],
    limit: filter.limit ?? 50,
    offset: filter.offset ?? 0,
  });
  return { tasks: rows };
}

/**
 * Get one task. Returns null when the row exists but belongs to another
 * user — callers should treat this the same as "not found" so we don't leak
 * existence across user boundaries.
 */
export async function getBackgroundTask(args: {
  id: string;
  userId: string;
}): Promise<typeof backgroundTasks.$inferSelect | null> {
  const row = await db.query.backgroundTasks.findFirst({
    where: and(
      eq(backgroundTasks.id, args.id),
      eq(backgroundTasks.userId, args.userId)
    ),
  });
  return row ?? null;
}

/**
 * Create a task. Throws InvalidActionError on unknown action ids, and
 * BackgroundTaskPermissionError on denied/proposed outcomes.
 */
export async function createBackgroundTask(
  input: CreateBackgroundTaskInput
): Promise<{ id: string }> {
  if (!isValidAction(input.action)) {
    throw new InvalidActionError(input.action);
  }

  const taskId = randomUUID();

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    workspaceId: input.workspaceId,
    subjectType: "backgroundTask",
    action: "create",
    data: { id: taskId, name: input.name },
  });

  if ("denied" in perm && perm.denied) {
    throw new BackgroundTaskPermissionError({
      kind: "denied",
      reason: perm.reason,
    });
  }
  if ("proposalId" in perm) {
    throw new BackgroundTaskPermissionError({
      kind: "proposed",
      proposalId: perm.proposalId,
    });
  }

  const [task] = await db
    .insert(backgroundTasks)
    .values({
      id: taskId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      type: input.type,
      schedule: input.schedule,
      action: input.action,
      context: input.context ?? {},
      status: "active",
    })
    .returning();

  auditLog({
    subjectType: "backgroundTask",
    action: "create",
    phase: "completed",
    subjectId: task.id,
    userId: input.userId,
    workspaceId: input.workspaceId,
    data: { name: input.name, type: input.type, action: input.action },
  });

  emitSideEffects({
    subjectType: "backgroundTask",
    action: "create",
    subjectId: task.id,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });

  // Phase 3B: signal the eve-dashboard that a new Hermes task has entered
  // the queue. `kind` carries the action id (the registry-validated string
  // above), `source` is "user:<userId>" — Hermes runs are spawned by the
  // calling user from this surface; agent-spawned tasks would route via
  // their own emit site if they bypass this service.
  void emitTyped(
    "hermes:task:queued",
    {
      taskId: task.id,
      kind: input.action,
      source: `user:${input.userId}`,
      queuedAt: new Date().toISOString(),
    },
    {
      userId: input.userId,
      workspaceId: input.workspaceId,
    }
  ).catch((err) => {
    logger.warn(
      { err, taskId: task.id, event: "hermes:task:queued" },
      "emitTyped failed"
    );
  });

  return { id: task.id };
}

/**
 * Update a task. Validates ownership before touching the row. If `action`
 * is being changed, the new value must be in the registry.
 */
export async function updateBackgroundTask(
  input: UpdateBackgroundTaskInput
): Promise<void> {
  if (input.action !== undefined && !isValidAction(input.action)) {
    throw new InvalidActionError(input.action);
  }

  const existing = await getBackgroundTask({
    id: input.id,
    userId: input.userId,
  });
  if (!existing) {
    // Caller distinguishes 404 from other errors — throw a sentinel.
    const err = new Error("Background task not found");
    err.name = "BackgroundTaskNotFoundError";
    throw err;
  }

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    workspaceId: existing.workspaceId ?? undefined,
    subjectType: "backgroundTask",
    action: "update",
    data: { id: input.id },
  });
  if ("denied" in perm && perm.denied) {
    throw new BackgroundTaskPermissionError({
      kind: "denied",
      reason: perm.reason,
    });
  }
  if ("proposalId" in perm) {
    throw new BackgroundTaskPermissionError({
      kind: "proposed",
      proposalId: perm.proposalId,
    });
  }

  // Only set fields that were actually provided. Drizzle treats `undefined`
  // as "leave alone", but being explicit keeps the SQL minimal.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.schedule !== undefined) patch.schedule = input.schedule;
  if (input.action !== undefined) patch.action = input.action;
  if (input.context !== undefined) patch.context = input.context;
  if (input.status !== undefined) patch.status = input.status;
  if (input.nextRunAt !== undefined) {
    patch.nextRunAt =
      input.nextRunAt instanceof Date
        ? input.nextRunAt
        : new Date(input.nextRunAt);
  }

  await db
    .update(backgroundTasks)
    .set(patch)
    .where(
      and(
        eq(backgroundTasks.id, input.id),
        eq(backgroundTasks.userId, input.userId)
      )
    );

  auditLog({
    subjectType: "backgroundTask",
    action: "update",
    phase: "completed",
    subjectId: input.id,
    userId: input.userId,
    workspaceId: existing.workspaceId ?? undefined,
    data: patch,
  });

  emitSideEffects({
    subjectType: "backgroundTask",
    action: "update",
    subjectId: input.id,
    userId: input.userId,
    workspaceId: existing.workspaceId ?? undefined,
  });
}

export async function deleteBackgroundTask(args: {
  id: string;
  userId: string;
}): Promise<void> {
  const existing = await getBackgroundTask(args);
  if (!existing) {
    const err = new Error("Background task not found");
    err.name = "BackgroundTaskNotFoundError";
    throw err;
  }

  const perm = await checkPermissionOrPropose({
    userId: args.userId,
    workspaceId: existing.workspaceId ?? undefined,
    subjectType: "backgroundTask",
    action: "delete",
    data: { id: args.id },
  });
  if ("denied" in perm && perm.denied) {
    throw new BackgroundTaskPermissionError({
      kind: "denied",
      reason: perm.reason,
    });
  }
  if ("proposalId" in perm) {
    throw new BackgroundTaskPermissionError({
      kind: "proposed",
      proposalId: perm.proposalId,
    });
  }

  await db
    .delete(backgroundTasks)
    .where(
      and(
        eq(backgroundTasks.id, args.id),
        eq(backgroundTasks.userId, args.userId)
      )
    );

  auditLog({
    subjectType: "backgroundTask",
    action: "delete",
    phase: "completed",
    subjectId: args.id,
    userId: args.userId,
    workspaceId: existing.workspaceId ?? undefined,
    data: { id: args.id },
  });

  emitSideEffects({
    subjectType: "backgroundTask",
    action: "delete",
    subjectId: args.id,
    userId: args.userId,
    workspaceId: existing.workspaceId ?? undefined,
  });

  logger.debug(
    { taskId: args.id, userId: args.userId },
    "Background task deleted"
  );
}
