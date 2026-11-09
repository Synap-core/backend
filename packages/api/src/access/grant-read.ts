/**
 * W1e — the READ half of grant enforcement.
 *
 * `scopedDb` ANDs `grantReadPredicate(table)` onto every scoped read. When the
 * request carries a grant (`getRequestGrant`, entered by the key-auth doors),
 * a row is visible only if the grant permits `<subject>[.<kind>].read` on it,
 * within its workspace / project / entity sets. Effective = grant ∩ the
 * visibility floor: this clause only ever NARROWS.
 *
 * Every table registered in the visibility registry needs a grant subject here
 * (`GRANT_READ_SPECS`); the tripwire `grant-read-coverage` derives the set from
 * the registry, so a newly scoped table cannot be read by a granted key until
 * someone names its subject. Until then it FAILS CLOSED (zero rows), unless
 * the grant is the explicit full-access `*`.
 *
 * Narrowing a table has no column for (a workspace-restricted grant on a
 * table with no workspace column, a project-restricted grant on a table with
 * no project path) also fails closed.
 *
 * SPACE REACH (founder "option 1", 2026-10-23). A grant restricted to spaces
 * X reads what a MEMBER of X reads there, not only the rows stamped with X: a
 * pod-wide person or company with a live role in X is X's data too, and so is
 * a pod-wide record filed FOR X (`home_workspace_id`, decision e1b59d38 "A",
 * 2026-10-30). The
 * tables whose member rule reaches past `workspace_id` say so in `spaceReach`
 * (entities, their facets, their bodies), built from the SAME space-keyed
 * builders the member floor uses (utils/project-scope.ts,
 * @synap/database facet-visibility.ts). The write gate (grant-write-check.ts)
 * checks the stored row's own workspace, except a ROLE write
 * (utils/role-write-grant.ts, D1 + founder decision 812ee060): checked in the
 * role's space, a shared role in the spaces it is granted to.
 */

import {
  db,
  getRequestGrant,
  inArray,
  isNull,
  or,
  podSharedFacetForSpacesWhere,
  type KeyGrant,
} from "@synap/database";
// Its own subpath: a test that mocks the `@synap/database` barrel must still
// load the real hook (a module-load call into a mock export broke 6 suites).
import { registerGrantReadProvider } from "@synap/database/grant-read-hook";
import {
  agentConfigs,
  apiKeys,
  artifacts,
  automationRuns,
  automations,
  boxRuns,
  hostJobs,
  installationBindings,
  installations,
  intentDefaults,
  cellInstances,
  channels,
  documents,
  entities,
  entityFacets,
  events,
  feeds,
  focusSessions,
  inboundDeliveries,
  inboxItems,
  intelligenceCommands,
  libraryGroups,
  links,
  mcpServers,
  messagingAccounts,
  notifications,
  playbookRuns,
  playbooks,
  profiles,
  projectTracks,
  projects,
  proposals,
  proposalSnoozes,
  trackParticipants,
  relationDefs,
  relations,
  rendererBindings,
  resourceShares,
  roles,
  secrets,
  sessionEvaluations,
  sessionRunners,
  sourceConfigs,
  sourceSubscriptions,
  tools,
  userPreferences,
  userResourceState,
  views,
  widgetDefinitions,
} from "@synap/database/schema";
import { and, eq, exists, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  allowedQualifiers,
  isNarrowedScope,
  patternMatches,
  QUALIFIED_GRANT_SUBJECTS,
  type GrantScope,
} from "@synap/governance-policy/grants";
import { grantRequestKey } from "@synap/governance-policy";
import {
  homeSpaceDocumentInSpacesWhere,
  homeSpaceInSpacesMemberWhere,
  podSharedDocumentInSpacesWhere,
  projectLensWhere,
  roleInSpacesWhere,
} from "../utils/project-scope.js";

export interface GrantReadSpec {
  /** The grant subject (governance spelling): `entity`, `document`, … */
  subject: string;
  idColumn?: AnyPgColumn;
  workspaceColumn?: AnyPgColumn;
  /** Qualified subjects: the kind columns (profile slug wins over legacy type). */
  kind?: { typeColumn: AnyPgColumn; profileIdColumn: AnyPgColumn };
  /** How a project-restricted grant narrows this table (entity id column). */
  projectEntityColumn?: AnyPgColumn;
  /**
   * What a space-restricted grant reaches BEYOND `workspaceColumn ∈ spaces`:
   * the rows a member of those spaces sees through a role (ORed with the
   * workspace match). Unset = the workspace match alone. `scope` is the
   * grant scope being read, for a row that follows ANOTHER table's grant
   * (a channel follows its person).
   */
  spaceReach?: (spaces: string[], scope: GrantScope) => SQL;
}

