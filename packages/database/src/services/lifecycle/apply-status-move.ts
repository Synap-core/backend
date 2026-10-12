/**
 * THE STATUS WRITE (work model L2) — the storage half of the `moveStatus` door.
 *
 * The lifecycle COLUMNS are the truth: `entities.status` / `status_category`
 * for a kind, `entity_facets.status` / `status_category` for a role. The JSONB
 * copy `properties[<lifecycle slug>]` is the READ PROJECTION, so the hundreds
 * of existing readers keep working. This function is the ONLY writer of both,
 * in ONE compare-and-set statement:
 *
 *   UPDATE … SET status, status_category, properties = jsonb_set(…)
 *    WHERE id = $id AND status IS NOT DISTINCT FROM $from
 *
 * Zero rows ⇒ someone moved it first ⇒ a typed conflict, never an overwrite.
 *
 * Who wins a race (founder decision 2026-10-11):
 *  - an AGENT / SYSTEM move is strict compare-and-set against `expectedFrom`
 *    (absent ⇒ the value read at call time — still protected against a write
 *    landing between the read and the update);
 *  - a HUMAN move WINS: a stale `expectedFrom` is applied anyway, the
 *    transition records the ACTUAL `from` and `staleExpected: true` ("moved
 *    meanwhile"). The CAS still guards the read→write window (one re-read);
 *  - an APPROVAL REPLAY is strict whoever the actor is (`strict: true`): the
 *    approval carries a belief from filing time, and a person who moved the
 *    thing since must never be overwritten by it.
 *
 * GOVERNANCE IS NOT HERE. The governed doors (`@synap/api` `moveStatus`, the
 * jobs automation gate, the proposal executor) decide first, then call this.
 * EVENTS: the move OWES its event from the same transaction — the CAS and an
 * outbox row (`transition-outbox.ts`, 0324) commit together, so a moved thing
 * always has its transition owed. The caller then dispatches it
 * (`dispatchLifecycleTransition`, `@synap/events` — this package cannot reach
 * the fan-out); the sweeper retries what a failed dispatch left pending.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import { entities } from "../../schema/entities.js";
import { entityFacets } from "../../schema/entity-facets.js";
import { profiles } from "../../schema/profiles.js";
import { ProfileResolutionService } from "../profile-resolution-service.js";
import {
  classifyLifecycleMove,
  findLifecycleOption,
  type EffectiveLifecycle,
  type LifecycleCategory,
} from "../../utils/lifecycle-model.js";
import { insertTransitionOutbox } from "./transition-outbox.js";

type Db = PostgresJsDatabase<typeof schema>;
/** The CAS runs inside the move's transaction. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface StatusMoveActor {
  /**
   * `agent` with no `agentUserId` is an UNATTRIBUTED AI write (a service or
   * hub key): still an AI, governed and compare-and-set as one, never a person.
   */
  kind: "human" | "agent" | "system";
  /** The human the write is attributed to (owner of an agent's write). */
  userId: string;
  agentUserId?: string | null;
}

/** The transition, as the event carries it (`entity.transition.completed`). */
export interface StatusTransition {
  transitionId: string;
  entityId: string;
  profileSlug: string | null;
  role: string | null;
  facetId: string | null;
  property: string;
  from: string | null;
  to: string;
  fromCategory: LifecycleCategory | null;
  category: LifecycleCategory;
  actorKind: StatusMoveActor["kind"];
  userId: string;
  agentUserId: string | null;
  sessionId: string | null;
  reason: string | null;
  staleExpected: boolean;
  proposalId: string | null;
  /** The lens the move happened in (facet row's / entity's workspace). */
  workspaceId: string | null;
}

/** Where a move lands, resolved once (also what governance classifies). */
export interface StatusMoveTarget {
  entityId: string;
  entityType: string | null;
  workspaceId: string | null;
  facetId: string | null;
  role: string | null;
  lifecycle: EffectiveLifecycle;
  current: string | null;
}

export type ResolveTargetResult =
  | { ok: true; target: StatusMoveTarget }
  | {
      ok: false;
      code: "NOT_FOUND" | "NO_LIFECYCLE" | "ROLE_NOT_ATTACHED";
      reason: string;
    };

/**
 * Resolve the thing a move targets: the entity (kind lifecycle) or its facet
 * for `role` (role lifecycle), its lifecycle and its CURRENT value (the
 * column). Pure read.
 */
