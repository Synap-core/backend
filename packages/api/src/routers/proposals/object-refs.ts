/**
 * `objectRefs` — every id a proposal payload names, resolved to the OBJECT it
 * is: `{ id, kind, name }`, keyed by the id's payload path (`subjectId`,
 * `parameters.automationId`, `spaceGrant.agentUserId`, `entityIds.3`).
 *
 * WHY. A proposal card draws the object approving creates, and every named
 * thing on it is a door. The payload names its objects by raw uuid, nested
 * anywhere (`parameters.*`, arrays of ids), and the read row only resolved a
 * fixed handful of them (`playbookName`, `projectName`, …) — so the rest
 * reached the card as raw ids, or as nothing.
 *
 * WHAT IS READ. A key ending in `Id` (a uuid string) or `Ids` (an array of
 * uuids), at any depth up to {@link MAX_DEPTH}. The key's STEM picks the table
 * (`automationId` → automations, `agentUserId` → users); a sibling `<x>Type`
 * (`fromId` + `fromType`, the `/links` shape) overrides it; an unknown stem
 * (`subjectId`) is read as an entity, the pod's generic object.
 *
 * VISIBILITY. Every batch is AND-ed with the viewer's canonical read predicate
 * (the same floors `enrichProposalsForDisplay`'s name batches use), and an
 * entity resolves only under the proposal's own lens (pod-wide, or its own
 * workspace). An id the viewer may not read gets NO entry — absent means
 * unknown, never a guess; an object with no name of its own gets `name: null`.
 *
 * Kinds are vocabulary object kinds (`entity`, `session`, `project`,
 * `workspace`, `automation`, `playbook`, `agent`, `skill`, `tool`, `track`,
 * `document`, `channel`), so a host opens each through its one route table.
 */

import {
  db,
  and,
  or,
  eq,
  inArray,
  entities,
  users,
  focusSessions,
  playbooks,
  projects,
  automations,
  workspaces,
  channels,
  skills,
  tools,
} from "@synap/database";
import { documents, projectTracks } from "@synap/database/schema";
import { isLikelyUUID } from "@synap-core/types/proposals";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  ownerPrivateVisibleWhere,
  userVisibleWhere,
} from "../../utils/user-visible-where.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { visibleSkillsWhere } from "../../services/skills/visibility.js";
import {
  sessionDocumentReadableWhere,
  sessionReadableWhere,
} from "../../access/session-visibility.js";

export interface ProposalObjectRef {
  id: string;
  /** A vocabulary object kind — the host's route-table key. */
  kind: string;
  /** The object's own name; `null` when it has none (an untitled entity). */
  name: string | null;
}

/** The tables a ref can resolve through. */
type RefTable =
  | "entity"
  | "session"
  | "project"
  | "workspace"
  | "automation"
  | "playbook"
  | "agent"
  | "skill"
  | "tool"
  | "track"
  | "document"
  | "channel";

/** One id found in a payload, before resolution. */
export interface CollectedIdRef {
  path: string;
  id: string;
  table: RefTable;
}

/** Deep enough for `parameters.spaceGrant.agentUserId`, bounded for a hostile payload. */
const MAX_DEPTH = 4;
/** Per payload — a bulk `entityIds` list past this resolves its first N. */
const MAX_REFS_PER_PAYLOAD = 50;

/**
 * Key stem (`automationId` → `automation`) → table. Lower-cased; a stem not
 * listed is read as an entity. Also used for a sibling `<x>Type` value.
 */
const STEM_TABLE: Readonly<Record<string, RefTable>> = {
  entity: "entity",
  sourceentity: "entity",
  targetentity: "entity",
  existingentity: "entity",
  parententity: "entity",
  session: "session",
  focussession: "session",
  focus_session: "session",
  sourcesession: "session",
  parentsession: "session",
  project: "project",
  workspace: "workspace",
  space: "workspace",
  sourceworkspace: "workspace",
  targetworkspace: "workspace",
  automation: "automation",
  rule: "automation",
  playbook: "playbook",
  template: "playbook",
  agentuser: "agent",
  agent: "agent",
  skill: "skill",
  capability: "skill",
  tool: "tool",
  track: "track",
  project_track: "track",
  document: "document",
  channel: "channel",
  thread: "channel",
};

/**
 * Stems that are NOT object references: the proposal's own plumbing (the
 * actor, the row's envelope ids), event/correlation ids, external ids.
 */
