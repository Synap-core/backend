/**
 * A project's SUBJECT — the real-world thing the container is about.
 *
 * Expressed as an ordinary `links` edge, `project --targets--> entity`, which is
 * the idiom the table already documents for `session --targets--> entity` and
 * `session --targets--> project`. No new link type, no new column, no migration:
 * the container points at the thing, exactly as a session already does.
 *
 * WHY THIS EDGE AND NOT A COLUMN: the subject is what the UI derives the
 * project's user-facing NOUN and TITLE from — an "engagement" when bound to a
 * client, a "product" when bound to a product. That is a lens concern living on
 * a graph the object-surface door already reads, not a second scalar to keep in
 * sync. The backend stays agnostic; config and UI decide the word.
 *
 * AT MOST ONE subject per project: `setProjectSubject` clears every existing
 * `targets`→entity edge before writing the new one, so a project can never
 * present two competing identities.
 */

import {
  automations,
  entities,
  links,
  profiles,
  and,
  eq,
  inArray,
  isNull,
  getDb,
} from "@synap/database";
import { userVisibleWhere } from "./user-visible-where.js";
import { createLink, deleteLink } from "../services/links/links-service.js";
import { accessScopeWhere } from "./project-scope.js";

/** The resolved subject of a project, as the label/title lens consumes it. */
export interface ProjectSubject {
  entityId: string;
  /** The entity's display name, or null when it carries no title. */
  entityName: string | null;
  /** The entity's profile slug (`client`, `product`, …) — drives the noun. */
  profileSlug: string | null;
  /** The profile's human label — drives the derived title's `{kind}` half. */
  profileLabel: string | null;
}

/**
 * Load the subject of each project in one query pair (never N+1).
 * Returns a Map keyed by project id; projects with no subject are absent.
 *
 * FLOORED ON THE READER, not on whoever bound the subject. `setProjectSubject`
 * checks the BINDER's access; that says nothing about who may later READ the
 * bound entity's name. Without this, an owner binding their pod-private entity
 * as the subject of a workspace-shared project published that entity's id,
 * title, profile slug and label to every member of the workspace — off an
 * ordinary `projects.list`.
 *
 * A reader who cannot see the entity gets NO subject for that project, so it
 * falls back to its plain typed name. Degrading to the generic noun is the
 * correct failure here: a project row must never be the thing that discloses an
 * entity the reader was not granted.
 */
export async function loadProjectSubjects(
  db: Awaited<ReturnType<typeof getDb>>,
  projectIds: string[],
  readerUserId: string
): Promise<Map<string, ProjectSubject>> {
  const result = new Map<string, ProjectSubject>();
  if (projectIds.length === 0) return result;

  const edges = await db
    .select({ fromId: links.fromId, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "project"),
        inArray(links.fromId, projectIds),
        eq(links.toType, "entity"),
        eq(links.linkType, "targets")
      )
    );
  if (edges.length === 0) return result;

  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      slug: profiles.slug,
      displayName: profiles.displayName,
    })
    .from(entities)
    .leftJoin(profiles, eq(entities.profileId, profiles.id))
    .where(
      and(
        inArray(
          entities.id,
          edges.map((e) => e.toId)
        ),
        isNull(entities.deletedAt),
        // `facetLens: true` because this is the `entities` table — the registered
        // VisibilityRule for entities uses it, and every other entity reader
        // passes it. Omitting it would ALSO hide role-shared pod-wide entities
        // the reader legitimately has, so this keeps the floor identical to the
        // one the rest of the codebase applies.
        accessScopeWhere({
          workspaceIdColumn: entities.workspaceId,
          entityIdColumn: entities.id,
          ownerColumn: entities.userId,
          userId: readerUserId,
          facetLens: true,
        })
      )
    );
  const byEntityId = new Map(rows.map((r) => [r.id, r]));

  for (const edge of edges) {
    // An edge pointing at a deleted / missing entity resolves to NO subject
    // rather than to a half-populated one — a project labelled from a subject
    // that no longer exists reads as a bug to whoever sees it.
    const row = byEntityId.get(edge.toId);
    if (!row) continue;
    result.set(edge.fromId, {
      entityId: row.id,
      entityName: row.title,
      profileSlug: row.slug,
      profileLabel: row.displayName,
    });
  }
  return result;
}

/**
 * Is `entityId` bindable as a subject BY this user?
 *
 * The exact predicate `setProjectSubject` enforces, exported so a caller can
 * pre-check before writing anything else. Keeping the pre-check and the write
 * on ONE predicate is the point: a tighter pre-check rejects binds the write
 * would have accepted, and a looser one lets a caller get half-way through a
 * mutation before failing.
 */
export async function isSubjectEntityVisible(
  db: Awaited<ReturnType<typeof getDb>>,
  entityId: string,
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        isNull(entities.deletedAt),
        accessScopeWhere({
          workspaceIdColumn: entities.workspaceId,
          entityIdColumn: entities.id,
          ownerColumn: entities.userId,
          userId,
          facetLens: true,
        })
      )
    );
  return Boolean(row);
}

/**
 * Bind a project to its subject entity, or clear it with `entityId: null`.
 *
 * The entity is re-checked against the CANONICAL access floor here
 * (`accessScopeWhere`), never trusted from the request — otherwise any caller
 * could bind a project to an entity id they cannot see and read its name back
 * off their own project page.
 *
 * Idempotent: re-binding the same entity clears and rewrites the same edge.
 */
