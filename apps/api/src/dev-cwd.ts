/**
 * Dev working-directory resolution — SESSION-keyed, workspace-fallback.
 *
 * WHY THIS IS NOT KEYED ON THE WORKSPACE. This resolver used to be
 * `resolveWorkspaceCwd(workspaceId)` and read only
 * `workspace.settings.devplane.workspacePath`. That means two concurrent dev
 * sessions in the SAME workspace resolve to the SAME checkout — two agents
 * writing one tree. This repo has a recorded incident of exactly that
 * (an agent's `git checkout -- <dir>` destroyed a peer session's uncommitted
 * work), and the whole spawn design rests on one-writer-per-worktree.
 *
 * So the session gets to carry its OWN checkout path, and the workspace value
 * remains the fallback for the single-session case:
 *
 *   focus_sessions.metadata.devplane.workspacePath   (per session — wins)
 *   workspaces.settings.devplane.workspacePath       (per workspace — fallback)
 *   $HOME                                            (last resort)
 *
 * The per-session slot is the EXISTING free-form `focus_sessions.metadata` bag
 * (schema/focus-sessions.ts) — the same shallow-merged bag `grantStatus` and
 * `automationChainContext` live in. No column and no migration: it is written
 * through the session-update doors that already merge `metadata`.
 *
 * CROSS-WORKSPACE GUARD: a session's path is honoured only when the session
 * belongs to the workspace the caller resolved. A sessionId from another
 * workspace must never redirect a spawn's checkout.
 */

import { db, eq } from "@synap/database";
import { workspaces, focusSessions } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "dev-cwd" });

/** Read `<bag>.devplane.workspacePath` out of an untyped settings/metadata bag. */
function readDevplanePath(bag: unknown): string | null {
  const root = (bag ?? {}) as Record<string, unknown>;
  const devplane = (root["devplane"] ?? {}) as Record<string, unknown>;
  const value = devplane["workspacePath"];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

/**
 * Resolve the working directory for a dev spawn.
 *
 * @param workspaceId  the workspace the spawn is scoped to (fallback path).
 * @param sessionId    the focus session driving the spawn, when there is one.
 *                     Callers with no session (the interactive local terminal)
 *                     omit it and get the pre-existing workspace behaviour.
 */
export async function resolveDevCwd(
  workspaceId: string,
  sessionId?: string | null
): Promise<string> {
  if (sessionId) {
    try {
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, sessionId),
        columns: { metadata: true, workspaceId: true },
      });
      if (session) {
        // Only a session that belongs to this workspace may redirect the cwd.
        const sameWorkspace =
          !session.workspaceId || session.workspaceId === workspaceId;
        const sessionPath = readDevplanePath(session.metadata);
        if (sameWorkspace && sessionPath) return sessionPath;
        if (!sameWorkspace && sessionPath) {
          logger.warn(
            { sessionId, workspaceId, sessionWorkspaceId: session.workspaceId },
            "Ignoring session checkout path — session belongs to another workspace"
          );
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to resolve session cwd");
    }
  }

  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });
    const workspacePath = readDevplanePath(workspace?.settings);
    if (workspacePath) return workspacePath;
  } catch (err) {
    logger.warn({ err, workspaceId }, "Failed to resolve workspace cwd");
  }

  return process.env["HOME"] ?? "/";
}
