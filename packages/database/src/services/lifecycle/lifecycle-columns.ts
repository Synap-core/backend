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
 * The columns a new row of `profileId` gets from its `properties`, or `null`
 * when the profile declares no lifecycle.
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