const SKIPPED_STEMS = new Set([
  "correlation",
  "request",
  "requestedevent",
  "validatedevent",
  "completedevent",
  "event",
  "external",
  "message",
  "governancerule",
  "automationrun",
  "run",
  "user",
  "createdby",
  "owner",
  "facet",
  "profile",
  "property",
  "view",
  "app",
]);

function tableForKey(
  stem: string,
  sibling: Record<string, unknown>
): RefTable | null {
  const lower = stem.toLowerCase();
  if (SKIPPED_STEMS.has(lower)) return null;
  const typed = sibling[`${stem}Type`];
  if (typeof typed === "string") {
    const fromType = STEM_TABLE[typed.toLowerCase()];
    // A typed endpoint whose type is not an object table here (a `view`
    // endpoint) is left unresolved rather than guessed as an entity.
    return fromType ?? null;
  }
  return STEM_TABLE[lower] ?? "entity";
}

/** Every `*Id` / `*Ids` uuid in a payload, with its path and table. Pure. */
export function collectIdRefs(
  payload: Record<string, unknown> | undefined
): CollectedIdRef[] {
  const out: CollectedIdRef[] = [];
  if (!payload) return out;
  const walk = (node: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, value] of Object.entries(node)) {
      if (out.length >= MAX_REFS_PER_PAYLOAD) return;
      if (key.startsWith("_")) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const single = /^(.+)Id$/.exec(key);
      const many = /^(.+)Ids$/.exec(key);
      if (single && typeof value === "string") {
        const table = tableForKey(single[1]!, node);
        if (table && isLikelyUUID(value)) out.push({ path, id: value, table });
        continue;
      }
      if (many && Array.isArray(value)) {
        const table = tableForKey(many[1]!, node);
        if (!table) continue;
        value.forEach((id, i) => {
          if (out.length >= MAX_REFS_PER_PAYLOAD) return;
          if (typeof id === "string" && isLikelyUUID(id)) {
            out.push({ path: `${path}.${i}`, id, table });
          }
        });
        continue;
      }
      if (depth >= MAX_DEPTH || !value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            walk(item as Record<string, unknown>, `${path}.${i}`, depth + 1);
          }
        });
      } else {
        walk(value as Record<string, unknown>, path, depth + 1);
      }
    }
  };
  walk(payload, "", 0);
  return out;
}

type Named = { id: string; name: string | null };

/**
 * Resolve every row's refs in ONE batched read per table (skipped when the page
 * names none), floored by the viewer's read predicates.
 */
