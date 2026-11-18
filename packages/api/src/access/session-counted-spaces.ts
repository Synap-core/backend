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
 *     reaches it.
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
import {
  grantDeniedKey,
  type GrantWriteInput,
} from "../utils/grant-write-check.js";

/** The two columns of a session the rule reads. */
export interface SessionPlace {
  workspaceId: string | null;
  projectId: string | null;
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
  if (session.workspaceId) return [session.workspaceId];
  if (!session.projectId) return [];
  return projectCountedSpaceIds(session.projectId);
}

/**
 * The space a write door checks the calling key's grant in, for a write on
 * this session: its own space; for a project-only session under a grant, the
 * first space it counts in where the grant permits this very write (null when
 * none does, so the gate refuses it as before). `write` is exactly what the
 * door's gate checks, minus the space. Without a grant (a signed-in person) or
 * for a session with a space, nothing is read.
 */
export async function sessionGrantWorkspaceId(
  session: SessionPlace,
  write: Omit<GrantWriteInput, "workspaceId">,
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<string | null> {
  if (session.workspaceId || !session.projectId || !grant) {
    return session.workspaceId;
  }
  for (const workspaceId of await projectCountedSpaceIds(session.projectId)) {
    if (!(await grantDeniedKey({ ...write, workspaceId }, grant))) {
      return workspaceId;
    }
  }
  return null;
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

/** READ half: a project-only session that counts in one of `spaces`. */
export function sessionCountsInSpacesWhere(spaces: string[]): SQL {
  return and(
    isNull(focusSessions.workspaceId),
    projectCountsInSpacesWhere(focusSessions.projectId, spaces)
  )!;
}

/**
 * READ half for a session's ROOM: a pod-wide channel minted as the room of a
 * session that counts in one of `spaces` — the mint's stamp
 * (`context_object_type = 'focus_session'`, `context_object_id` = the session)
 * AND the session's `channel_id` pointing back, the pair
 * `session-visibility.ts` explains (each alone is forgeable; a BORROWED
 * channel is never reached through its session).
 */
export function sessionRoomCountsInSpacesWhere(spaces: string[]): SQL {
  return and(
    isNull(channels.workspaceId),
    eq(channels.contextObjectType, "focus_session"),
    exists(
      db
        .select({ one: drizzleSql`1` })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.id, channels.contextObjectId),
            eq(focusSessions.channelId, channels.id),
            sessionCountsInSpacesWhere(spaces)
          )
        )
    )
  )!;
}