/** `subject` is folded to the grammar spelling (`relationDef` → `relation_def`). */
const spec = (
  subject: string,
  t: { id?: AnyPgColumn; workspaceId?: AnyPgColumn },
  extra: Partial<GrantReadSpec> = {}
): GrantReadSpec => ({
  subject: grantRequestKey(subject, "read").subject,
  idColumn: t.id,
  workspaceColumn: t.workspaceId,
  ...extra,
});

/** Grant subject of every scoped table. Keep in step with access/registry.ts. */
export const GRANT_READ_SPECS = new Map<object, GrantReadSpec>([
  [
    entities,
    spec("entity", entities, {
      kind: { typeColumn: entities.type, profileIdColumn: entities.profileId },
      projectEntityColumn: entities.id,
      // (a) a live facet stamped in a granted space, (b) a pod-wide entity
      // wearing a live pod-wide facet whose role is granted to one, or (c) a
      // pod-wide entity whose HOME is one (decision e1b59d38 "A").
      spaceReach: (spaces) =>
        or(
          roleInSpacesWhere(entities.workspaceId, entities.id, spaces),
          homeSpaceInSpacesMemberWhere(entities.workspaceId, spaces)
        )!,
    }),
  ],
  [
    documents,
    spec("document", documents, {
      // A document follows its entity, as for a member: the pod-wide body of
      // a pod-shared entity of the spaces (decision B only, rv-security B-4),
      // or of an entity homed in one (decision e1b59d38 "A").
      spaceReach: (spaces) =>
        or(
          podSharedDocumentInSpacesWhere(
            documents.workspaceId,
            documents.id,
            spaces
          ),
          homeSpaceDocumentInSpacesWhere(
            documents.workspaceId,
            documents.id,
            spaces
          )
        )!,
    }),
  ],
  // An edge between a space entity and a pod-wide one is stamped with that
  // space (lib/relation-workspace-inherit.ts). Beyond it, ONE pod-wide edge:
  // `works_at` from or to a record wearing a role in a granted space, both
  // ends read by the same scope (`worksAtRoleLinkWhere`, CRM G17).
  [
    relations,
    spec("relation", relations, {
      spaceReach: (spaces, scope) => worksAtRoleLinkWhere(spaces, scope),
    }),
  ],
  [
    entityFacets,
    spec("facet", entityFacets, {
      spaceReach: (spaces) => sharedRoleRowsInSpacesWhere(spaces),
    }),
  ],
  [views, spec("view", views)],
  [projects, spec("project", projects)],
  [projectTracks, spec("track", projectTracks)],
  // No workspace of its own: a grant on the GOAL reads who is on it.
  [
    trackParticipants,
    spec("track", {}, { idColumn: trackParticipants.trackId }),
  ],
  [proposals, spec("proposal", proposals)],
  // "Later" (0381): one person's setting aside of a request. No workspace of
  // its own: a grant on the REQUEST reads it; a space grant reads none.
  [
    proposalSnoozes,
    spec("proposal", {}, { idColumn: proposalSnoozes.proposalId }),
  ],
  [focusSessions, spec("session", focusSessions)],
  [sessionEvaluations, spec("session", sessionEvaluations)],
  // No id column (PK session × client key): a grant on the SESSION reads its
  // runners — who is attached to it — and nothing else.
  [sessionRunners, spec("session", {}, { idColumn: sessionRunners.sessionId })],
  [
    channels,
    spec("channel", channels, {
      // A channel bound to a person FOLLOWS the person (channels wave,
      // founder decision 3, 2026-11-02): a key granted `channel.read` in a
      // space reads the channel of every record that SAME scope reads there,
      // as a document follows its entity. The channel's own stamp is not
      // enough: a person's external channel is pod-wide (no space).
      spaceReach: (_spaces, scope) => channelFollowsEntityWhere(scope),
    }),
  ],
  [events, spec("event", events)],
  [automations, spec("automation", automations)],
  [automationRuns, spec("automation", automationRuns)],
  [playbooks, spec("playbook", playbooks)],
  [playbookRuns, spec("playbook", playbookRuns)],
  // A box run (0356) is a run of a box skill: a grant on SKILLS reads them,
  // as an automation's runs follow the automation.
  [boxRuns, spec("skill", boxRuns)],
  // An installation (0409): a grant on INSTALLATIONS reads it, its bindings
  // and its host jobs (a binding or a job follows its installation, as an
  // automation's runs follow the automation). No AI preset names the subject
  // yet (presets.ts), so an agent key reads none until it is granted.
  [installations, spec("installation", installations)],
  [
    installationBindings,
    spec("installation", installationBindings, {
      idColumn: installationBindings.installationId,
    }),
  ],
  [
    hostJobs,
    spec("installation", hostJobs, { idColumn: hostJobs.installationId }),
  ],
  // A remembered provider choice is a preference: no id/workspace qualifier.
  [intentDefaults, spec("preference", {})],
  [links, spec("link", links)],
  [tools, spec("tool", tools)],
  [mcpServers, spec("tool", mcpServers)],
  [cellInstances, spec("cell", cellInstances)],
  [widgetDefinitions, spec("widget", widgetDefinitions)],
  [rendererBindings, spec("renderer", rendererBindings)],
  [relationDefs, spec("relationDef", relationDefs)],
  [roles, spec("role", roles)],
  [artifacts, spec("artifact", artifacts)],
  [resourceShares, spec("share", resourceShares)],
  [intelligenceCommands, spec("command", intelligenceCommands)],
  [notifications, spec("notification", notifications)],
  [feeds, spec("feed", feeds)],
  [inboxItems, spec("inbox", inboxItems)],
  // The Library's groups (0328): owner-floored; their nullable workspaceId is
  // where Build files, NOT a read lens (registry.ts) — so no workspace column:
  // a space-restricted grant reads none (fails closed).
  [libraryGroups, spec("library", { id: libraryGroups.id })],
  [messagingAccounts, spec("messaging", messagingAccounts)],
  [sourceConfigs, spec("source", sourceConfigs)],
  [sourceSubscriptions, spec("source", sourceSubscriptions)],
  // What an inbound source received (0372): a grant on SOURCES reads it, over
  // the owner floor (registry.ts); a space grant reads the deliveries of the
  // sources that fire into its spaces.
  [inboundDeliveries, spec("source", inboundDeliveries)],
  [userPreferences, spec("preference", {})], // no id / workspace column
  [userResourceState, spec("preference", {})], // no id / workspace column
  [agentConfigs, spec("agent", agentConfigs)],
  // Credentials: never readable through a grant unless named explicitly.
  [secrets, spec("vault", secrets)],
  [apiKeys, spec("apiKey", apiKeys)],
]);