export async function resolveStatusMoveTarget(
  db: Db,
  input: {
    entityId: string;
    role?: string | null;
    facetId?: string | null;
    workspaceId?: string | null;
  }
): Promise<ResolveTargetResult> {
  const [entity] = await db
    .select({
      id: entities.id,
      type: entities.type,
      profileId: entities.profileId,
      workspaceId: entities.workspaceId,
      status: entities.status,
    })
    .from(entities)
    .where(and(eq(entities.id, input.entityId), isNull(entities.deletedAt)))
    .limit(1);
  if (!entity)
    return {
      ok: false,
      code: "NOT_FOUND",
      reason: `Entity not found: ${input.entityId}`,
    };
  const resolver = new ProfileResolutionService(db);

  if (!input.role && !input.facetId) {
    const lifecycle = entity.profileId
      ? await resolver.getEffectiveLifecycle(
          entity.profileId,
          input.workspaceId
        )
      : null;
    if (!lifecycle)
      return {
        ok: false,
        code: "NO_LIFECYCLE",
        reason: `"${entity.type}" declares no lifecycle`,
      };
    return {
      ok: true,
      target: {
        entityId: entity.id,
        entityType: entity.type,
        workspaceId: entity.workspaceId,
        facetId: null,
        role: null,
        lifecycle,
        current: entity.status,
      },
    };
  }

  const facetRows = await db
    .select({
      id: entityFacets.id,
      profileId: entityFacets.profileId,
      workspaceId: entityFacets.workspaceId,
      status: entityFacets.status,
      slug: profiles.slug,
    })
    .from(entityFacets)
    .innerJoin(profiles, eq(profiles.id, entityFacets.profileId))
    .where(
      and(
        eq(entityFacets.entityId, entity.id),
        isNull(entityFacets.deletedAt),
        input.facetId
          ? eq(entityFacets.id, input.facetId)
          : eq(profiles.slug, input.role as string)
      )
    );
  // Several rows for one role = attached in several spaces / contexts. Prefer
  // the lens's own row; a still-ambiguous role must name its facet.
  const inLens = facetRows.filter(
    (f) => (f.workspaceId ?? null) === (input.workspaceId ?? null)
  );
  const facet =
    facetRows.length === 1
      ? facetRows[0]
      : inLens.length === 1
        ? inLens[0]
        : undefined;
  if (!facet)
    return {
      ok: false,
      code: "ROLE_NOT_ATTACHED",
      reason:
        facetRows.length === 0
          ? `"${input.role ?? input.facetId}" is not attached to this entity`
          : `"${input.role}" is attached more than once; name the facet`,
    };
  const lifecycle = await resolver.getEffectiveLifecycle(
    facet.profileId,
    input.workspaceId ?? facet.workspaceId
  );
  if (!lifecycle)
    return {
      ok: false,
      code: "NO_LIFECYCLE",
      reason: `role "${facet.slug}" declares no lifecycle`,
    };
  return {
    ok: true,
    target: {
      entityId: entity.id,
      entityType: entity.type,
      workspaceId: facet.workspaceId,
      facetId: facet.id,
      role: facet.slug,
      lifecycle,
      current: facet.status,
    },
  };
}

/** How governance reads a move (from `null` for an initial status). */
export function classifyStatusMove(
  lifecycle: EffectiveLifecycle,
  to: string
): { intoTerminal: boolean; humanOnly: boolean } | null {
  const c = classifyLifecycleMove(lifecycle, to);
  return c ? { intoTerminal: c.intoTerminal, humanOnly: c.humanOnly } : null;
}

export interface ApplyStatusMoveInput {
  target: StatusMoveTarget;
  /** What the mover believed the status was. `undefined` = not expressed. */
  expectedFrom?: string | null;
  to: string;
  actor: StatusMoveActor;
  sessionId?: string | null;
  reason?: string | null;
  proposalId?: string | null;
  /**
   * Strict compare-and-set even for a human actor (an approval replay).
   * Agents and the system are always strict.
   */
  strict?: boolean;
  /**
   * The caller's lens. Stamped on the transition when the target itself has no
   * workspace (a pod-wide kind), so the trigger hop — workspace-scoped — can
   * still match it, exactly as `entities.update` routes a pod-wide entity.
   */
  lensWorkspaceId?: string | null;
  /**
   * The emit options the dispatcher replays (automation chain, correlation
   * id), stored on the outbox row with the transition.
   */
  emitContext?: Record<string, unknown>;
}

export type ApplyStatusMoveResult =
  | { status: "moved"; transition: StatusTransition }
  | { status: "unchanged"; current: string }
  | { status: "conflict"; expectedFrom: string | null; actual: string | null }
  | { status: "refused"; code: "UNKNOWN_OPTION"; reason: string };

