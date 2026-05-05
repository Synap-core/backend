/**
 * Hub Protocol - Background Tasks Router
 *
 * Thin wrapper around regular API endpoints.
 * Allows Intelligence Service to fetch and manage background tasks.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { backgroundTasksRouter as regularBackgroundTasksRouter } from "../background-tasks.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { emitTyped } from "../../utils/event-emit.js";
import { db, eq, backgroundTasks } from "@synap/database";
import {
  diffHermesLifecycle,
  type HermesLifecycleEmit,
} from "../../utils/hermes-lifecycle.js";

export const backgroundTasksRouter = router({
  /**
   * Get background tasks for user
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's list endpoint internally
   */
  getBackgroundTasks: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        status: z.enum(["active", "paused", "error", "all"]).optional(),
        type: z.enum(["cron", "event", "interval"]).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularBackgroundTasksRouter.createCaller(callerContext);

      // Call regular API's list endpoint
      const result = await caller.list({
        workspaceId: input.workspaceId,
        status: input.status || "all",
        type: input.type,
        limit: 100, // Get all tasks
      });

      return result.tasks;
    }),

  /**
   * Get a single background task by ID
   * Requires: hub-protocol.read scope
   */
  getBackgroundTask: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        taskId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularBackgroundTasksRouter.createCaller(callerContext);

      // Call regular API's get endpoint
      const result = await caller.get({
        id: input.taskId,
      });

      return result.task;
    }),

  /**
   * Update task execution tracking
   * Requires: hub-protocol.write scope
   *
   * Called by Intelligence Service after task execution
   */
  updateTaskExecution: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        taskId: z.string().uuid(),
        lastRunAt: z.date().optional(),
        nextRunAt: z.date().optional(),
        executionCount: z.number().optional(),
        successCount: z.number().optional(),
        failureCount: z.number().optional(),
        errorMessage: z.string().optional(),
        status: z.enum(["active", "paused", "error"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularBackgroundTasksRouter.createCaller(callerContext);

      // Snapshot the previous task row so we can detect transitions for the
      // Phase 3B Hermes lifecycle emits (started / completed / failed). The
      // tRPC `update` only accepts a subset of these fields, so the
      // execution-tracking deltas (lastRunAt / successCount / failureCount /
      // errorMessage) currently never reach DB via this path — see report.
      // We still emit on the *intent* signaled by the input, since IS is the
      // source of truth for run lifecycle.
      const prev = await db.query.backgroundTasks.findFirst({
        where: eq(backgroundTasks.id, input.taskId),
      });

      // Update task with execution results
      // Note: This is a direct update (not via events) for execution tracking
      // The task definition itself is updated via events, but execution tracking
      // can be updated directly for performance
      const { taskId, userId: _userId, ...updateData } = input;

      // For now, we'll use the update endpoint which goes through events
      // In the future, we might want a direct update endpoint for execution tracking
      await caller.update({
        id: taskId,
        ...updateData,
      });

      // ── Phase 3B: hermes:task:* lifecycle emits ─────────────────────────
      // Detected from IS-reported deltas in `input`. Granularity rule:
      // emit only on macro transitions, not internal sub-agent steps.
      // Decision logic lives in `utils/hermes-lifecycle.ts` so it can be
      // unit-tested without DB / bridge wiring.
      const target = {
        userId: input.userId,
        workspaceId: prev?.workspaceId ?? undefined,
      } as const;
      const emits: HermesLifecycleEmit[] = diffHermesLifecycle(
        prev
          ? {
              action: prev.action,
              workspaceId: prev.workspaceId,
              lastRunAt: prev.lastRunAt,
              successCount: prev.successCount,
              failureCount: prev.failureCount,
              errorMessage: prev.errorMessage,
            }
          : null,
        input
      );

      for (const emit of emits) {
        // Discriminated union: each branch narrows event+payload to a
        // matching pair so emitTyped's generic infers correctly.
        const dispatch = (() => {
          if (emit.event === "hermes:task:started") {
            return emitTyped(emit.event, emit.payload, target);
          }
          if (emit.event === "hermes:task:completed") {
            return emitTyped(emit.event, emit.payload, target);
          }
          return emitTyped(emit.event, emit.payload, target);
        })();
        void dispatch.catch((err) => {
          console.warn(`[hub-protocol] ${emit.event} emit failed`, err);
        });
      }

      return { success: true };
    }),
});
