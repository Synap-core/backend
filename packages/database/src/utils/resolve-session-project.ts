/**
 * `resolveSessionProjectPlacement` — the ONE "gather a session's real context,
 * then ask the ladder" shape.
 *
 * WHY IT EXISTS: every `project_id` column in the pod already had a live
 * producer AND a live consumer, yet fill rates sat at 0–10%. The severance was
 * upstream of all of them — **every producer waited to be handed a project and
 * nothing derived one**. `resolveProjectPlacement` (the deterministic ladder)
 * was called from the two EDGE writers only; no CONTAINER producer consulted it.
 *
 * The two session containers — `openRunSession` (@synap/database, the
 * automation/agent run door) and `createFocusSession` (@synap/api, the
 * human/agent start door) — hold the SAME four pieces of real context, so the
 * gather lives here once rather than being pasted at both. Extracting it also
 * means a rung added to the ladder reaches both doors at the same time.
 *
 * WHAT IT MAY NEVER DO: infer. There is no AI rung, no "the only project"
 * fallback, no "most recent project". `NONE` → `null` is a SAFETY PROPERTY, not
 * a gap: workspace may default, project must not, because filing into a project
 * is an exposure decision. Every input below is a fact the producer already
 * holds — never a guess assembled to make a rung fire.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import {
  resolveProjectPlacement,
  type ProjectPlacement,
} from "../services/project-resolution-service.js";

export interface SessionProjectContext {
  userId: string;
  /** Rung 1 — whatever project the caller actually passed. Always wins. */
  explicitProjectId?: string | null;
  /**
   * Rung 2 — the session this one was pushed from (a detour / a run spawned by
   * another run). A child inherits its parent's PLACEMENT (never its
   * governance metadata — see `openRunSession`).
   */
  parentSessionId?: string | null;
  /** Rung 3 — the channel this session is bound to. */
  channelId?: string | null;
  /**
   * Rung 4 — the entity this session is ABOUT. Exactly one bounded id, so the
   * ladder's strict-majority test degenerates to "the subject's own project, if
   * it has exactly one". A subject in two projects is a tie → honest abstain.
   */
  subjectEntityId?: string | null;
}

export async function resolveSessionProjectPlacement(
  db: PostgresJsDatabase<typeof schema>,
  ctx: SessionProjectContext
): Promise<ProjectPlacement> {
  return resolveProjectPlacement(db, {
    userId: ctx.userId,
    explicitProjectId: ctx.explicitProjectId ?? null,
    sessionId: ctx.parentSessionId ?? null,
    channelId: ctx.channelId ?? null,
    ...(ctx.subjectEntityId ? { relatedEntityIds: [ctx.subjectEntityId] } : {}),
  });
}
