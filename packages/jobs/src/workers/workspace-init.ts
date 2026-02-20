/**
 * Workspace Init Worker
 *
 * Creates default resources when a workspace is created:
 * - Default whiteboard
 * - Default views
 * - Default commands
 *
 * Ported from Inngest executors: default-whiteboard-executor.ts,
 * default-views-executor.ts, default-commands-executor.ts
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "workspace-init" });

export async function handleWorkspaceInit(
  job: PgBoss.Job<{
    workspaceId: string;
    userId: string;
  }>
): Promise<void> {
  const { workspaceId, userId } = job.data;

  logger.info({ workspaceId, userId }, "Initializing workspace defaults");

  const {
    ensureDefaultWhiteboard,
    ensureDefaultViews,
    ensureDefaultCommands,
  } = await import("@synap/database");

  const [whiteboardResult, viewsResult, commandsResult] = await Promise.allSettled([
    ensureDefaultWhiteboard(workspaceId, userId),
    ensureDefaultViews(workspaceId, userId),
    ensureDefaultCommands(workspaceId, userId),
  ]);

  logger.info(
    {
      workspaceId,
      whiteboard: whiteboardResult.status,
      views: viewsResult.status,
      commands: commandsResult.status,
    },
    "Workspace initialization complete"
  );
}
