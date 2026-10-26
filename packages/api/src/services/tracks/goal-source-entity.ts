/**
 * "MAKE IT A GOAL" — the half `startTrack` runs (work model D2 part 2, W5b).
 *
 * A `goal` / `objective` / `okr` entity converts into a goal through the ONE
 * start door (`startTrack`, its `fromEntity` input), so governance, the
 * approval replay and idempotency are the start's own. This file holds what
 * that door needs about the entity, and nothing that calls the door (the
 * door's caller is `convert-to-goal.ts`), so `tracks-service.ts` imports it
 * without a cycle:
 *
 *   readTrackFromEntity  — the `fromEntity` a proposal payload carries, read
 *                          back by the `track/create` replay;
 *   assertGoalSource     — re-checked on EVERY start, the replay included:
 *                          the entity is still visible, still convertible
 *                          (`canConvertToGoal`), and the goal's owner (the
 *                          person behind the entity) can hold it;
 *   writeGoalLineage     — `entity --promoted_to--> track`, written by the
 *                          start that created the goal (never a new link type).
 *
 * The entity is never changed or deleted: the edge is the only mark that it
 * became a goal.
 */

import { TRPCError } from "@trpc/server";
import {
  and,
  eq,
  isNull,
  getDb,
  entities,
  links,
  profiles,
} from "@synap/database";
import {
  canConvertToGoal,
  isGoalConvertibleKind,
  type GoalConvertibleKind,
} from "@synap-core/types/units";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { AccessContext, scopedDb } from "../../access/index.js";
import { createLinks } from "../links/links-service.js";
import { loadVisibleProject } from "../projects/load-visible-project.js";
import {
  personName,
  resolveGoalOwnerPerson,
} from "./track-participant-store.js";

/** How the entity had ended — the goal is born closed or dropped with it. */
export type TrackFromEntityEnding =
  | { status: "completed"; verdict: "met" }
  | { status: "archived"; verdict: "no_longer_needed" };

/**
 * What a converting start carries (and its proposal, for the replay). `kind`
 * and `title` are for the reviewer's sentence only — re-read, never trusted.
 */
export interface TrackFromEntity {
  entityId: string;
  kind: GoalConvertibleKind;
  title: string;
  /**
   * The entity had already ended — what the reviewer approves rides here (the
   * field map placed an achieved entity's key results in the end state).
   */
  ended: TrackFromEntityEnding | null;
}

/** The `fromEntity` a `track/create` payload carries; `null` when none or malformed. */
export function readTrackFromEntity(raw: unknown): TrackFromEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.entityId !== "string" ||
    typeof r.title !== "string" ||
    !isGoalConvertibleKind(r.kind as string)
  ) {
    return null;
  }
  const e = r.ended as Record<string, unknown> | null | undefined;
  const ended: TrackFromEntityEnding | null =
    e?.status === "completed" && e.verdict === "met"
      ? { status: "completed", verdict: "met" }
      : e?.status === "archived" && e.verdict === "no_longer_needed"
        ? { status: "archived", verdict: "no_longer_needed" }
        : null;
  return {
    entityId: r.entityId,
    kind: r.kind as GoalConvertibleKind,
    title: r.title,
    ended,
  };
}

/** An entity as the conversion reads it. */
export interface GoalSourceEntity {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  kind: string | null;
  properties: Record<string, unknown>;
  statusCategory: string | null;
}

/** The goals `entityId` was already made into (its `promoted_to` edges to a track). */
export async function goalIdsMadeFrom(entityId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "entity"),
        eq(links.fromId, entityId),
        eq(links.toType, "track"),
        eq(links.linkType, "promoted_to")
      )
    );
  return rows.map((r) => r.toId);
}

/**
 * The entity, through the caller's own floor (`scopedDb` + the `entities`
 * rule), refused unless `canConvertToGoal` says yes — the SAME rule the
 * surfaces show the button on. NOT_FOUND when unseen; BAD_REQUEST for another
 * kind; CONFLICT when it already became a goal.
 */
