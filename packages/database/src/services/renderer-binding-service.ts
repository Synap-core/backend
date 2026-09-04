/**
 * Renderer Bindings — the ONE write door for the `renderer_bindings` store
 * that {@link ProfileResolutionService.getEffectiveRendererWithSource} reads at
 * layer 0.
 *
 * K1 landed the table and the read rungs with NO writer, so the table was empty
 * on every pod and resolution was byte-identical to the legacy chain. This is
 * that writer. It is DELIBERATELY the only one: every surface that binds a
 * renderer (tRPC `profiles.setProfileRendererOverride`, the Hub `setRenderer`
 * route, MCP `synap_promote_cell_to_renderer`, and the `profile/renderer.set`
 * proposal executor) reaches the table through
 * `packages/api/src/services/profiles/set-profile-renderer.ts`, which calls
 * these two functions and nothing else. A second insert path is how the three
 * legacy stores this table replaces came to disagree in the first place.
 *
 * PURE BY DESIGN — no authorization happens here. The database layer has no
 * access to `isPodAdmin` / workspace-membership (they live in `@synap/api`), and
 * duplicating them would be a second, drifting copy of the floor. Authorization
 * is `assertMayBindRenderer` in the api layer, exactly as the profile renderer
 * service already splits gate-then-write. What IS enforced here are the SHAPE
 * invariants that the DB CHECK constraint also enforces, so a violation is a
 * readable error rather than a constraint code from the driver.
 *
 * UPSERT = REVOKE-THEN-INSERT. The partial unique index
 * (`renderer_bindings_active_unique`, `WHERE revoked_at IS NULL`) permits ONE
 * active row per (scope, owner, subject, contentKind). Rebinding therefore
 * stamps `revoked_at` on the incumbent and inserts a new row inside ONE
 * transaction, rather than UPDATE-ing the ref in place: the superseded row
 * survives as history (who bound what, when, and from which proposal), which is
 * the same tombstone-not-DELETE choice `governance_rules` made.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

import {
  rendererBindings,
  type RendererBinding,
  type RendererBindingScope,
} from "../schema/renderer-bindings.js";
import type {
  ProfileRendererContentKind,
  RendererRef,
} from "./profile-resolution-service.js";

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Which row a binding write addresses. Shared by set and revoke so the two can
 * never key on different columns — the identity of a binding is exactly the
 * partial-unique key, and it is spelled once.
 */
export interface RendererBindingKey {
  scopeKind: RendererBindingScope;
  /** REQUIRED for `scopeKind: 'user'`; must be absent otherwise. */
  userId?: string | null;
  /** REQUIRED for `scopeKind: 'workspace'`; must be absent otherwise. */
  workspaceId?: string | null;
  /** Entity subjects: the profile slug. Everything else: the object-nav kind. */
  subjectKind: string;
  /** `null`/omitted = the whole KIND. A value pins ONE object. */
  subjectId?: string | null;
  contentKind: ProfileRendererContentKind;
}

export interface SetRendererBindingInput extends RendererBindingKey {
  ref: RendererRef;
  /** Set when a proposal approval minted this row — the lineage `governance_rules` also keeps. */
  sourceProposalId?: string | null;
  /** The acting identity, recorded as `created_by`. */
  actorUserId: string;
}

export type RevokeRendererBindingInput = RendererBindingKey & {
  actorUserId: string;
};

/**
 * Refuse a shape the resolver could not read back correctly.
 *
 * A `user` row with no owner is invisible by construction (both the resolver's
 * scope branch and the access-layer VisibilityRule floor user rows on
 * `user_id`), and a `workspace` row with no workspace would silently widen into
 * a pod row. The DB CHECK refuses both; this turns the refusal into a message
 * that names the offending field, and additionally refuses the mirror error the
 * CHECK cannot see — an owner column set on a scope that does not own it, which
 * would otherwise persist a `pod` row carrying someone's `user_id`.
 */
function assertBindingShape(key: RendererBindingKey): void {
  const { scopeKind, userId, workspaceId } = key;
  if (scopeKind === "user" && !userId) {
    throw new Error("renderer binding: scope 'user' requires a userId");
  }
  if (scopeKind === "workspace" && !workspaceId) {
    throw new Error(
      "renderer binding: scope 'workspace' requires a workspaceId"
    );
  }
  if (scopeKind !== "user" && userId) {
    throw new Error(
      `renderer binding: scope '${scopeKind}' must not carry a userId`
    );
  }
  if (scopeKind !== "workspace" && workspaceId) {
    throw new Error(
      `renderer binding: scope '${scopeKind}' must not carry a workspaceId`
    );
  }
  if (!key.subjectKind.trim()) {
    throw new Error("renderer binding: subjectKind is required");
  }
}

