/**
 * The LIFECYCLE GUARD on a property def (work model L1; review arch F1,
 * backend F5).
 *
 * A def that backs a declared lifecycle (`profile_properties.is_lifecycle`) is
 * not a plain select: rows hold `properties[slug]`, the columns hold the
 * value's category, workers and rules name the keys. So the GENERIC def-update
 * door (`propertyDefs.update`, which the hub door and the proposal executor
 * both reach) may only APPEND options, each with a category, and edit labels /
 * tones. It may not rename the slug, change the value type, remove or rename
 * an option, recategorise one, or write a bare `enum` that would drop the
 * categories: `checkLifecycleDefUpdate` refuses all of those with guidance.
 *
 * Recategorising or retiring an option goes through the LIFECYCLE DOOR,
 * `changeLifecycleOptions`: every removed key names its remap, rows move in the
 * same transaction, and the columns are re-projected. A def with no declared
 * lifecycle keeps the legacy path untouched.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import { profileProperties } from "../../schema/profile-properties.js";
import { propertyDefs } from "../../schema/property-defs.js";
import {
  buildStoredConstraints,
  normalizeEnumOptions,
  readStoredEnumOptions,
  type StoredEnumOption,
} from "../../utils/property-enum.js";
import {
  isLifecycleCategory,
  parseLifecycleOptions,
  LIFECYCLE_CATEGORIES,
} from "../../utils/lifecycle-model.js";
import { lifecycleProjectionStatements } from "./project-lifecycle-columns.js";

type Db = PostgresJsDatabase<typeof schema>;

export const LIFECYCLE_DEF_PROTECTED = "LIFECYCLE_DEF_PROTECTED" as const;

/** A generic def write that would break a declared lifecycle. */
export class LifecycleDefChangeError extends Error {
  readonly code = LIFECYCLE_DEF_PROTECTED;
  /** Forwarded to tRPC clients as `error.data.reasonCode`. */
  readonly reasonCode = LIFECYCLE_DEF_PROTECTED;
  constructor(readonly reasons: string[]) {
    super(
      `This property is a declared lifecycle: ${reasons.join("; ")}. ` +
        `Append options (each with a category: ${LIFECYCLE_CATEGORIES.join(", ")}) here; ` +
        `recategorise or retire one through the lifecycle door, naming where its things move.`
    );
    this.name = "LifecycleDefChangeError";
  }
}

/** The profiles whose lifecycle this def IS (empty = a plain property). */
export async function lifecycleProfilesOfDef(
  db: Db,
  propertyDefId: string
): Promise<string[]> {
  const rows = await db
    .select({ profileId: profileProperties.profileId })
    .from(profileProperties)
    .where(
      and(
        eq(profileProperties.propertyDefId, propertyDefId),
        eq(profileProperties.isLifecycle, true)
      )
    );
  return rows.map((r) => r.profileId);
}

interface DefShape {
  slug: string;
  valueType: string;
  constraints: unknown;
  uiHints?: unknown;
}

function storedOptions(def: DefShape): StoredEnumOption[] {
  return (
    readStoredEnumOptions({
      constraints: def.constraints as Record<string, unknown> | null,
      uiHints: (def.uiHints ?? null) as Record<string, unknown> | null,
    }) ?? []
  );
}

/**
 * Pure: judge a generic update of a LIFECYCLE def. Returns the constraints to
 * store (through the one mapper, categories kept) and whether the option set
 * changed (⇒ re-project). Throws `LifecycleDefChangeError` on a refusal.
 */
export function checkLifecycleDefUpdate(
  existing: DefShape,
  input: { slug?: string; valueType?: string; constraints?: unknown }
): { constraints?: Record<string, unknown>; optionsChanged: boolean } {
  const reasons: string[] = [];
  if (input.slug !== undefined && input.slug !== existing.slug) {
    reasons.push(
      `its key "${existing.slug}" cannot be renamed (every thing stores its status under it)`
    );
  }
  if (input.valueType !== undefined && input.valueType !== existing.valueType) {
    reasons.push("its value type cannot change");
  }
  if (input.constraints === undefined) {
    if (reasons.length) throw new LifecycleDefChangeError(reasons);
    return { optionsChanged: false };
  }

  const before = storedOptions(existing);
  const old = new Map(before.map((o) => [o.key, o]));
  const c = (input.constraints ?? {}) as Record<string, unknown>;
  const authored =
    normalizeEnumOptions(c.enumOptions) ?? normalizeEnumOptions(c.enum);
  if (!authored) {
    reasons.push("its options cannot be emptied");
    throw new LifecycleDefChangeError(reasons);
  }

  const merged: StoredEnumOption[] = authored.map((o) => {
    const prev = old.get(o.key);
    if (!prev) {
      if (!isLifecycleCategory(o.category)) {
        reasons.push(`the new option "${o.key}" needs a category`);
      }
      return o;
    }
    // A bare `enum` write (no option objects) keeps what the option was.
    const category = o.category ?? prev.category;
    if (prev.category !== undefined && category !== prev.category) {
      reasons.push(
        `"${o.key}" cannot move from ${prev.category} to ${category} here`
      );
    }
    return {
      ...prev,
      ...o,
      ...(category !== undefined ? { category } : {}),
    };
  });
  const kept = new Set(merged.map((o) => o.key));
  for (const o of before) {
    if (!kept.has(o.key)) {
      reasons.push(`"${o.key}" cannot be removed or renamed here`);
    }
  }
  if (reasons.length) throw new LifecycleDefChangeError(reasons);

  const signature = (opts: StoredEnumOption[]) =>
    opts
      .map((o) => `${o.key}:${o.category ?? ""}`)
      .sort()
      .join("|");
  return {
    constraints: buildStoredConstraints({
      constraints: { ...c, enumOptions: merged },
    }),
    optionsChanged: signature(merged) !== signature(before),
  };
}

