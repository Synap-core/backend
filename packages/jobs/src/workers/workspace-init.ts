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

  const {
    ensureDefaultWhiteboard,
    ensureDefaultViews,
    ensureDefaultCommands,
    ensureDefaultRelationDefs,
  } = await import("@synap/database");

  // Whiteboard + commands + relation defs always run. Default views only for non-template/non-package workspaces.
  const tasks: Array<{ name: string; promise: Promise<any> }> = [
    {
      name: "whiteboard",
      promise: ensureDefaultWhiteboard(workspaceId, userId),
    },
    { name: "commands", promise: ensureDefaultCommands(workspaceId, userId) },
    {
      name: "relation-defs",
      promise: ensureDefaultRelationDefs(workspaceId, userId),
    },
  ];

  // Always run ensureDefaultViews — it is idempotent and only creates what is missing.
  // Template workspaces define their own views; ensureDefaultViews will skip those
  // and only add the Home bento if the template didn't include one.
  tasks.push({
    name: "views",
    promise: ensureDefaultViews(workspaceId, userId),
  });

  const results = await Promise.allSettled(tasks.map((t) => t.promise));

  const resultMap: Record<string, string> = {};
  tasks.forEach((t, i) => {
    resultMap[t.name] = results[i].status;
  });

  logger.info(
    { workspaceId, ...resultMap },
    "Workspace initialization complete"
  );
}