export async function resolveObjectRefs(
  rows: Array<{
    workspaceId: string | null;
    payload: Record<string, unknown> | undefined;
  }>,
  viewer: { userId: string; roster: boolean }
): Promise<Array<Record<string, ProposalObjectRef> | undefined>> {
  const collected = rows.map((row) => collectIdRefs(row.payload));
  const idsFor = (table: RefTable): string[] => [
    ...new Set(
      collected.flatMap((refs) =>
        refs.filter((r) => r.table === table).map((r) => r.id)
      )
    ),
  ];
  const access = scopedDb(AccessContext.operator({ userId: viewer.userId }));
  const { userId } = viewer;
  const rowWorkspaceIds = [
    ...new Set(rows.map((r) => r.workspaceId).filter((w): w is string => !!w)),
  ].filter(isLikelyUUID);

  const read = async <T>(
    ids: string[],
    query: (ids: string[]) => Promise<T[]>
  ): Promise<T[]> => (ids.length > 0 ? query(ids) : []);

  const [
    entityRows,
    sessionRows,
    projectRows,
    workspaceRows,
    automationRows,
    playbookRows,
    agentRows,
    skillRows,
    toolRows,
    trackRows,
    documentRows,
    channelRows,
  ] = await Promise.all([
    read(idsFor("entity"), (ids) =>
      db
        .select({
          id: entities.id,
          title: entities.title,
          workspaceId: entities.workspaceId,
        })
        .from(entities)
        .where(and(inArray(entities.id, ids), access.predicate(entities)))
    ),
    read(idsFor("session"), (ids) =>
      db
        .select({
          id: focusSessions.id,
          title: focusSessions.title,
          goal: focusSessions.goal,
        })
        .from(focusSessions)
        .where(
          and(
            inArray(focusSessions.id, ids),
            sessionReadableWhere({ userId, roster: viewer.roster })
          )
        )
    ),
    read(idsFor("project"), (ids) =>
      db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(inArray(projects.id, ids), access.predicate(projects)))
    ),
    read(idsFor("workspace"), (ids) =>
      db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(
          and(
            inArray(workspaces.id, ids),
            userVisibleWhere(workspaces.id, userId)
          )
        )
    ),
    read(idsFor("automation"), (ids) =>
      db
        .select({ id: automations.id, name: automations.name })
        .from(automations)
        .where(and(inArray(automations.id, ids), access.predicate(automations)))
    ),
    read(idsFor("playbook"), (ids) =>
      db
        .select({ id: playbooks.id, name: playbooks.name })
        .from(playbooks)
        .where(and(inArray(playbooks.id, ids), access.predicate(playbooks)))
    ),
    // Agents are `users` rows of type agent. A HUMAN user id is not resolved
    // here: a person's name is not this read's to hand out by id.
    read(idsFor("agent"), (ids) =>
      db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(inArray(users.id, ids), eq(users.userType, "agent")))
    ),
    read(idsFor("skill"), (ids) =>
      db
        .select({ id: skills.id, name: skills.name })
        .from(skills)
        .where(
          and(
            inArray(skills.id, ids),
            or(
              visibleSkillsWhere(userId, undefined, { includeExpired: true }),
              ...rowWorkspaceIds.map((ws) =>
                visibleSkillsWhere(userId, ws, { includeExpired: true })
              )
            )
          )
        )
    ),
    read(idsFor("tool"), (ids) =>
      db
        .select({ id: tools.id, name: tools.name })
        .from(tools)
        .where(and(inArray(tools.id, ids), access.predicate(tools)))
    ),
    read(idsFor("track"), (ids) =>
      db
        .select({ id: projectTracks.id, name: projectTracks.name })
        .from(projectTracks)
        .where(
          and(inArray(projectTracks.id, ids), access.predicate(projectTracks))
        )
    ),
    read(idsFor("document"), (ids) =>
      db
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(
          and(
            inArray(documents.id, ids),
            ownerPrivateVisibleWhere(
              documents.workspaceId,
              documents.userId,
              userId
            ),
            sessionDocumentReadableWhere(documents.id, {
              userId,
              roster: viewer.roster,
            })
          )
        )
    ),
    read(idsFor("channel"), (ids) =>
      db
        .select({ id: channels.id, title: channels.title })
        .from(channels)
        .where(and(inArray(channels.id, ids), access.predicate(channels)))
    ),
  ]);

  const byId = (list: Named[]) => new Map(list.map((r) => [r.id, r]));
  const text = (v: string | null | undefined) =>
    typeof v === "string" && v.trim() ? v : null;
  const entityById = new Map(entityRows.map((r) => [r.id, r]));
  const named: Record<Exclude<RefTable, "entity">, Map<string, Named>> = {
    session: byId(
      sessionRows.map((r) => ({ id: r.id, name: text(resolveSessionTitle(r)) }))
    ),
    project: byId(projectRows.map((r) => ({ id: r.id, name: text(r.name) }))),
    workspace: byId(
      workspaceRows.map((r) => ({ id: r.id, name: text(r.name) }))
    ),
    automation: byId(
      automationRows.map((r) => ({ id: r.id, name: text(r.name) }))
    ),
    playbook: byId(playbookRows.map((r) => ({ id: r.id, name: text(r.name) }))),
    agent: byId(agentRows.map((r) => ({ id: r.id, name: text(r.name) }))),
    skill: byId(skillRows.map((r) => ({ id: r.id, name: text(r.name) }))),
    tool: byId(toolRows.map((r) => ({ id: r.id, name: text(r.name) }))),
    track: byId(trackRows.map((r) => ({ id: r.id, name: text(r.name) }))),
    document: byId(documentRows.map((r) => ({ id: r.id, name: text(r.title) }))),
    channel: byId(channelRows.map((r) => ({ id: r.id, name: text(r.title) }))),
  };

  return collected.map((refs, idx) => {
    const lensWorkspaceId = rows[idx]!.workspaceId;
    const out: Record<string, ProposalObjectRef> = {};
    for (const ref of refs) {
      if (ref.table === "entity") {
        const meta = entityById.get(ref.id);
        // The proposal's lens: pod-wide, or this proposal's own workspace —
        // the same lens `resolveEntityTitle` applies to the subject chip.
        if (
          !meta ||
          (meta.workspaceId !== null && meta.workspaceId !== lensWorkspaceId)
        ) {
          continue;
        }
        out[ref.path] = { id: ref.id, kind: "entity", name: text(meta.title) };
        continue;
      }
      const hit = named[ref.table].get(ref.id);
      if (hit) out[ref.path] = { id: ref.id, kind: ref.table, name: hit.name };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  });
}