export async function setProjectSubject(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  projectId: string;
  workspaceId: string | null;
  entityId: string | null;
  userId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { db, projectId, entityId, userId } = input;

  if (entityId) {
    // ONE predicate, shared with the pre-check callers use — see
    // `isSubjectEntityVisible`. This is the write's own floor and does not
    // assume a caller ran the pre-check.
    if (!(await isSubjectEntityVisible(db, entityId, userId))) {
      return { ok: false, reason: "Subject entity not found" };
    }
  }

  // Clear first — at most one subject, always.
  const existing = await db
    .select({ id: links.id })
    .from(links)
    .where(
      and(
        eq(links.fromType, "project"),
        eq(links.fromId, projectId),
        eq(links.toType, "entity"),
        eq(links.linkType, "targets")
      )
    );
  for (const edge of existing) {
    await deleteLink(edge.id);
  }

  if (entityId) {
    await createLink({
      workspaceId: input.workspaceId,
      fromType: "project",
      fromId: projectId,
      toType: "entity",
      toId: entityId,
      linkType: "targets",
    });
  }

  return { ok: true };
}

/* ── Project MEMBERSHIP: which automations run under this container ──────────
 *
 * Expressed as `automation --member_of--> project`, the SAME container idiom the
 * codebase already uses for `automation --member_of--> playbook` and
 * `tool|skill|command --member_of--> capability`. Deliberately NOT an
 * `automations.project_id` column:
 *
 *   - `member_of` already means exactly this and `project` is already a valid
 *     `LinkEndpointType`, so the edge costs no migration and no schema change;
 *   - an automation can serve more than one container over its life, which a
 *     single FK column would forbid and this table has always allowed;
 *   - every other "parts of a container" read here goes through `links`, so a
 *     second mechanism would be the duplication we keep deleting.
 *
 * This is what gives tier 3 (automations) a relation to tier 1 (the container).
 * Sessions already had one — `focus_sessions.projectId` — because a session is
 * BORN inside a container, whereas an automation is authored once and enrolled
 * afterwards. That difference is exactly why one is a column and one is an edge.
 */

/** One automation enrolled in a project, as the project's Automations tab reads it. */
export interface ProjectAutomation {
  id: string;
  name: string;
  description: string | null;
  triggerType: string;
  status: string | null;
}

/** Every automation enrolled in `projectId` that the caller can see. */
export async function listProjectAutomations(
  db: Awaited<ReturnType<typeof getDb>>,
  projectId: string,
  readerUserId: string
): Promise<ProjectAutomation[]> {
  const edges = await db
    .select({ fromId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "automation"),
        eq(links.toType, "project"),
        eq(links.toId, projectId),
        eq(links.linkType, "member_of")
      )
    );
  if (edges.length === 0) return [];

  // The EDGE is not the access floor — an edge outlives the caller's access to
  // what it points at. Rows are re-filtered to workspaces the caller belongs to,
  // so an enrolment can never leak an automation's name.
  const rows = await db
    .select({
      id: automations.id,
      name: automations.name,
      description: automations.description,
      triggerType: automations.triggerType,
      status: automations.status,
    })
    .from(automations)
    .where(
      and(
        inArray(
          automations.id,
          edges.map((e) => e.fromId)
        ),
        // `userVisibleWhere`, NOT a membership id-list: the registered
        // VisibilityRule for `automations` is `nullWorkspaceMeans:
        // "podGlobalConfig"`, so a POD-GLOBAL automation (NULL workspace) is
        // visible to everyone. An `inArray(workspaceId, …)` never matches NULL,
        // which silently made every pod-global automation impossible to list,
        // enrol, or withdraw.
        userVisibleWhere(automations.workspaceId, readerUserId)
      )
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    triggerType: r.triggerType,
    status: r.status ?? null,
  }));
}

/**
 * Enrol / withdraw an automation from a project. Idempotent both ways:
 * `createLink` no-ops on the unique edge, and withdrawing an absent enrolment
 * deletes nothing.
 */
export async function setProjectAutomationMembership(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  projectId: string;
  automationId: string;
  workspaceId: string | null;
  member: boolean;
  actingUserId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { db, projectId, automationId, member, actingUserId } = input;

  // Gate on the LOADED automation's own visibility (same canonical floor as the
  // read above — pod-global automations included), never a request-supplied one.
  const [automation] = await db
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        eq(automations.id, automationId),
        userVisibleWhere(automations.workspaceId, actingUserId)
      )
    );
  if (!automation) return { ok: false, reason: "Automation not found" };

  if (member) {
    await createLink({
      workspaceId: input.workspaceId,
      fromType: "automation",
      fromId: automationId,
      toType: "project",
      toId: projectId,
      linkType: "member_of",
    });
    return { ok: true };
  }

  const existing = await db
    .select({ id: links.id })
    .from(links)
    .where(
      and(
        eq(links.fromType, "automation"),
        eq(links.fromId, automationId),
        eq(links.toType, "project"),
        eq(links.toId, projectId),
        eq(links.linkType, "member_of")
      )
    );
  for (const edge of existing) {
    await deleteLink(edge.id);
  }
  return { ok: true };
}
