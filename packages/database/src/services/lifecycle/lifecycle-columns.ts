/**
 * The lifecycle COLUMNS for a row being BORN (create / attach) or re-typed —
 * the only writes besides `applyStatusMove` that set `status` /
 * `status_category`. A born row has no "from", so this is not a move: it
 * derives the columns from the same value the read projection
 * `properties[<lifecycle slug>]` holds, so the two agree from the first byte.
 *
 * Also the repository GUARD: a write that changes the lifecycle key through
 * the generic property path (anything but the `moveStatus` door) is refused
 * with {@link LifecycleWriteOutsideDoorError}. Re-sending the CURRENT value is
 * allowed (forms send every field back) — it moves nothing.
 */
import type { ProfileResolutionService } from "../profile-resolution-service.js";
import {
  findLifecycleOption,
  type EffectiveLifecycle,
  type LifecycleCategory,
} from "../../utils/lifecycle-model.js";

export class LifecycleWriteOutsideDoorError extends Error {
  readonly code = "LIFECYCLE_WRITE_OUTSIDE_DOOR" as const;
  constructor(readonly propertySlug: string) {
    super(
      `"${propertySlug}" is this record's lifecycle status: move it through the status door (moveStatus), not a property write.`
    );
    this.name = "LifecycleWriteOutsideDoorError";
  }
}

export interface LifecycleColumns {
  propertySlug: string;
  status: string | null;
  statusCategory: LifecycleCategory | null;
}

/** Columns for `value` under `lifecycle` (an unknown value keeps no category). */
export function columnsForValue(
  lifecycle: EffectiveLifecycle,
  value: unknown
): LifecycleColumns {
  const status = typeof value === "string" && value !== "" ? value : null;
  return {
    propertySlug: lifecycle.propertySlug,
    status,
    statusCategory: findLifecycleOption(lifecycle, status)?.category ?? null,
  };
}

/**
 * The value a row is BORN with: the creator's, else the lifecycle's declared
 * initial status (`initialStatus`). Every birth door reads it — entity create
 * ({@link bornLifecycleColumnsFor}) and role attach — so a thing whose kind
 * declares a lifecycle is never born with no status just because its creator
 * named none (finding 8c869510). Still a birth, not a move: no transition.
 */
export function bornLifecycleValue(
  lifecycle: EffectiveLifecycle,
  value: unknown
): unknown {
  return value === undefined || value === null || value === ""
    ? (lifecycle.initialStatus ?? value)
    : value;
}

/**
 * The columns a row of `profileId` BORN with `properties` gets (the creator's
 * value, else the declared initial status), plus the read projection agreeing
 * with them; `null` when the profile declares no lifecycle.
 */
export async function bornLifecycleColumnsFor(
  resolver: ProfileResolutionService,
  profileId: string | null | undefined,
  workspaceId: string | null | undefined,
  properties: Record<string, unknown>
): Promise<{
  columns: LifecycleColumns;
  properties: Record<string, unknown>;
} | null> {
  if (!profileId) return null;
  const lifecycle = await resolver.getEffectiveLifecycle(
    profileId,
    workspaceId
  );
  if (!lifecycle) return null;
  const columns = columnsForValue(
    lifecycle,
    bornLifecycleValue(lifecycle, properties[lifecycle.propertySlug])
  );
  return {
    columns,
    properties:
      columns.status !== null &&
      properties[lifecycle.propertySlug] !== columns.status
        ? { ...properties, [lifecycle.propertySlug]: columns.status }
        : properties,
  };
}

/**
 * The columns a row of `profileId` gets from its `properties` as they stand
 * (a re-type or a merge — never a birth), or `null` when the profile declares
 * no lifecycle.
 */
export async function lifecycleColumnsFor(
  resolver: ProfileResolutionService,
  profileId: string | null | undefined,
  workspaceId: string | null | undefined,
  properties: Record<string, unknown> | null | undefined
): Promise<LifecycleColumns | null> {
  if (!profileId) return null;
  const lifecycle = await resolver.getEffectiveLifecycle(
    profileId,
    workspaceId
  );
  if (!lifecycle) return null;
  return columnsForValue(lifecycle, properties?.[lifecycle.propertySlug]);
}

/**
 * Refuse a generic property write that would MOVE the lifecycle key. `current`
 * is the column, `projected` the JSONB copy (they differ only on a pod the
 * backfill has not reached yet — either is "the current value").
 */
export function assertNoLifecycleMove(
  lifecycle: EffectiveLifecycle | null,
  write: {
    properties?: Record<string, unknown> | null;
    deleteProperties?: readonly string[] | null;
  },
  current: { status: string | null; projected: unknown }
): void {
  if (!lifecycle) return;
  const slug = lifecycle.propertySlug;
  if (write.deleteProperties?.includes(slug)) {
    throw new LifecycleWriteOutsideDoorError(slug);
  }
  if (write.properties && slug in write.properties) {
    const v = write.properties[slug];
    if (v !== current.status && v !== current.projected) {
      throw new LifecycleWriteOutsideDoorError(slug);
    }
  }
}
