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
 */

import { db, getRequestGrant, inArray, or } from "@synap/database";
import {
  agentConfigs,
  apiKeys,
  artifacts,
  automationRuns,
  automations,
  cellInstances,
  channels,
  documents,
  entities,
  entityFacets,
  events,
  feeds,
  focusSessions,
  inboxItems,
  intelligenceCommands,
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
  relationDefs,
  relations,
  rendererBindings,
  resourceShares,
  roles,
  secrets,
  sessionEvaluations,
  sourceConfigs,
  sourceSubscriptions,
  tools,
  userPreferences,
  userResourceState,
  views,
  widgetDefinitions,
} from "@synap/database/schema";
import { and, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  allowedQualifiers,
  patternMatches,
  QUALIFIED_GRANT_SUBJECTS,
  type GrantScope,
} from "@synap/governance-policy/grants";
import { projectLensWhere } from "../utils/project-scope.js";

export interface GrantReadSpec {
  /** The grant subject (governance spelling): `entity`, `document`, … */
  subject: string;
  idColumn?: AnyPgColumn;
  workspaceColumn?: AnyPgColumn;
  /** Qualified subjects: the kind columns (profile slug wins over legacy type). */
  kind?: { typeColumn: AnyPgColumn; profileIdColumn: AnyPgColumn };
  /** How a project-restricted grant narrows this table (entity id column). */
  projectEntityColumn?: AnyPgColumn;
}

const spec = (
  subject: string,
  t: { id?: AnyPgColumn; workspaceId?: AnyPgColumn },
  extra: Partial<GrantReadSpec> = {}
): GrantReadSpec => ({
  subject,
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
    }),
  ],
  [documents, spec("document", documents)],
  [relations, spec("relation", relations)],
  [entityFacets, spec("facet", entityFacets)],
  [views, spec("view", views)],
  [projects, spec("project", projects)],
  [projectTracks, spec("track", projectTracks)],
  [proposals, spec("proposal", proposals)],
  [focusSessions, spec("session", focusSessions)],
  [sessionEvaluations, spec("session", sessionEvaluations)],
  [channels, spec("channel", channels)],
  [events, spec("event", events)],
  [automations, spec("automation", automations)],
  [automationRuns, spec("automation", automationRuns)],
  [playbooks, spec("playbook", playbooks)],
  [playbookRuns, spec("playbook", playbookRuns)],
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
  [messagingAccounts, spec("messaging", messagingAccounts)],
  [sourceConfigs, spec("source", sourceConfigs)],
  [sourceSubscriptions, spec("source", sourceSubscriptions)],
  [userPreferences, spec("preference", {})], // no id / workspace column
  [userResourceState, spec("preference", {})], // no id / workspace column
  [agentConfigs, spec("agent", agentConfigs)],
  // Credentials: never readable through a grant unless named explicitly.
  [secrets, spec("vault", secrets)],
  [apiKeys, spec("apiKey", apiKeys)],
]);

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
  if (!s) return grant.permissions.includes("*") ? undefined : NONE;

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
    parts.push(inArray(s.workspaceColumn, [...grant.workspaceIds]));
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

/** The ambient request's grant clause for `table` (undefined = no grant). */
export function grantReadPredicate(table: object): SQL | undefined {
  const grant = getRequestGrant();
  return grant ? grantReadClause(table, grant) : undefined;
}
