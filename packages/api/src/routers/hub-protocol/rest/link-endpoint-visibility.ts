/**
 * The endpoint floor for the `links` write doors (`POST /links`, MCP
 * `synap_project_use_workspace`).
 *
 * A link names two objects by (type, id). Before this existed only workspace,
 * `uses`-project and `blocked_by`-session endpoints were checked; every other
 * id went straight to governance, so an agent could file an edge to an object
 * it cannot see and read its name back off its own proposal (the display name
 * batches are floored now, but a write door that accepts an invisible id is the
 * root of that oracle). So EVERY endpoint type is resolved here, BEFORE
 * governance, through the canonical read predicate for its table — the same one
 * the proposal display floor (`routers/proposals/display.ts`) and the table's
 * own routers use. Nothing here is a new predicate; each branch names its door.
 *
 * An invisible id and a nonexistent id get the IDENTICAL refusal: telling them
 * apart would turn the door into an existence oracle for other users' ids.
 *
 * Types with no canonical visibility check are REFUSED, never allowed by
 * default (`participant`, `source`).
 */

import { isLikelyUUID } from "@synap-core/types/proposals";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import {
  db,
  eq,
  and,
  or,
  isNull,
  getWorkspaceMembership,
} from "@synap/database";
import {
  workspaces,
  projects,
  playbooks,
  tools,
  automations,
  channels,
  intelligenceCommands,
  entities,
  documents,
  focusSessions,
  secrets,
  capabilities,
  agents,
  skills,
} from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { AccessContext, scopedDb } from "../../../access/index.js";
import {
  sessionDocumentReadableWhere,
  sessionReadableWhere,
} from "../../../access/session-visibility.js";
import {
  ownerPrivateVisibleWhere,
  userVisibleWhere,
} from "../../../utils/user-visible-where.js";
import { visibleSkillsWhere } from "../../../services/skills/visibility.js";
import { ownAdjunctFilter } from "../../../services/agent-identity-service.js";

export interface LinkEndpointRefusal {
  status: 403 | 404;
  error: string;
}

/**
 * The one refusal per type. It depends ONLY on the type the caller already
 * supplied — never on whether the id exists. `workspace` keeps its historical
 * 403 wording (the membership gate's), everything else is a 404.
 */
function refusalFor(type: string, id: string): LinkEndpointRefusal {
  if (type === "workspace") {
    return { status: 403, error: `Access denied to workspace ${id}` };
  }
  return { status: 404, error: `${resolveObjectNoun(type)} not found` };
}

/**
 * The `agents` REGISTRY rows a user may read: shared built-ins (`system`,
 * `provider`) or the caller's OWN adjunct, via the one owner door
 * `ownAdjunctFilter` — the floor `agents.get` applies (routers/agents.ts).
 * Exported so the proposal display floor names agents through the same rule.
 */
export function visibleAgentsWhere(userId: string): SQL {
  return or(
    eq(agents.ownerType, "system"),
    eq(agents.ownerType, "provider"),
    ownAdjunctFilter(userId)
  )!;
}

async function rowVisible(
  table: PgTable,
  idColumn: AnyPgColumn,
  id: string,
  ...floor: Array<SQL | undefined>
): Promise<boolean> {
  const rows = await db
    .select({ id: idColumn })
    .from(table)
    .where(and(eq(idColumn, id), ...floor))
    .limit(1);
  return rows.length > 0;
}

