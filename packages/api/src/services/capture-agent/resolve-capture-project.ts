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
 *   - NO match ⇒ NEVER auto-link a guess, and never write WITHOUT the project
 *     either (decision B9e, 2026-10-21): the capture is REFUSED, naming the
 *     closest projects the caller can see — the same refusal an unknown id
 *     gets (`CaptureProjectNotFoundError`). It used to write every entity
 *     unlinked and report `not_linked (project-name-unmatched)`.
 */

import { TRPCError } from "@trpc/server";
import { db, projects, and, eq, slugifyProjectName } from "@synap/database";
import { ownerPrivateVisibleWhere } from "../../utils/user-visible-where.js";

/**
 * Resolve a project NAME to the caller's own project id via exact slug match.
 * No match → `CaptureProjectNotFoundError` (refused, nothing filed). A failed
 * read THROWS: it must never read as "no such project".
 */
export async function resolveCaptureProjectRef(
  database: typeof db,
  input: { userId: string; projectName: string }
): Promise<{ projectId: string }> {
  const name = input.projectName.trim();
  const slug = slugifyProjectName(name);
  const [row] = slug
    ? await database
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.userId, input.userId), eq(projects.slug, slug)))
        .limit(1)
    : [];
  if (row?.id) return { projectId: row.id };
  throw new CaptureProjectNotFoundError(
    { kind: "name", name },
    await closestVisibleProjects(database, input.userId, (p) =>
      nameLikeness(p.name, name)
    )
  );
}

/** A project the caller can see, offered when a pin names one it cannot. */
export interface CaptureProjectCandidate {
  id: string;
  name: string;
}

/** How many close projects a refusal names (the message must stay short). */
const CLOSEST_PROJECTS_MAX = 3;

/** What the capture named: an id it pinned, or a project name. */
export type CaptureProjectRef =
  { kind: "id"; projectId: string } | { kind: "name"; name: string };

/**
 * A capture pinned to a project the caller cannot see, or named one that does
 * not exist — REFUSED before anything is filed. A `TRPCError` (NOT_FOUND) so
 * every door already renders it: the tRPC caller gets the code, Hub REST maps
 * it to 404 with the message (`httpStatusForTrpcError`), MCP returns the
 * message as a recoverable tool error (`toSafeToolError`). The message names
 * the closest visible projects, with their ids.
 */
export class CaptureProjectNotFoundError extends TRPCError {
  readonly ref: CaptureProjectRef;
  /** The pinned id; `null` for a name ref. */
  readonly projectId: string | null;
  readonly closestProjects: CaptureProjectCandidate[];
  constructor(
    ref: CaptureProjectRef,
    closestProjects: CaptureProjectCandidate[]
  ) {
    const named = closestProjects
      .map((p) => `"${p.name.slice(0, 40)}" (${p.id})`)
      .join(", ");
    const what =
      ref.kind === "id"
        ? `projectId ${ref.projectId} is not a project you can see`
        : `no project of yours is named "${ref.name.slice(0, 60)}"`;
    super({
      code: "NOT_FOUND",
      message:
        `Capture refused — ${what}, so nothing was filed (no entity, no proposal). ` +
        (named
          ? `Closest projects you can see: ${named}. Re-send with projectId set to one of these ids, or omit the project to capture without one.`
          : "You have no projects yet — omit the project, or create it first (synap_create_project)."),
    });
    this.name = "CaptureProjectNotFoundError";
    this.ref = ref;
    this.projectId = ref.kind === "id" ? ref.projectId : null;
    this.closestProjects = closestProjects;
  }
}

/**
 * The caller's visible, active projects ranked by `score` (highest first),
 * capped — the ONE "closest projects" list both refusals name. Same visibility
 * predicate as the project list (`ownerPrivateVisibleWhere`).
 */
async function closestVisibleProjects(
  database: typeof db,
  userId: string,
  score: (p: CaptureProjectCandidate) => number
): Promise<CaptureProjectCandidate[]> {
  const rows = await database
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(
        ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId),
        eq(projects.status, "active")
      )
    );
  return [...rows]
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
    .slice(0, CLOSEST_PROJECTS_MAX);
}

/**
 * How close a project name is to the name a capture sent: containment first
 * ("Synap" ⊂ "Synap pod"), then shared words, then the shared prefix — enough
 * to put a typo or a shortened name at the top, deterministic, no fuzzy lib.
 */
function nameLikeness(projectName: string, asked: string): number {
  const a = projectName.toLowerCase().trim();
  const b = asked.toLowerCase().trim();
  if (!a || !b) return 0;
  let score = 0;
  if (a.includes(b) || b.includes(a)) score += 100;
  const words = new Set(a.split(/[^a-z0-9]+/).filter(Boolean));
  for (const w of b.split(/[^a-z0-9]+/)) if (w && words.has(w)) score += 10;
  let prefix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix])
    prefix++;
  return score + prefix;
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
  throw new CaptureProjectNotFoundError(
    { kind: "id", projectId: input.projectId },
    await closestVisibleProjects(database, input.userId, (p) =>
      idLikeness(p.id, input.projectId)
    )
  );
}