/**
 * The SHARED-role rows a member of `spaces` reads: a pod-wide facet whose role
 * is granted to one of them (decision B, space-keyed), on a pod-wide entity
 * (branch (b) of the entity reach) or on one STORED in one of them. A member
 * reads the role on a record of their space; an entity stored in a space
 * outside `spaces` lends its role row (properties, status) to nobody there
 * (rv-security B-1), as a shared role's row is stored pod-wide whatever its
 * entity's space. The facets `spaceReach` (GRANT_READ_SPECS), and where a key
 * may change a shared role (utils/role-write-grant.ts).
 */
export function sharedRoleRowsInSpacesWhere(spaces: readonly string[]): SQL {
  return and(
    podSharedFacetForSpacesWhere(spaces),
    inArray(
      entityFacets.entityId,
      db
        .select({ id: entities.id })
        .from(entities)
        .where(
          or(
            isNull(entities.workspaceId),
            inArray(entities.workspaceId, [...spaces])
          )
        )
    )
  )!;
}

/**
 * The channels bound to a live entity this scope reads (`contextObjectType =
 * 'entity'`), through the entity's OWN grant clause for the same scope: the
 * kinds it names, the spaces and their reach (a pod-wide person roled in a
 * granted space), its project and object pins. A scope that reads no entity
 * reaches no channel this way.
 */
export function channelFollowsEntityWhere(scope: GrantScope): SQL {
  const entityClause = grantReadClause(entities, scope);
  return and(
    eq(channels.contextObjectType, "entity"),
    exists(
      db
        .select({ one: sql`1` })
        .from(entities)
        .where(
          and(
            eq(entities.id, channels.contextObjectId),
            isNull(entities.deletedAt),
            entityClause
          )
        )
    )
  )!;
}

