/**
 * The spaces a focus session COUNTS IN for a key's grant — ONE rule, read and
 * write (founder decision of 18 Nov 2026, "count the project's spaces",
 * amending decision e1b59d38 "B").
 *
 *   - a session with a space of its own counts in THAT space, and only there;
 *   - a session with no space, filed in a project (a "project-only" session),
 *     counts in every space the project uses: its home space
 *     (`projects.workspace_id`) and each `project --uses--> workspace` edge
 *     (`project_use_workspace`, `utils/project-workspace.ts`);
 *   - a session with neither counts in no space: a key pinned to spaces never
 *     reaches it;
 *   - a session the SPACE LADDER placed by a rung that stands in for "no
 *     space" (W3, decision D2 a: `PROJECT_REACH_RUNGS` — playbook, subject,
 *     parent, project home) counts in its own space AND, when it is filed in
 *     a project, in every space the project uses: it had no space before the
 *     ladder, and no app loses a session it reached then. A space the caller
 *     pinned, or the agent's focus, keeps the one-space rule.
 *
 * Why: 36 of the founder's 50 open sessions were project-only, and every door
 * that bounds a pinned key by the session's own space (`permits`,
 * `grammar.data.ts`: a space pin needs the request's space in the pin) refused
 * them all, so an app granted `session.update` on the project's space could
 * neither post in their rooms nor answer their asks.
 *
 * Two halves, side by side so they cannot drift:
 *   - WRITE: {@link sessionGrantWorkspaceId} — the space a write door checks
 *     the key's grant in (the gate's `grantWorkspaceId`, rung 0 only: the
 *     session's governance home is untouched, so the write still applies or
 *     proposes as the key's actsAs says);
 *   - READ: {@link sessionCountsInSpacesWhere} / {@link
 *     sessionRoomCountsInSpacesWhere} — the `spaceReach` of the `session` and
 *     `channel` grant read specs (`grant-read.ts`).
 * Both read the same two sources through {@link projectCountsInSpacesWhere}'s
 * columns; `session-counted-spaces.pglite.test.ts` holds them equal.
 *
 * The `uses` edge was an INDEX, not an ACL. With this rule it widens what a
 * pinned key reaches, so an APP never writes one (`linkProjectToWorkspace`
 * refuses under an app's grant): only the person, or their own AI, decides
 * which spaces a project runs through.
 */

import {
  and,
  asc,
  db,
  drizzleSql,
  eq,
  exists,
  getRequestGrant,
  inArray,
  isNull,
  or,
  PROJECT_REACH_RUNGS,
  readWorkspacePlacementRung,
  SESSION_WORKSPACE_PLACEMENT_KEY,
  type KeyGrant,
  type SQL,
} from "@synap/database";
import {
  channels,
  focusSessions,
  links,
  projects,
} from "@synap/database/schema";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { holderOfGrant } from "@synap-core/types/grants";
import {
  grantDeniedKey,
  type GrantWriteInput,
} from "../utils/grant-write-check.js";

/** The three columns of a session the rule reads. */
export interface SessionPlace {
  workspaceId: string | null;
  projectId: string | null;
  /** Its `metadata`: the placement stamp says whether the ladder placed it. */
  metadata: unknown;
}

/** Did a rung that stands in for "no space" place this session (D2 a)? */
export function sessionKeepsProjectReach(metadata: unknown): boolean {
  const rung = readWorkspacePlacementRung(metadata);
  return rung !== null && false;
}

/**
 * The project whose spaces this session counts in beyond its own (a
 * project-only session, or one that keeps its project's reach), else null.
 */
function reachProjectId(session: SessionPlace): string | null {
  return session.projectId &&
    (!session.workspaceId || sessionKeepsProjectReach(session.metadata))
    ? session.projectId
    : null;
}

/**
 * The `uses` edges of a project (the typed shape `listWorkspacesUsedByProjects`
 * reads). Built on call, never at module load: a suite that mocks the database
 * barrel still loads every door that imports this module.
 */
const usesEdge = () =>
  and(
    eq(links.fromType, "project"),
    eq(links.toType, "workspace"),
    eq(links.linkType, "uses")
  );

/**
 * The spaces a project counts in: its home first, then every space it uses,
 * oldest edge first. No visibility floor: this is where a session COUNTS, and
 * a grant only ever narrows what its holder's own floor already reads.
 */
