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

import { TRPCError } from "@trpc/server";
import { db, projects, and, eq, slugifyProjectName } from "@synap/database";
import { ownerPrivateVisibleWhere } from "../../utils/user-visible-where.js";

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

/** A project the caller can see, offered when a pin names one it cannot. */
export interface CaptureProjectCandidate {
  id: string;
  name: string;
}

/** How many close projects a refusal names (the message must stay short). */
const CLOSEST_PROJECTS_MAX = 3;

/**
 * A capture pinned to a project the caller cannot see — REFUSED before anything
 * is filed. A `TRPCError` (NOT_FOUND) so every door already renders it: the
 * tRPC caller gets the code, Hub REST maps it to 404 with the message
 * (`httpStatusForTrpcError`), MCP returns the message as a recoverable tool
 * error (`toSafeToolError`). The message names the closest visible projects.
 */
export class CaptureProjectNotFoundError extends TRPCError {
  readonly projectId: string;
  readonly closestProjects: CaptureProjectCandidate[];
  constructor(projectId: string, closestProjects: CaptureProjectCandidate[]) {
    const named = closestProjects
      .map((p) => `"${p.name.slice(0, 40)}" (${p.id})`)
      .join(", ");
    super({
      code: "NOT_FOUND",
      message:
        `Capture refused — projectId ${projectId} is not a project you can see, so nothing was filed (no entity, no proposal). ` +
        (named
          ? `Closest projects you can see: ${named}. Re-send with one of these ids, or omit projectId to capture without a project.`
          : "You have no projects yet — omit projectId, or create the project first."),
    });
    this.name = "CaptureProjectNotFoundError";
    this.projectId = projectId;
    this.closestProjects = closestProjects;
  }
}

/** Same-position characters two ids share — a mistyped id keeps most of them. */
function idLikeness(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let n = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] === y[i]) n++;
  return n;
}

/**
 * THE capture project-pin check, shared by both capture write cores
 * (`submitCaptureGraph` and tRPC `capture.execute`), so every door inherits it.
 *
 * An explicit `projectId` must name a project the caller can SEE (the same
 * pod-wide-owner / workspace-member predicate the project list uses) — or the
 * whole capture is refused. It used to write every entity WITHOUT the project
 * and report `applied`, with `project: not_linked` deep in the receipt: the
 * records landed where a person browsing the project never sees them.
 * (`relations.target_entity_id` has no FK to `projects`, which is also why the
 * pin cannot simply be trusted.)
 */
export async function assertCaptureProjectPinVisible(
  database: typeof db,
  input: { userId: string; projectId: string }
): Promise<void> {
  const visible = ownerPrivateVisibleWhere(
    projects.workspaceId,
    projects.userId,
    input.userId
  );
  const [pinned] = await database
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), visible))
    .limit(1);
  if (pinned) return;
  const rows = await database
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(visible, eq(projects.status, "active")));
  const closest = [...rows]
    .sort(
      (a, b) =>
        idLikeness(b.id, input.projectId) - idLikeness(a.id, input.projectId) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, CLOSEST_PROJECTS_MAX);
  throw new CaptureProjectNotFoundError(input.projectId, closest);
}
