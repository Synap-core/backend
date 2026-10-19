/**
 * VERB WRITE-BACK — a verb that creates something OUTSIDE the pod records the
 * outside id on the Synap object it was run for, as part of the same act.
 *
 * Example: `postiz_schedule_post` queues a post in Postiz and returns its
 * `postId`; the Synap `post` it was run for must carry it as `postiz-post-id`
 * so the Postiz "published" webhook can find it. The run is propose-only, so it
 * usually executes when a PERSON approves it — long after the agent that filed
 * it stopped watching. Recording the id therefore cannot be the agent's next
 * step; it belongs to the run itself.
 *
 * DECLARED, not coded: the skill carries (catalog-authored; the applier's
 * `projectSkillMetadata` installs it and the drift comparator converges it —
 * `declaredWriteBack` in capability-drift.ts is the one parser for both)
 *
 *   metadata.writeBack = {
 *     entityParam: "postEntityId",          // the run parameter naming the object
 *     kind: "post",                          // the only kind it may write
 *     properties: { "postiz-post-id": "postId" }  // property ← dot-path in the result
 *   }
 *
 * BOUNDS — what the declaration cannot widen:
 *  - the object is the one the RUN'S OWN parameters name (shown on the
 *    proposal the person approved), of the declared kind, and inside the WRITE
 *    floor (`entityWriteVisibleWhere`) of the identity the run EXECUTED as —
 *    on an approved proposal that is the approving person, whose connection
 *    the provider act itself used: the write-back is part of the act they
 *    approved, under the same identity;
 *  - only scalar values are written, only to the declared properties, and
 *    NEVER to the kind's lifecycle property (a status moves through
 *    `moveStatus`, never here).
 *
 * Runs only after the provider act succeeded, so a failure here never turns a
 * delivered run into an error (a retry would send twice). It is REPORTED on
 * the run result instead (`writeBack`), which the approved proposal stores.
 */
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  entities,
  profileSlugScopeCondition,
  ProfileResolutionService,
} from "@synap/database";
import { entityWriteVisibleWhere } from "../../routers/entities/helpers.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";
import { declaredWriteBack } from "./capability-drift.js";

export type VerbWriteBackReport =
  | {
      status: "recorded";
      entityId: string;
      properties: Record<string, unknown>;
    }
  /** `entityId` null: the write-back could not even be checked (read failed). */
  | { status: "failed"; entityId: string | null; reason: string };

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Applies the skill's declared write-back for one successful run. Returns null
 * when there is nothing to do (no declaration, or the run named no object).
 */
export async function applyVerbWriteBack(args: {
  /** The run skill's `metadata` (the loaders select it: `ResolvedSkillRow`). */
  metadata: unknown;
  parameters: Record<string, unknown> | undefined;
  result: unknown;
  /** The identity the run executed as. */
  userId: string;
}): Promise<VerbWriteBackReport | null> {
  const spec = declaredWriteBack(
    args.metadata as Record<string, unknown> | null
  );
  if (!spec) return null;
  const entityId = args.parameters?.[spec.entityParam];
  if (typeof entityId !== "string" || entityId.length === 0) return null;

  // The kind-aware scope door: a declared role matches its wearers too.
  const kindScope = await profileSlugScopeCondition(
    db,
    spec.kind,
    await resolveFacetVisibilityScope(args.userId, undefined)
  );
  const [target] = await db
    .select({
      id: entities.id,
      profileId: entities.profileId,
      workspaceId: entities.workspaceId,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        kindScope,
        isNull(entities.deletedAt),
        entityWriteVisibleWhere(args.userId)
      )
    )
    .limit(1);
  if (!target) {
    return {
      status: "failed",
      entityId,
      reason: `No ${spec.kind} you can edit has this id`,
    };
  }

  const lifecycle = target.profileId
    ? await new ProfileResolutionService(db).getEffectiveLifecycle(
        target.profileId,
        target.workspaceId
      )
    : null;
  const patch: Record<string, unknown> = {};
  for (const [property, path] of Object.entries(spec.properties)) {
    if (property === lifecycle?.propertySlug) continue;
    const value = getPath(args.result, path);
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      patch[property] = value;
    }
  }
  if (Object.keys(patch).length === 0) {
    return {
      status: "failed",
      entityId,
      reason: `The run returned none of ${Object.values(spec.properties).join(", ")}`,
    };
  }

  await db
    .update(entities)
    .set({
      properties: drizzleSql`COALESCE(${entities.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(entities.id, target.id));
  return { status: "recorded", entityId, properties: patch };
}