/** Thrown by a door that turns a conflict into an error (CONFLICT, 409). */
export class LifecycleConflictError extends Error {
  readonly code = "LIFECYCLE_STALE" as const;
  constructor(
    readonly expectedFrom: string | null,
    readonly actual: string | null
  ) {
    super(
      `The status moved meanwhile: expected "${expectedFrom ?? "none"}", it is now "${actual ?? "none"}".`
    );
    this.name = "LifecycleConflictError";
  }
}

async function casWrite(
  db: Db | Tx,
  target: StatusMoveTarget,
  from: string | null,
  to: string,
  category: LifecycleCategory
): Promise<boolean> {
  const slug = target.lifecycle.propertySlug;
  // The READ PROJECTION, written in the same statement as the truth.
  const projection = sql`jsonb_set(COALESCE(properties, '{}'::jsonb), ARRAY[${slug}]::text[], to_jsonb(${to}::text), true)`;
  if (target.facetId) {
    const rows = await db
      .update(entityFacets)
      .set({
        status: to,
        statusCategory: category,
        properties: projection,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(entityFacets.id, target.facetId),
          sql`${entityFacets.status} IS NOT DISTINCT FROM ${from}`
        )
      )
      .returning({ id: entityFacets.id });
    return rows.length === 1;
  }
  const rows = await db
    .update(entities)
    .set({
      status: to,
      statusCategory: category,
      properties: projection,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(entities.id, target.entityId),
        sql`${entities.status} IS NOT DISTINCT FROM ${from}`
      )
    )
    .returning({ id: entities.id });
  return rows.length === 1;
}

async function readCurrent(
  db: Db | Tx,
  target: StatusMoveTarget
): Promise<string | null> {
  if (target.facetId) {
    const [r] = await db
      .select({ status: entityFacets.status })
      .from(entityFacets)
      .where(eq(entityFacets.id, target.facetId))
      .limit(1);
    return r?.status ?? null;
  }
  const [r] = await db
    .select({ status: entities.status })
    .from(entities)
    .where(eq(entities.id, target.entityId))
    .limit(1);
  return r?.status ?? null;
}

/**
 * Apply a status move (already governed). See the header for the race rules.
 */
export async function applyStatusMove(
  db: Db,
  input: ApplyStatusMoveInput
): Promise<ApplyStatusMoveResult> {
  const { target, to, actor } = input;
  const option = findLifecycleOption(target.lifecycle, to);
  if (!option) {
    return {
      status: "refused",
      code: "UNKNOWN_OPTION",
      reason: `"${to}" is not a status of ${target.role ?? target.entityType ?? "this kind"} (${target.lifecycle.options.map((o) => o.key).join(", ")})`,
    };
  }
  const human = actor.kind === "human" && input.strict !== true;
  // The CAS and the owed event commit together, or neither does.
  return db.transaction(async (tx): Promise<ApplyStatusMoveResult> => {
    let current = target.current;
    const expressed = input.expectedFrom !== undefined;
    const expected = expressed ? (input.expectedFrom ?? null) : current;

    // Agents/system: the mover's belief must hold.
    if (!human && expressed && expected !== current) {
      return { status: "conflict", expectedFrom: expected, actual: current };
    }
    if (current === to) return { status: "unchanged", current: to };

    let ok = await casWrite(tx, target, current, to, option.category);
    if (!ok) {
      // Someone wrote between our read and our update.
      const actual = await readCurrent(tx, target);
      if (!human) {
        return { status: "conflict", expectedFrom: expected, actual };
      }
      current = actual;
      if (current === to) return { status: "unchanged", current: to };
      ok = await casWrite(tx, target, current, to, option.category);
      if (!ok) {
        return {
          status: "conflict",
          expectedFrom: expected,
          actual: await readCurrent(tx, target),
        };
      }
    }

    const fromOption = findLifecycleOption(target.lifecycle, current);
    const [profileRow] = await tx
      .select({ type: entities.type })
      .from(entities)
      .where(eq(entities.id, target.entityId))
      .limit(1);
    const transition: StatusTransition = {
      transitionId: randomUUID(),
      entityId: target.entityId,
      profileSlug: profileRow?.type ?? target.entityType,
      role: target.role,
      facetId: target.facetId,
      property: target.lifecycle.propertySlug,
      from: current,
      to,
      fromCategory: fromOption?.category ?? null,
      category: option.category,
      actorKind: actor.kind,
      userId: actor.userId,
      agentUserId: actor.agentUserId ?? null,
      sessionId: input.sessionId ?? null,
      reason: input.reason ?? null,
      staleExpected: human && expressed && expected !== current,
      proposalId: input.proposalId ?? null,
      workspaceId: target.workspaceId ?? input.lensWorkspaceId ?? null,
    };
    await insertTransitionOutbox(tx, transition, input.emitContext);
    return { status: "moved", transition };
  });
}
