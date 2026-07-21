/**
 * resolve-capture-project — the project NAME-ref resolver for capture.
 *
 * A capture plan may reference a project by NAME (`{ project: { name } }`)
 * instead of a UUID. Projects are TABLE ROWS (migration 0151), NOT entities, so
 * this does NOT reuse the entity `resolveIdentity` path — it's a tiny lookup on
 * `projects`, scoped to the caller's own rows, keyed by the unique-per-user
 * `slug` (`slugifyProjectName`).
 *
 * THE WIDENING-ACCESS LAW (project-resolution-service.ts head comment):
 * `belongs_to_project` WIDENS cross-workspace access. So:
 *   - EXACT slug match on the caller's OWN project ⇒ a deterministic, explicit
 *     pin (equivalent to rung-1 `resolveProjectPlacement`) → return its id.
 *   - NO match ⇒ NEVER auto-link an AI-guessed project → return the name as an
 *     advisory candidate for the caller to surface / confirm, never a silent id.
 */

import { db, projects, and, eq, slugifyProjectName } from "@synap/database";

export interface ResolveCaptureProjectResult {
  /** Set ONLY on an exact slug match on the caller's own project (rung-1 pin). */
  projectId?: string;
  /** Set when the name matched nothing — advisory only, NEVER auto-linked. */
  candidateName?: string;
}

/**
 * Resolve a project NAME to the caller's own project id via exact slug match.
 * No match → advisory candidate (never auto-linked). Best-effort: a lookup
 * failure surfaces the name as a candidate rather than throwing.
 */
export async function resolveCaptureProjectRef(input: {
  userId: string;
  projectName: string;
}): Promise<ResolveCaptureProjectResult> {
  const name = input.projectName.trim();
  if (!name) return {};
  const slug = slugifyProjectName(name);
  try {
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.userId, input.userId), eq(projects.slug, slug)))
      .limit(1);
    if (row?.id) return { projectId: row.id };
  } catch {
    // Fall through to advisory — a lookup hiccup must never auto-link a guess.
  }
  return { candidateName: name };
}
