/**
 * Team roster → person entity bridge.
 *
 * Product rule (option A): one human → one `person` entity (including teammates).
 * Role `team-member` is a facet on that person when the profile exists.
 *
 * Bridge login identity: `external_id` = `user:<memberUserId>` (+ email when present).
 * Best-effort: never throws to membership callers; agents are skipped.
 */

import { and, eq, isNull, isNotNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLogger } from "@synap-core/core";
import {
  entities,
  entityFacets,
  profiles,
  users,
  workspaceMembers,
} from "../schema/index.js";
import type * as schema from "../schema/index.js";
import { EntityRepository } from "../repositories/entity-repository.js";
import { FacetRepository } from "../repositories/facet-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";
import { ProfileNotFoundError } from "../errors/index.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import {
  resolveIdentity,
  registerIdentitySignals,
  type IdentitySignal,
} from "./identity-resolution-service.js";

const logger = createLogger({ module: "team-person-bridge" });

type Db = PostgresJsDatabase<typeof schema>;

export type EnsureTeamPersonAction =
  "created" | "linked" | "updated" | "skipped";

export interface EnsureTeamPersonInput {
  memberUserId: string;
  workspaceId: string;
  /** Owns person entities in this pod (data plane). Fallback when no WS owner. */
  ownerUserId: string;
}

export interface EnsureTeamPersonResult {
  entityId: string | null;
  action: EnsureTeamPersonAction;
  reason?: string;
}

/** Canonical external_id signal value for a pod user. */
export function userExternalIdSignal(userId: string): string {
  return `user:${userId}`;
}

/**
 * Resolve the workspace owner (role=owner) for person ownership.
 * Teammates' person rows live under the workspace owner's graph so capture
 * and CRM search (scoped by capturer userId) can see them.
 */
export async function resolveWorkspaceOwnerUserId(
  db: Db,
  workspaceId: string
): Promise<string | null> {
  const row = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.role, "owner")
    ),
    columns: { userId: true },
  });
  return row?.userId ?? null;
}

/**
 * Ensure a `person` entity exists for a human workspace member and (best-effort)
 * attach the `team-member` facet for the membership workspace.
 * Never throws — unexpected errors return `{ action: "skipped", reason: "error" }`.
 */
export async function ensureTeamPersonForMember(
  db: Db,
  input: EnsureTeamPersonInput
): Promise<EnsureTeamPersonResult> {
  try {
    return await ensureTeamPersonForMemberInner(db, input);
  } catch (err) {
    logger.warn(
      {
        err,
        memberUserId: input.memberUserId,
        workspaceId: input.workspaceId,
      },
      "team-person-bridge: ensure failed (membership preserved)"
    );
    return { entityId: null, action: "skipped", reason: "error" };
  }
}