export async function projectCountedSpaceIds(
  projectId: string
): Promise<string[]> {
  const [home] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  // A project that is not there counts nowhere, whatever edge outlived it.
  if (!home) return [];
  const used = await db
    .select({ workspaceId: links.toId })
    .from(links)
    .where(and(usesEdge(), eq(links.fromId, projectId)))
    .orderBy(asc(links.createdAt), asc(links.id));
  const out: string[] = [];
  for (const id of [home.workspaceId, ...used.map((u) => u.workspaceId)]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The spaces a session counts in (see the module doc). */
export async function sessionCountedSpaceIds(
  session: SessionPlace
): Promise<string[]> {
  const own = session.workspaceId ? [session.workspaceId] : [];
  const projectId = reachProjectId(session);
  if (!projectId) return own;
  const spaces = await projectCountedSpaceIds(projectId);
  return [...own, ...spaces.filter((id) => !own.includes(id))];
}

/**
 * The space a write door checks the calling key's grant in, for a write on
 * this session: its own space; for a project-only session, or one that keeps
 * its project's reach, under a grant, the first space it counts in (its own
 * first) where the grant permits this very write (else its own space, null for a project-only one,
 * so the gate refuses it as before). `write` is exactly what the door's gate
 * checks, minus the space. Without a grant (a signed-in person) or for a
 * session that counts only in its own space, nothing is read.
 */
export async function sessionGrantWorkspaceId(
  session: SessionPlace,
  write: Omit<GrantWriteInput, "workspaceId">,
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<string | null> {
  if (!grant || !reachProjectId(session)) {
    return session.workspaceId;
  }
  for (const workspaceId of await sessionCountedSpaceIds(session)) {
    if (!(await grantDeniedKey({ ...write, workspaceId }, grant))) {
      return workspaceId;
    }
  }
  return session.workspaceId;
}

/**
 * READ half: a `projectId` column whose project counts in one of `spaces`
 * (home there, or a `uses` edge to it). The same two sources as
 * {@link projectCountedSpaceIds}, and like it, a project that is not there
 * counts nowhere.
 *
 * NOT correlated on purpose: a relational read (`db.query.focusSessions`)
 * aliases the outer table (`"focusSessions"`), and a column named inside a
 * subquery is rendered with the table's real name, which that query cannot
 * see ("invalid reference to FROM-clause entry"). Only `projectIdColumn`
 * itself stands outside the subquery.
 */
export function projectCountsInSpacesWhere(
  projectIdColumn: AnyPgColumn,
  spaces: string[]
): SQL {
  return inArray(
    projectIdColumn,
    db
      .select({ id: projects.id })
      .from(projects)
      .where(
        or(
          inArray(projects.workspaceId, spaces),
          inArray(
            // `links.from_id` is text (polymorphic): cast the uuid side.
            drizzleSql`${projects.id}::text`,
            db
              .select({ id: links.fromId })
              .from(links)
              .where(and(usesEdge(), inArray(links.toId, spaces)))
          )
        )
      )
  );
}

/** SQL twin of {@link sessionKeepsProjectReach} (never NULL). */
export function sessionKeepsProjectReachSql(): SQL {
  return drizzleSql`coalesce((${focusSessions.metadata} -> ${SESSION_WORKSPACE_PLACEMENT_KEY} ->> 'rung') in (${drizzleSql.join(
    PROJECT_REACH_RUNGS.map((r) => drizzleSql`${r}`),
    drizzleSql`, `
  )}), false)`;
}

/**
 * READ half: a project-only session, or one that keeps its project's reach,
 * whose project counts in one of `spaces` (a session counts in its own space
 * through the grant's plain space read).
 */
export function sessionCountsInSpacesWhere(spaces: string[]): SQL {
  return and(
    or(isNull(focusSessions.workspaceId), sessionKeepsProjectReachSql()),
    projectCountsInSpacesWhere(focusSessions.projectId, spaces)
  )!;
}

/**
 * READ half for a session's ROOM: the channel minted as the room of a
 * session that counts in one of `spaces` — the mint's stamp
 * (`context_object_type = 'focus_session'`, `context_object_id` = the session)
 * AND the session's `channel_id` pointing back, the pair
 * `session-visibility.ts` explains (each alone is forgeable; a BORROWED
 * channel is never reached through its session) — and in the session's own
 * space (pod-wide for a project-only session; the session's space for one
 * that keeps its project's reach, as the mint and a move keep it).
 */
export function sessionRoomCountsInSpacesWhere(spaces: string[]): SQL {
  return and(
    eq(channels.contextObjectType, "focus_session"),
    exists(
      db
        .select({ one: drizzleSql`1` })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.id, channels.contextObjectId),
            eq(focusSessions.channelId, channels.id),
            // uuid on channels, text on focus_sessions.
            drizzleSql`${channels.workspaceId}::text IS NOT DISTINCT FROM ${focusSessions.workspaceId}`,
            sessionCountsInSpacesWhere(spaces)
          )
        )
    )
  )!;
}

/**
 * Is the request bounded by an APP's grant? Such a request never adds a space
 * to a project (`linkProjectToWorkspace` refuses it): a `uses` edge widens
 * every pinned grant's reach over the project's sessions (this module), so
 * which spaces a project runs through stays the person's call.
 */
export function requestIsAnAppGrant(
  grant: KeyGrant | undefined = getRequestGrant()
): boolean {
  return !!grant && holderOfGrant(grant) === "app";
}