/**
 * The pod-wide `works_at` edges a scope limited to `spaces` reads: a person's
 * link to the company they work at when either end wears a live role in one
 * of the spaces (`roleInSpacesWhere`, the role rule the member lenses and the
 * conversations door's company-lead contacts read, backend #871), and BOTH
 * ends are records this same scope reads (`grantReadClause(entities, scope)`:
 * its kinds, its spaces and their reach). Two pod-wide records have no space
 * to stamp the edge with, so without this an app granted the space of the
 * company's lead role never saw who works there (CRM G17). Nothing else is
 * widened: another edge type, an edge stamped in a space, or an end the scope
 * does not read stays out.
 */
export function worksAtRoleLinkWhere(spaces: string[], scope: GrantScope): SQL {
  const entityClause = grantReadClause(entities, scope);
  const readable = (endColumn: AnyPgColumn) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(entities)
        .where(
          and(
            eq(entities.id, endColumn),
            isNull(entities.deletedAt),
            entityClause
          )
        )
    );
  const roleWearers = db
    .select({ id: entities.id })
    .from(entities)
    .where(roleInSpacesWhere(entities.workspaceId, entities.id, spaces));
  return and(
    isNull(relations.workspaceId),
    eq(relations.type, "works_at"),
    or(
      inArray(relations.sourceEntityId, roleWearers),
      inArray(relations.targetEntityId, roleWearers)
    ),
    readable(relations.sourceEntityId),
    readable(relations.targetEntityId)
  )!;
}

const NONE = sql`false`;

function kindClause(
  kinds: "all" | string[],
  k: NonNullable<GrantReadSpec["kind"]>
): SQL | undefined {
  if (kinds === "all") return undefined;
  if (kinds.length === 0) return NONE;
  return or(
    inArray(
      k.profileIdColumn,
      db
        .select({ id: profiles.id })
        .from(profiles)
        .where(inArray(profiles.slug, kinds))
    ),
    inArray(k.typeColumn, kinds)
  );
}

/** The grant clause for one table, or undefined when it adds no restriction. */
export function grantReadClause(
  table: object,
  grant: GrantScope
): SQL | undefined {
  const s = GRANT_READ_SPECS.get(table);
  // No spec → no column a space/project/object limit could narrow: only an
  // unlimited `*` reads such a table (S1).
  if (!s)
    return grant.permissions.includes("*") && !isNarrowedScope(grant)
      ? undefined
      : NONE;

  const parts: Array<SQL | undefined> = [];
  if ((QUALIFIED_GRANT_SUBJECTS as readonly string[]).includes(s.subject)) {
    const kinds = allowedQualifiers(grant, s.subject, "read");
    if (!s.kind) return kinds === "all" ? undefined : NONE;
    parts.push(kindClause(kinds, s.kind));
  } else {
    const allowed = grant.permissions.some((p) =>
      patternMatches(p, { subject: s.subject, action: "read" })
    );
    if (!allowed) return NONE;
  }

  if (grant.workspaceIds) {
    if (!s.workspaceColumn) return NONE;
    const spaces = [...grant.workspaceIds];
    const stamped = inArray(s.workspaceColumn, spaces);
    parts.push(
      s.spaceReach ? or(stamped, s.spaceReach(spaces, grant)) : stamped
    );
  }
  if (grant.entityIds) {
    if (!s.idColumn) return NONE;
    parts.push(inArray(s.idColumn, [...grant.entityIds]));
  }
  if (grant.projectIds) {
    if (!s.projectEntityColumn) return NONE;
    parts.push(projectLensWhere(s.projectEntityColumn, [...grant.projectIds]));
  }

  const defined = parts.filter((p): p is SQL => p !== undefined);
  if (defined.length === 0) return undefined;
  return defined.length === 1 ? defined[0] : and(...defined);
}

/**
 * The clause for a whole key grant: a row is visible when ANY scope makes it
 * visible on its own (OR of the per-scope clauses). A scope with no
 * restriction on this table lifts the clause entirely.
 */
export function keyGrantReadClause(
  table: object,
  grant: KeyGrant
): SQL | undefined {
  const clauses: SQL[] = [];
  for (const scope of grant.scopes) {
    const clause = grantReadClause(table, scope);
    if (clause === undefined) return undefined;
    clauses.push(clause);
  }
  if (clauses.length === 0) return NONE;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

/** The ambient request's grant clause for `table` (undefined = no grant). */
export function grantReadPredicate(table: object): SQL | undefined {
  const grant = getRequestGrant();
  return grant ? keyGrantReadClause(table, grant) : undefined;
}

// Database-level visibility helpers (e.g. ownerPrivateVisibleWhere) cannot
// import this module; they reach the same clause through the hook.
registerGrantReadProvider(grantReadPredicate);