async function ensureTeamPersonForMemberInner(
  db: Db,
  input: EnsureTeamPersonInput
): Promise<EnsureTeamPersonResult> {
  const member = await db.query.users.findFirst({
    where: eq(users.id, input.memberUserId),
    columns: {
      id: true,
      email: true,
      name: true,
      userType: true,
    },
  });

  if (!member) {
    return {
      entityId: null,
      action: "skipped",
      reason: "user_not_found",
    };
  }

  if (member.userType === "agent") {
    return {
      entityId: null,
      action: "skipped",
      reason: "agent",
    };
  }

  const ownerUserId =
    (await resolveWorkspaceOwnerUserId(db, input.workspaceId)) ??
    input.ownerUserId;

  const displayName = member.name?.trim() || member.email?.trim() || "Member";

  const signals: IdentitySignal[] = [
    {
      type: "external_id",
      value: userExternalIdSignal(member.id),
    },
  ];
  if (member.email?.trim()) {
    signals.push({ type: "email", value: member.email.trim() });
  }

  // Serialize concurrent ensures for the SAME member. Two membership events
  // (invite-accept + backfill, or two rapid invites) could each strong-MISS the
  // resolve and each create — the live "Samir ×2 / eve-doctor-s ×2" duplicate.
  // The (type,value) unique index on entity_identity_signals only makes ONE
  // signal insert win; both ENTITIES were already created. A transaction-scoped
  // advisory lock keyed on the login external_id makes the 2nd caller block
  // until the 1st commits, so it then strong-matches the just-registered signal
  // and links instead of duplicating. (A migration is NOT needed: the unique
  // constraint already exists; only the check→create window needed closing, and
  // an FK from the signal to the entity forbids claim-before-insert — hence the
  // lock rather than a signal-first upsert.) Released on commit/rollback.
  return await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`synap:team-person-bridge:${userExternalIdSignal(member.id)}`}))`
    );

    // Weak same-name fallback scope: the OWNER's visible rows. Persons are
    // pod-wide (workspace_id NULL) owned by the workspace owner, so the null
    // branch is gated by owner — a same-name person in ANOTHER owner's graph is
    // never a weak-link candidate. Built here (not injected from the api caller)
    // because the scope must key on the RESOLVED ownerUserId that only this
    // function knows; `userVisibleWhere` lives in @synap/database so no upward
    // import is required.
    const weakScope = or(
      and(isNull(entities.workspaceId), eq(entities.userId, ownerUserId)),
      and(
        isNotNull(entities.workspaceId),
        userVisibleWhere(entities.workspaceId, ownerUserId)
      )
    )!;

    const resolution = await resolveIdentity(tx, {
      userId: ownerUserId,
      kindSlug: "person",
      name: displayName,
      signals,
      userScope: weakScope,
    });

    let entityId: string;
    let action: EnsureTeamPersonAction;

    if (resolution.match === "strong" && resolution.entity) {
      // Strong signal (external_id / email) → same human. Link, never create.
      entityId = resolution.entity.id;
      action = "linked";
    } else if (
      resolution.match === "weak" &&
      resolution.entity &&
      !!member.email?.trim() &&
      (await weakMatchEmailCorroborates(
        tx,
        resolution.entity.id,
        member.email.trim()
      ))
    ) {
      // Same-name person whose stored email ALSO matches → same human. Link
      // (attach the facet + register external_id below) rather than mint a
      // duplicate. Gating on name+email avoids false-linking a same-name
      // stranger — name alone never links here.
      entityId = resolution.entity.id;
      action = "linked";
    } else {
      const silentEventRepo = createSilentEventRepo();
      const entityRepo = new EntityRepository(tx, silentEventRepo);
      const created = await entityRepo.create(
        {
          profileSlug: "person",
          title: displayName,
          workspaceId: null,
          userId: ownerUserId,
          properties: {
            ...(member.email?.trim() ? { email: member.email.trim() } : {}),
            linkedUserId: member.id,
          },
          skipValidation: true,
        },
        ownerUserId
      );
      entityId = created.id;
      action = "created";
    }

    await registerIdentitySignals(tx, entityId, signals, "team-person-bridge");

    // Merge linkedUserId into properties when missing (link paths).
    if (action !== "created") {
      const existing = await tx.query.entities.findFirst({
        where: eq(entities.id, entityId),
        columns: { id: true, properties: true },
      });
      const props =
        (existing?.properties as Record<string, unknown> | null | undefined) ??
        {};
      if (props.linkedUserId !== member.id) {
        if (props.linkedUserId == null || props.linkedUserId === "") {
          await tx
            .update(entities)
            .set({
              properties: { ...props, linkedUserId: member.id },
              updatedAt: new Date(),
            })
            .where(eq(entities.id, entityId));
        }
      } else {
        // Idempotent re-run on an already-linked person.
        action = "updated";
      }
    }

    await tryAttachTeamMemberFacet(tx, {
      entityId,
      workspaceId: input.workspaceId,
      ownerUserId,
    });

    return { entityId, action };
  });
}

/**
 * A weak (same-name) resolve is only trusted to LINK when the candidate's stored
 * email matches the member's — name alone must never merge two humans. Returns
 * false when the candidate has no email or a different one (→ create instead).
 */
async function weakMatchEmailCorroborates(
  db: Db,
  candidateEntityId: string,
  memberEmail: string
): Promise<boolean> {
  const candidate = await db.query.entities.findFirst({
    where: eq(entities.id, candidateEntityId),
    columns: { properties: true },
  });
  const candEmail = (
    candidate?.properties as Record<string, unknown> | null | undefined
  )?.email;
  return (
    typeof candEmail === "string" &&
    candEmail.trim().toLowerCase() === memberEmail.toLowerCase()
  );
}

async function tryAttachTeamMemberFacet(
  db: Db,
  args: { entityId: string; workspaceId: string; ownerUserId: string }
): Promise<void> {
  try {
    const silentEventRepo = createSilentEventRepo();
    const facetRepo = new FacetRepository(db, silentEventRepo);
    await facetRepo.attach(
      {
        entityId: args.entityId,
        profileSlug: "team-member",
        userId: args.ownerUserId,
        workspaceId: args.workspaceId,
        skipValidation: true,
      },
      args.ownerUserId
    );
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      logger.debug(
        { workspaceId: args.workspaceId, entityId: args.entityId },
        "team-member profile missing — skipping facet attach"
      );
      return;
    }
    logger.warn(
      { err, entityId: args.entityId, workspaceId: args.workspaceId },
      "team-person-bridge: team-member facet attach failed (person preserved)"
    );
  }
}

export interface DetachTeamMemberFacetInput {
  memberUserId: string;
  workspaceId: string;
  /** Fallback owner when no WS owner row (same as ensure). */
  ownerUserId: string;
}

export interface DetachTeamMemberFacetResult {
  detached: boolean;
  entityId: string | null;
  reason?: string;
}

/**
 * Soft-detach live `team-member` facets for a human leaving a workspace.
 * Person entity is kept (roster→CRM continuity). Never throws.
 */
export async function detachTeamMemberFacet(
  db: Db,
  input: DetachTeamMemberFacetInput
): Promise<DetachTeamMemberFacetResult> {
  try {
    return await detachTeamMemberFacetInner(db, input);
  } catch (err) {
    logger.warn(
      {
        err,
        memberUserId: input.memberUserId,
        workspaceId: input.workspaceId,
      },
      "team-person-bridge: detach failed (membership remove preserved)"
    );
    return { detached: false, entityId: null, reason: "error" };
  }
}

async function detachTeamMemberFacetInner(
  db: Db,
  input: DetachTeamMemberFacetInput
): Promise<DetachTeamMemberFacetResult> {
  const member = await db.query.users.findFirst({
    where: eq(users.id, input.memberUserId),
    columns: {
      id: true,
      email: true,
      name: true,
      userType: true,
    },
  });

  if (!member) {
    return {
      detached: false,
      entityId: null,
      reason: "user_not_found",
    };
  }

  if (member.userType === "agent") {
    return {
      detached: false,
      entityId: null,
      reason: "agent",
    };
  }

  const ownerUserId =
    (await resolveWorkspaceOwnerUserId(db, input.workspaceId)) ??
    input.ownerUserId;

  const displayName = member.name?.trim() || member.email?.trim() || "Member";

  const signals: IdentitySignal[] = [
    {
      type: "external_id",
      value: userExternalIdSignal(member.id),
    },
  ];
  if (member.email?.trim()) {
    signals.push({ type: "email", value: member.email.trim() });
  }

  const resolution = await resolveIdentity(db, {
    userId: ownerUserId,
    kindSlug: "person",
    name: displayName,
    signals,
  });

  if (!(resolution.match === "strong" && resolution.entity)) {
    return {
      detached: false,
      entityId: null,
      reason: "no_person",
    };
  }

  const entityId = resolution.entity.id;

  const liveFacets = await db
    .select({ id: entityFacets.id })
    .from(entityFacets)
    .innerJoin(profiles, eq(entityFacets.profileId, profiles.id))
    .where(
      and(
        eq(entityFacets.entityId, entityId),
        eq(entityFacets.workspaceId, input.workspaceId),
        eq(profiles.slug, "team-member"),
        isNull(entityFacets.deletedAt)
      )
    );

  if (liveFacets.length === 0) {
    return {
      detached: false,
      entityId,
      reason: "no_facet",
    };
  }

  // Facets were attached with ownerUserId — detach filters by facet.userId.
  const silentEventRepo = createSilentEventRepo();
  const facetRepo = new FacetRepository(db, silentEventRepo);
  for (const facet of liveFacets) {
    await facetRepo.detach(facet.id, ownerUserId);
  }

  return { detached: true, entityId };
}

export interface BackfillTeamPersonBridgeInput {
  workspaceId: string;
  ownerUserId: string;
}

export interface BackfillTeamPersonBridgeResult {
  scanned: number;
  created: number;
  linked: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Ensure person + team-member facet for every human workspace member.
 * Best-effort per member; never throws.
 */
export async function backfillTeamPersonBridge(
  db: Db,
  input: BackfillTeamPersonBridgeInput
): Promise<BackfillTeamPersonBridgeResult> {
  const counts: BackfillTeamPersonBridgeResult = {
    scanned: 0,
    created: 0,
    linked: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    const memberRows = await db
      .select({
        userId: workspaceMembers.userId,
        userType: users.userType,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, input.workspaceId));

    const humans = memberRows.filter((m) => m.userType !== "agent");
    counts.scanned = humans.length;

    for (const human of humans) {
      const result = await ensureTeamPersonForMember(db, {
        memberUserId: human.userId,
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
      });

      switch (result.action) {
        case "created":
          counts.created += 1;
          break;
        case "linked":
          counts.linked += 1;
          break;
        case "updated":
          counts.updated += 1;
          break;
        case "skipped":
          if (result.reason === "error") {
            counts.errors += 1;
          } else {
            counts.skipped += 1;
          }
          break;
      }
    }
  } catch (err) {
    logger.warn(
      { err, workspaceId: input.workspaceId },
      "team-person-bridge: backfill failed"
    );
    counts.errors += 1;
  }

  return counts;
}

/** No-op EventRepository so Entity/Facet repos can run without writing events. */
function createSilentEventRepo(): EventRepository {
  return {
    append: async () =>
      ({
        id: "silent",
        timestamp: new Date(),
        subjectId: "silent",
        subjectType: "entity",
        eventType: "silent",
        userId: "silent",
        data: {},
        version: 1,
        source: "system",
      }) as Awaited<ReturnType<EventRepository["append"]>>,
  } as unknown as EventRepository;
}
