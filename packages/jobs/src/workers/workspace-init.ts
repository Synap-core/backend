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
    templateName?: string;
    packageSlug?: string;
  }>
): Promise<void> {
  const { workspaceId, userId, templateName, packageSlug } = job.data;

  logger.info(
    { workspaceId, userId, templateName, packageSlug },
    "Initializing workspace defaults"
  );

  const { ensureDefaultWhiteboard, ensureDefaultViews, ensureDefaultCommands } =
    await import("@synap/database");

  // Whiteboard + commands always run. Default views only for non-template/non-package workspaces.
  const tasks: Array<{ name: string; promise: Promise<any> }> = [
    {
      name: "whiteboard",
      promise: ensureDefaultWhiteboard(workspaceId, userId),
    },
    { name: "commands", promise: ensureDefaultCommands(workspaceId, userId) },
  ];

  if (!templateName && !packageSlug) {
    tasks.push({
      name: "views",
      promise: ensureDefaultViews(workspaceId, userId),
    });
  } else {
    logger.info(
      { workspaceId, templateName, packageSlug },
      "Skipping default views — workspace created from template/package"
    );
  }

  const results = await Promise.allSettled(tasks.map((t) => t.promise));

  const resultMap: Record<string, string> = {};
  tasks.forEach((t, i) => {
    resultMap[t.name] = results[i].status;
  });
  if (templateName || packageSlug)
    resultMap.views = "skipped (template/package)";

  logger.info(
    { workspaceId, ...resultMap },
    "Workspace initialization complete"
  );
}