/**
 * The WHERE that isolates the ONE active row a key addresses.
 *
 * `coalesce` over the nullable owner/subject columns mirrors the partial unique
 * index exactly — a plain `eq(col, null)` is never true in SQL, so without this
 * a whole-KIND rebind would match nothing, leave the incumbent active, and hit
 * the unique index on insert.
 */
/**
 * The ONE "this binding is live" predicate.
 *
 * A revoked binding is a TOMBSTONE, not a delete: the row stays as history and
 * resolution must walk past it. Every reader therefore has to exclude it, and a
 * reader that forgets serves a renderer the user explicitly unbound. Exported so
 * the resolver (`ProfileResolutionService.resolveRendererBinding`) and the
 * access-layer `VisibilityRule` for `rendererBindings` share this expression
 * rather than each spelling it out — a source-scan tripwire pins that they do.
 */
export function activeRendererBindingWhere() {
  return isNull(rendererBindings.revokedAt);
}

function activeRowWhere(key: RendererBindingKey) {
  return and(
    activeRendererBindingWhere(),
    eq(rendererBindings.scopeKind, key.scopeKind),
    sql`coalesce(${rendererBindings.userId}, '') = ${key.userId ?? ""}`,
    sql`coalesce(${rendererBindings.workspaceId}::text, '') = ${
      key.workspaceId ?? ""
    }`,
    eq(rendererBindings.subjectKind, key.subjectKind),
    sql`coalesce(${rendererBindings.subjectId}, '') = ${key.subjectId ?? ""}`,
    eq(rendererBindings.contentKind, key.contentKind)
  );
}

/**
 * Bind a renderer for (scope, subject, contentKind) — creating the row, or
 * superseding whatever was bound there.
 *
 * Caller MUST have authorized first (`assertMayBindRenderer` in the api layer).
 * Returns the NEW row, so an executor can record what it minted.
 */
export async function setRendererBinding(
  db: Db,
  input: SetRendererBindingInput
): Promise<RendererBinding> {
  assertBindingShape(input);

  // REVOKE-then-INSERT is not atomic against a concurrent identical call: two
  // callers can both revoke the incumbent, then race on the partial unique
  // index and one gets 23505. That loser is not a conflict the user caused —
  // by the time it retries, the winner's row IS the incumbent, so a single
  // retry supersedes it and both calls report the intent they were given.
  // One retry, not a loop: a second 23505 means something other than this race.
  try {
    return await bindOnce(db, input);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return await bindOnce(db, input);
  }
}

/** Postgres `unique_violation`, however the driver surfaced it. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    ((err as { code?: unknown }).code === "23505" ||
      (err as { cause?: { code?: unknown } }).cause?.code === "23505")
  );
}

async function bindOnce(
  db: Db,
  input: SetRendererBindingInput
): Promise<RendererBinding> {
  return await db.transaction(async (tx) => {
    // Supersede, never overwrite: the incumbent becomes history.
    await tx
      .update(rendererBindings)
      .set({ revokedAt: new Date() })
      .where(activeRowWhere(input));

    const [row] = await tx
      .insert(rendererBindings)
      .values({
        scopeKind: input.scopeKind,
        userId: input.scopeKind === "user" ? (input.userId ?? null) : null,
        workspaceId:
          input.scopeKind === "workspace" ? (input.workspaceId ?? null) : null,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId ?? null,
        contentKind: input.contentKind,
        ref: input.ref,
        sourceProposalId: input.sourceProposalId ?? null,
        createdBy: input.actorUserId,
      })
      .returning();

    return row;
  });
}

/**
 * Unbind whatever is active at (scope, subject, contentKind) — the `ref: null`
 * half of the door. A no-op when nothing is bound (idempotent by design: the
 * caller's intent is "nothing bound here", which is already true).
 *
 * A tombstone, NOT a delete: resolution walks on to the next rung exactly as if
 * the row had never existed, but the row itself remains as history.
 */
export async function revokeRendererBinding(
  db: Db,
  input: RevokeRendererBindingInput
): Promise<{ revoked: number }> {
  assertBindingShape(input);

  const rows = await db
    .update(rendererBindings)
    .set({ revokedAt: new Date() })
    .where(activeRowWhere(input))
    .returning({ id: rendererBindings.id });

  return { revoked: rows.length };
}