async function endpointVisible(
  type: string,
  id: string,
  userId: string,
  workspaceId: string | null
): Promise<boolean> {
  // A workspace endpoint is a WRITE into that lens, so it is held to the
  // membership gate (not merely pod-visibility) — unchanged from the door's
  // original check.
  if (type === "workspace") {
    if (!isLikelyUUID(id)) return false;
    const [live, membership] = await Promise.all([
      rowVisible(workspaces, workspaces.id, id, isNull(workspaces.archivedAt)),
      getWorkspaceMembership(db, id, userId),
    ]);
    return live && !!membership;
  }

  // Every remaining table-backed type is uuid-keyed; a non-uuid id cannot name
  // a row, and binding it to a uuid column would 500.
  if (!isLikelyUUID(id)) return false;

  // The user-wide access context the display floor uses (visibility, not focus).
  const access = scopedDb(AccessContext.operator({ userId }));

  switch (type) {
    // Registered `VisibilityRule`s (access/registry.ts) — the same
    // `scopedDb(access).predicate(table)` the display name batches read.
    case "playbook":
      return rowVisible(
        playbooks,
        playbooks.id,
        id,
        access.predicate(playbooks)
      );
    case "tool":
      return rowVisible(tools, tools.id, id, access.predicate(tools));
    case "automation":
      return rowVisible(
        automations,
        automations.id,
        id,
        access.predicate(automations)
      );
    case "channel":
      return rowVisible(channels, channels.id, id, access.predicate(channels));
    case "project":
      return rowVisible(projects, projects.id, id, access.predicate(projects));
    // `intelligenceCommands` rule: workspace-shared OR creator-private.
    case "command":
      return rowVisible(
        intelligenceCommands,
        intelligenceCommands.id,
        id,
        access.predicate(intelligenceCommands)
      );
    // The entity rule (`accessScopeWhere`: owner-gated NULL + membership +
    // exposure + facet lens). A soft-deleted entity is gone.
    case "entity":
      return rowVisible(
        entities,
        entities.id,
        id,
        access.predicate(entities),
        isNull(entities.deletedAt)
      );
    // Credential rows: `kind: "user"` (owner only).
    case "secret":
      return rowVisible(
        secrets,
        secrets.id,
        id,
        access.predicate(secrets),
        isNull(secrets.deletedAt)
      );
    // The ONE session read rule (decision D1). Both callers of this gate are
    // agent doors (Hub `POST /links`, MCP), so no roster branch: an agent can
    // only file an edge onto a session its principal OWNS.
    case "session":
      return rowVisible(
        focusSessions,
        focusSessions.id,
        id,
        sessionReadableWhere({ userId })
      );
    // ownerPrivate tables the display floor reads with the owner-aware floor.
    case "document":
      return rowVisible(
        documents,
        documents.id,
        id,
        ownerPrivateVisibleWhere(
          documents.workspaceId,
          documents.userId,
          userId
        ),
        // A session's document follows its session (D1), owner-only here.
        sessionDocumentReadableWhere(documents.id, { userId })
      );
    // Skills have no registry entry; `visibleSkillsWhere` is their canonical
    // read predicate. Pod + own-user tiers, plus the acting workspace's tier.
    case "skill":
      return rowVisible(
        skills,
        skills.id,
        id,
        or(
          visibleSkillsWhere(userId, undefined, { includeExpired: true }),
          ...(workspaceId
            ? [
                visibleSkillsWhere(userId, workspaceId, {
                  includeExpired: true,
                }),
              ]
            : [])
        )
      );
    // A capability CONTAINER (`capabilities`, pod config, no owner column):
    // `userVisibleWhere` on its workspace — the capability-containers router's
    // own read floor.
    case "capability":
      return rowVisible(
        capabilities,
        capabilities.id,
        id,
        userVisibleWhere(capabilities.workspaceId, userId)
      );
    // An `agents` REGISTRY row: shared built-ins or the caller's own adjunct —
    // the `agents.get` floor, through the one owner door `ownAdjunctFilter`.
    case "agent":
      return rowVisible(agents, agents.id, id, visibleAgentsWhere(userId));
    // `participant` (a users-table id) has no "users visible to me" predicate
    // anywhere in the codebase, and `source` has no table at all. Refused
    // rather than allowed by default.
    default:
      return false;
  }
}

/**
 * Resolve both endpoints of a link. Returns the refusal for the first endpoint
 * the caller may not see (or that does not exist), or null when both resolve.
 */
export async function checkLinkEndpointsVisible(
  endpoints: { fromType: string; fromId: string; toType: string; toId: string },
  userId: string,
  workspaceId: string | null
): Promise<LinkEndpointRefusal | null> {
  for (const [type, id] of [
    [endpoints.fromType, endpoints.fromId],
    [endpoints.toType, endpoints.toId],
  ] as const) {
    if (!(await endpointVisible(type, id, userId, workspaceId))) {
      return refusalFor(type, id);
    }
  }
  return null;
}