export async function loadConvertibleEntity(
  entityId: string,
  actor: {
    userId: string;
    agentUserId?: string | null;
    isHubProtocol?: boolean;
  }
): Promise<GoalSourceEntity & { kind: GoalConvertibleKind }> {
  const row = await scopedDb(AccessContext.from(actor)).findFirst<{
    id: string;
    userId: string;
    workspaceId: string | null;
    title: string | null;
    type: string;
    profileId: string | null;
    properties: unknown;
    statusCategory: string | null;
  }>(entities, {
    where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
  });
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No entity ${entityId} you can open.`,
    });
  }
  let kind: string | null = row.type || null;
  if (row.profileId) {
    const db = await getDb();
    const [p] = await db
      .select({ slug: profiles.slug })
      .from(profiles)
      .where(eq(profiles.id, row.profileId))
      .limit(1);
    if (p?.slug) kind = p.slug;
  }
  const goalIds = await goalIdsMadeFrom(row.id);
  if (!canConvertToGoal({ profileSlug: kind, goalIds })) {
    if (goalIds.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `"${row.title ?? "This entity"}" is already a goal (${goalIds[0]}) — open that goal instead.`,
      });
    }
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Only a goal, an objective or an OKR can be made a goal (this one's kind: ${resolveObjectNoun(kind ?? "entity")}).`,
    });
  }
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    title: row.title,
    kind: kind as GoalConvertibleKind,
    properties:
      row.properties && typeof row.properties === "object"
        ? (row.properties as Record<string, unknown>)
        : {},
    statusCategory: row.statusCategory,
  };
}

/** A converting start, checked: the entity as it stands, and the goal's owner. */
export interface CheckedGoalSource {
  entity: GoalSourceEntity;
  /** The PERSON who will own the goal — the one behind the entity. */
  ownerPersonId: string;
}

/**
 * Re-checked by `startTrack` on every converting start — the approval replay
 * included (the approver is `actor.userId` there), BEFORE anything is
 * written:
 *   - the entity is still visible and still convertible (never converted
 *     twice, even by two proposals approved one after the other);
 *   - its owner — the person behind `entities.user_id` as it stands now (an
 *     agent's entity: the agent's person) — can see the project the goal is
 *     started on;
 *   - an entity that was ACHIEVED arrives closed as met, and only a goal's
 *     judge — its owner, at birth — closes it: the person deciding must be
 *     that owner.
 */
export async function assertGoalSource(
  from: TrackFromEntity,
  project: { id: string; name?: string; userId: string },
  actor: {
    userId: string;
    agentUserId?: string | null;
    isHubProtocol?: boolean;
  }
): Promise<CheckedGoalSource> {
  const entity = await loadConvertibleEntity(from.entityId, actor);
  const ownerPersonId = await resolveGoalOwnerPerson(
    entity.userId,
    project.userId
  );
  if (ownerPersonId !== actor.userId) {
    const db = await getDb();
    const who = (await personName(ownerPersonId)) ?? "Its owner";
    if (!(await loadVisibleProject(db, project.id, ownerPersonId))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${who} owns "${from.title}" but cannot see project "${project.name ?? project.id}" — share the project with them, or pick another one.`,
      });
    }
    if (from.ended?.status === "completed") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `"${from.title}" was achieved, so its goal is born closed as met — and only its owner closes it. Ask ${who} to make it a goal.`,
      });
    }
  }
  return { entity, ownerPersonId };
}

/**
 * The lineage edge `entity --promoted_to--> track` — the start that created
 * the goal writes it (the start is already authorized, as for its
 * `instantiated_from` edge). Filed in the entity's space, so whoever sees
 * the entity sees what it became. Idempotent on the unique edge.
 */
export async function writeGoalLineage(
  entity: Pick<GoalSourceEntity, "id" | "workspaceId">,
  trackId: string
): Promise<void> {
  await createLinks([
    {
      workspaceId: entity.workspaceId,
      fromType: "entity",
      fromId: entity.id,
      toType: "track",
      toId: trackId,
      linkType: "promoted_to",
    },
  ]);
}
