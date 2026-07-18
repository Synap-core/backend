/**
 * ProjectResolutionService — the "which PROJECT does this land in?" door, the
 * cross-cutting SIBLING of `WorkspaceResolutionService`. Kept beside it in
 * @synap/database (not @synap/api) for the same reason: @synap/jobs (the
 * materializer) can't import @synap/api, so every producer — api handlers, jobs
 * workers — must reach the SAME placement logic.
 *
 * WHY THIS DOOR EXISTS — the security law it enforces:
 * `belongs_to_project` WIDENS access. `accessScopeWhere` (api/utils/project-scope)
 * unions project-member exposure ACROSS workspaces, so filing an entity into a
 * project exposes it to every member of that project, in every workspace. An
 * AI-GUESSED project must therefore NEVER be auto-linked. This resolver returns
 * ONLY a DETERMINISTIC placement derived from real context (an explicit pin, a
 * bound session/channel, or the actual `belongs_to_project` edges of the entities
 * this one is being created alongside). It has NO AI rung: the AI's project
 * suggestion is handled by the CALLER as a propose/advisory chip, never routed
 * through here into an auto-link.
 *
 * ORTHOGONAL to workspace: this is deliberately a separate service, never a rung
 * of `resolveWorkspacePlacement` (whose contract explicitly excludes `projectId`
 * — "never derive a workspace from a project", and vice-versa).
 *
 * RESOLUTION ≠ WRITE: this only RESOLVES. The one write door stays
 * `linkEntityToProject` (utils/entity-project-membership) — the caller stamps the
 * membership edge with whatever this returns.
 *
 * The ladder (first definitive rung wins; no AI rung):
 *   1. Explicit    — the caller passed a project (a pinned lens / surface override).
 *   2. Session     — the active focus session's `projectId`.
 *   3. Channel     — the bound channel's `projectId`.
 *   4. Relational  — the MAJORITY project among the `belongs_to_project` edges of
 *                    the entities this one is being linked/related to IN THE SAME
 *                    batch. One bounded hop only — never a wider graph walk. A tie
 *                    (no strict majority) yields NO placement (honest abstain).
 */

import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { channels, focusSessions, relations } from "../schema/index.js";
import type * as schema from "../schema/index.js";
import { BELONGS_TO_PROJECT } from "../utils/entity-project-membership.js";

type Db = PostgresJsDatabase<typeof schema>;

export type ProjectResolutionRung = 1 | 2 | 3 | 4;

export interface ProjectPlacement {
  /** The resolved project TABLE id, or `null` when no deterministic context. */
  projectId: string | null;
  /** Which rung decided, or `null` when nothing resolved. */
  rung: ProjectResolutionRung | null;
  /** Code-generated, auditable reason. */
  reason: string;
}

export interface ResolveProjectPlacementInput {
  userId: string;
  /** Rung 1 — a deliberate project pin (active lens / surface override). */
  explicitProjectId?: string | null;
  /** Rung 2 — the active focus session; its `projectId` is consulted. */
  sessionId?: string | null;
  /** Rung 3 — a bound channel; its `projectId` is consulted. */
  channelId?: string | null;
  /**
   * Rung 4 — the entities THIS one is being linked/related to in the SAME
   * create/capture batch. Their existing `belongs_to_project` edges provide
   * relational gravity. Bounded to exactly these ids — no wider graph walk.
   */
  relatedEntityIds?: string[];
}

const NONE: ProjectPlacement = {
  projectId: null,
  rung: null,
  reason: "no deterministic project context",
};

/**
 * Resolve the DETERMINISTIC project placement for a piece of data — the one door.
 * Returns `{ projectId: null, rung: null }` when no real context pins a project;
 * the caller must NOT invent one (an AI suggestion is the caller's advisory lane,
 * never an auto-link).
 *
 * @param db  Schema-typed database handle (the caller's, so it shares the txn).
 */
export async function resolveProjectPlacement(
  db: Db,
  input: ResolveProjectPlacementInput
): Promise<ProjectPlacement> {
  // ── Rung 1 — explicit / deliberate pin (a project has no "pod-wide null", so a
  // nullish value simply means "not provided" and falls through). ──
  if (input.explicitProjectId) {
    return {
      projectId: input.explicitProjectId,
      rung: 1,
      reason: "explicit project supplied by the caller",
    };
  }

  // ── Rung 2 — the active focus session's project. ──
  if (input.sessionId) {
    const session = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, input.sessionId),
      columns: { projectId: true },
    });
    if (session?.projectId) {
      return {
        projectId: session.projectId,
        rung: 2,
        reason: "active focus session is scoped to this project",
      };
    }
  }

  // ── Rung 3 — the bound channel's project. ──
  if (input.channelId) {
    const channel = await db.query.channels.findFirst({
      where: eq(channels.id, input.channelId),
      columns: { projectId: true },
    });
    if (channel?.projectId) {
      return {
        projectId: channel.projectId,
        rung: 3,
        reason: "channel is bound to this project",
      };
    }
  }

  // ── Rung 4 — relational gravity: the MAJORITY project among the existing
  // `belongs_to_project` edges of the batch's related entities. One bounded hop.
  if (input.relatedEntityIds && input.relatedEntityIds.length > 0) {
    const rows = await db.query.relations.findMany({
      where: and(
        eq(relations.type, BELONGS_TO_PROJECT),
        inArray(relations.sourceEntityId, input.relatedEntityIds)
      ),
      columns: { targetEntityId: true },
    });
    const tally = new Map<string, number>();
    for (const r of rows) {
      if (!r.targetEntityId) continue;
      tally.set(r.targetEntityId, (tally.get(r.targetEntityId) ?? 0) + 1);
    }
    if (tally.size > 0) {
      let top: string | null = null;
      let topCount = 0;
      let tie = false;
      for (const [projectId, count] of tally) {
        if (count > topCount) {
          top = projectId;
          topCount = count;
          tie = false;
        } else if (count === topCount) {
          tie = true;
        }
      }
      // Only a STRICT majority pulls placement — a tie is an honest abstain.
      if (top && !tie) {
        return {
          projectId: top,
          rung: 4,
          reason:
            "the majority of related entities in this batch belong to this project",
        };
      }
    }
  }

  return NONE;
}