/** Re-derive the status columns of every row of these profiles (and heirs). */
export async function reprojectLifecycleProfiles(
  db: Db,
  profileIds: readonly string[]
): Promise<void> {
  for (const id of profileIds) {
    for (const { statement } of lifecycleProjectionStatements(id)) {
      await db.execute(statement);
    }
  }
}

export type ChangeLifecycleOptionsResult =
  | { status: "changed"; remapped: number }
  | { status: "unchanged" }
  | { status: "refused"; reason: string };

/**
 * THE LIFECYCLE DOOR for an option change the generic path refuses:
 * recategorise, rename or retire. `options` is the complete new list (every
 * option categorised). Every key that disappears names its destination in
 * `remap`, which must be a key of the new list; the things at it move there,
 * the def is rewritten through the one mapper, and the columns re-project —
 * one transaction. A move here is a schema change, not a status move: no
 * transition events are emitted for the remapped rows.
 */
export async function changeLifecycleOptions(
  db: Db,
  input: {
    propertyDefId: string;
    options: unknown[];
    remap?: Record<string, string>;
  }
): Promise<ChangeLifecycleOptionsResult> {
  const profileIds = await lifecycleProfilesOfDef(db, input.propertyDefId);
  if (profileIds.length === 0) {
    return { status: "refused", reason: "this property is not a lifecycle" };
  }
  const [def] = await db
    .select()
    .from(propertyDefs)
    .where(eq(propertyDefs.id, input.propertyDefId))
    .limit(1);
  if (!def) return { status: "refused", reason: "property not found" };

  const { options, errors } = parseLifecycleOptions(input.options);
  if (errors.length) return { status: "refused", reason: errors.join("; ") };
  const next = new Set(options.map((o) => o.key));
  const before = storedOptions(def);
  const remap = input.remap ?? {};
  const moves: Array<[string, string]> = [];
  for (const o of before) {
    if (next.has(o.key)) continue;
    const to = remap[o.key];
    if (!to || !next.has(to)) {
      return {
        status: "refused",
        reason: `"${o.key}" is retired: name where its things move (one of ${[...next].join(", ")})`,
      };
    }
    moves.push([o.key, to]);
  }
  const same =
    before.length === options.length &&
    options.every((o, i) => {
      const b = before[i];
      return (
        b?.key === o.key &&
        b.category === o.category &&
        b.label === o.label &&
        b.tone === o.tone &&
        Boolean(b.humanOnly) === Boolean(o.humanOnly) &&
        b.stuckAfterDays === o.stuckAfterDays
      );
    });
  if (same) return { status: "unchanged" };

  const slug = def.slug;
  let remapped = 0;
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    for (const [from, to] of moves) {
      for (const table of ["entities", "entity_facets"] as const) {
        const res = await t.execute(sql`
          WITH RECURSIVE heirs AS (
            SELECT id FROM profiles WHERE id IN (${sql.join(
              profileIds.map((id) => sql`${id}::uuid`),
              sql`, `
            )})
            UNION
            SELECT p.id FROM profiles p JOIN heirs h ON p.parent_profile_id = h.id
          )
          UPDATE ${sql.raw(table)}
             SET properties = jsonb_set(properties, ARRAY[${slug}]::text[], to_jsonb(${to}::text), true),
                 updated_at = now()
           WHERE profile_id IN (SELECT id FROM heirs)
             AND deleted_at IS NULL
             AND properties->>${slug} = ${from}
          RETURNING id`);
        // postgres.js returns the rows; the PGlite driver wraps them.
        const rows = Array.isArray(res)
          ? res
          : ((res as { rows?: unknown[] }).rows ?? []);
        remapped += rows.length;
      }
    }
    await t
      .update(propertyDefs)
      .set({
        constraints: buildStoredConstraints({
          constraints: {
            ...((def.constraints ?? {}) as Record<string, unknown>),
            enumOptions: options,
          },
        }),
        updatedAt: new Date(),
      })
      .where(eq(propertyDefs.id, def.id));
    await reprojectLifecycleProfiles(t, profileIds);
  });
  return { status: "changed", remapped };
}

/** Refuse deleting a def that IS a lifecycle. */
export async function assertNotLifecycleDef(
  db: Db,
  propertyDefIds: readonly string[]
): Promise<void> {
  if (propertyDefIds.length === 0) return;
  const rows = await db
    .select({ id: profileProperties.propertyDefId })
    .from(profileProperties)
    .where(
      and(
        inArray(profileProperties.propertyDefId, [...propertyDefIds]),
        eq(profileProperties.isLifecycle, true)
      )
    )
    .limit(1);
  if (rows.length) {
    throw new LifecycleDefChangeError(["it cannot be deleted"]);
  }
}
