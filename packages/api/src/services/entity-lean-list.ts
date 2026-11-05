/**
 * THE lean projection of an entity LIST read by an AI (founder, 2026-11-05):
 * "every place that lists multiple objects to an AI never returns the full
 * data of each object: it returns id, name, status and the kind's selected
 * properties. For more, the AI reads that one object."
 *
 * One door, two callers: MCP `synap_get_entities` (default) and Hub REST
 * `GET /users/:userId/entities?projection=lean` (the Intelligence Service's
 * `list_entities`). Before it, the two projected differently and the IS one
 * kept the FIRST 3 non-empty properties in storage order and never the status
 * column: 22 of 25 ideas listed with no status and no pillar, and the run read
 * all 25 one by one (finding 4a5b88a7).
 *
 * A lean row:
 *   - `id`, `title`, `kind`, `status`, `statusCategory`, `statusLabel` (the
 *     lifecycle is never dropped), `workspaceId`, `updatedAt`, and
 *     `lastInteractionAt` / `description` when set;
 *   - `properties`: the kind's SELECTED properties, chosen from its property
 *     defs, best first: select/enum, entity references, dates, numbers and
 *     booleans, short strings and lists of scalars, then long strings
 *     (truncated with a marker). At most {@link LEAN_LIST_MAX_PROPERTIES}.
 *     The lifecycle property is not repeated when it equals `status`; a
 *     `title` property equal to the title is not repeated; secrets and nested
 *     objects never ride in a list;
 *   - `omitted`: the property keys that were left out, so nothing is
 *     unreachable — name them in `fields` (returned whole, never truncated),
 *     or read the one object.
 */

import { db as defaultDb, ProfileResolutionService } from "@synap/database";
import { lifecycleOptionLabel } from "@synap-core/types/lifecycle";

/**
 * Long string cap in a lean row. 120 chars is enough to recognise a note.
 * Measured: at 200 the 50-note budget fixture came to 41,710 chars (over
 * budget), because the ~14 live UUID/timestamp columns per row were fixed cost.
 */
export const ENTITY_STRING_CAP = 120;

/** At most this many properties per lean row (the rest are named in `omitted`). */
export const LEAN_LIST_MAX_PROPERTIES = 8;

/** At most this many items of a list-of-scalars property (e.g. tags). */
const LEAN_LIST_ARRAY_CAP = 10;

export function capString(value: string, cap: number): string {
  return value.length > cap
    ? `${value.slice(0, cap)}…[truncated: ${value.length} chars total]`
    : value;
}

/** What the projection needs of one effective property def. */
export interface LeanPropertyDef {
  slug: string;
  valueType: string;
  uiHints?: { inputType?: string | null } | null;
  constraints?: unknown;
  isLifecycle?: boolean;
  displayOrder?: number | null;
}

/** What the projection needs of a kind: its defs and its lifecycle labels. */
export interface LeanKindShape {
  defs: ReadonlyArray<LeanPropertyDef>;
  /** lifecycle option key → its words. */
  statusLabels?: ReadonlyMap<string, string>;
}

/** Top-level columns a lean row carries (when set). */
const LEAN_ROW_COLUMNS = [
  "id",
  "title",
  "status",
  "statusCategory",
  "workspaceId",
  "updatedAt",
  "lastInteractionAt",
] as const;

const SELECT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "select",
  "multiselect",
  "multi-select",
  "radio",
  "status",
  "tags",
]);
const ENTITY_INPUT_TYPES: ReadonlySet<string> = new Set([
  "entity",
  "entity-select",
  "person",
]);
const DATE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "date",
  "datetime",
  "datetime-local",
]);

/** Rank of a property in a lean row: lower is kept first. `null` = never. */
type Rank = number | null;

const RANK = {
  lifecycle: 0,
  select: 1,
  entity: 2,
  date: 3,
  scalar: 4,
  short: 5,
  long: 6,
} as const;

function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

function hasEnum(constraints: unknown): boolean {
  return (
    typeof constraints === "object" &&
    constraints !== null &&
    Array.isArray((constraints as { enum?: unknown }).enum)
  );
}

/** Rank by the stored VALUE alone (an undeclared key, or a declared plain string). */
function rankOfValue(value: unknown): Rank {
  if (typeof value === "string") {
    return value.length > ENTITY_STRING_CAP ? RANK.long : RANK.short;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return RANK.scalar;
  }
  if (Array.isArray(value) && value.every(isScalar)) return RANK.short;
  return null; // nested object / array of objects: read the one object
}

function rankOf(def: LeanPropertyDef | undefined, value: unknown): Rank {
  if (!def) return rankOfValue(value);
  if (def.valueType === "secret") return null;
  if (def.isLifecycle) return RANK.lifecycle;
  const input = def.uiHints?.inputType ?? undefined;
  if (
    def.valueType === "entity_id" ||
    (input && ENTITY_INPUT_TYPES.has(input))
  ) {
    return Array.isArray(value) && !value.every(isScalar) ? null : RANK.entity;
  }
  if ((input && SELECT_INPUT_TYPES.has(input)) || hasEnum(def.constraints)) {
    return Array.isArray(value) && !value.every(isScalar) ? null : RANK.select;
  }
  if (def.valueType === "date" || (input && DATE_INPUT_TYPES.has(input))) {
    return RANK.date;
  }
  if (def.valueType === "object") return null;
  return rankOfValue(value);
}

function leanValue(value: unknown): unknown {
  if (typeof value === "string") return capString(value, ENTITY_STRING_CAP);
  if (Array.isArray(value) && value.length > LEAN_LIST_ARRAY_CAP) {
    return [
      ...value.slice(0, LEAN_LIST_ARRAY_CAP),
      `…[truncated: ${value.length} items total]`,
    ];
  }
  return value;
}

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  );
}

export interface LeanListOptions {
  /**
   * Extra fields the caller names: property keys or top-level columns,
   * returned WHOLE (never truncated, never counted against the cap).
   */
  fields?: ReadonlyArray<string>;
}

/**
 * One entity row → its lean list row. Pure. `shape` undefined = the kind's
 * defs are unknown (the row's profile is gone): properties are then ranked by
 * their stored values alone — the status columns are kept either way.
 */
export function toLeanListRow(
  row: Record<string, unknown>,
  shape: LeanKindShape | undefined,
  options: LeanListOptions = {}
): Record<string, unknown> {
  const fields = new Set(options.fields ?? []);
  const out: Record<string, unknown> = {};
  for (const col of LEAN_ROW_COLUMNS) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    out[col] =
      typeof v === "string" && col === "title"
        ? capString(v, ENTITY_STRING_CAP)
        : v;
  }
  const kind = row.profileSlug ?? row.type;
  if (typeof kind === "string") out.kind = kind;
  if (typeof row.status === "string" && shape?.statusLabels) {
    const label = shape.statusLabels.get(row.status);
    if (label && label !== row.status) out.statusLabel = label;
  }
  if (typeof row.description === "string" && row.description) {
    out.description = capString(row.description, ENTITY_STRING_CAP);
  }
  // Named top-level columns come back whole.
  for (const f of fields) {
    if (f === "properties" || f === "systemData") continue;
    if (f in row && row[f] !== null && row[f] !== undefined) out[f] = row[f];
  }

  const props =
    row.properties && typeof row.properties === "object"
      ? (row.properties as Record<string, unknown>)
      : {};
  const defBySlug = new Map((shape?.defs ?? []).map((d) => [d.slug, d]));
  const candidates: Array<{ key: string; rank: number; order: number }> = [];
  const omitted: string[] = [];
  const picked: Record<string, unknown> = {};
  let storage = 0;
  for (const [key, value] of Object.entries(props)) {
    storage++;
    const def = defBySlug.get(key);
    if (def?.valueType === "secret") continue; // never named, never listed
    if (fields.has(key)) {
      picked[key] = value;
      continue;
    }
    if (isEmpty(value)) continue;
    // Repeats of what the row already says.
    if (def?.isLifecycle && value === row.status) continue;
    if (key === "title" && value === row.title) continue;
    const rank = rankOf(def, value);
    if (rank === null) {
      omitted.push(key);
      continue;
    }
    candidates.push({
      key,
      rank,
      order: (def?.displayOrder ?? 10_000) * 10_000 + storage,
    });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.order - b.order);
  for (const [i, c] of candidates.entries()) {
    if (i < LEAN_LIST_MAX_PROPERTIES) {
      picked[c.key] = leanValue(props[c.key]);
    } else {
      omitted.push(c.key);
    }
  }
  if (Object.keys(picked).length > 0) out.properties = picked;
  if (omitted.length > 0) out.omitted = omitted;
  return out;
}

export const ENTITIES_LEAN_NOTE =
  "Lean rows: id, title, kind, status (+ statusCategory/statusLabel) and the kind's selected " +
  `properties (at most ${LEAN_LIST_MAX_PROPERTIES}; strings over ${ENTITY_STRING_CAP} chars end in ` +
  "'…[truncated: N chars total]'). `omitted` names each row's property keys left out: pass them in " +
  "fields to get them whole, or read one object by its id (synap_get_entity). " +
  "detail:'full' (MCP) or projection=full (Hub REST) returns every row unprojected.";

/** What the loader needs of the resolution service (injectable for tests). */
export interface LeanShapeSource {
  getEffectiveProperties(
    profileId: string,
    workspaceId?: string | null
  ): Promise<ReadonlyArray<LeanPropertyDef>>;
  getEffectiveLifecycles(profileIds: ReadonlyArray<string>): Promise<
    Map<
      string,
      {
        options: ReadonlyArray<{ key: string; label?: string | null }>;
      }
    >
  >;
}

/**
 * Project a page of entity rows to lean rows, reading each kind's effective
 * property defs once per (profile, workspace) pair and every lifecycle in one
 * batch. A failed def read THROWS (a failed read is not "no defs").
 */
export async function projectLeanEntityList(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: LeanListOptions & { source?: LeanShapeSource } = {}
): Promise<Array<Record<string, unknown>>> {
  const source =
    options.source ??
    (new ProfileResolutionService(defaultDb) as unknown as LeanShapeSource);
  const profileIds = [
    ...new Set(
      rows
        .map((r) => r.profileId)
        .filter((id): id is string => typeof id === "string")
    ),
  ];
  const lifecycles =
    profileIds.length > 0
      ? await source.getEffectiveLifecycles(profileIds)
      : new Map();
  const shapes = new Map<string, Promise<LeanKindShape>>();
  const shapeOf = (row: Record<string, unknown>) => {
    const profileId = row.profileId;
    if (typeof profileId !== "string") return undefined;
    const workspaceId =
      typeof row.workspaceId === "string" ? row.workspaceId : null;
    const key = `${profileId}|${workspaceId ?? ""}`;
    let shape = shapes.get(key);
    if (!shape) {
      shape = source
        .getEffectiveProperties(profileId, workspaceId)
        .then((defs) => {
          const lc = lifecycles.get(profileId);
          return {
            defs,
            ...(lc
              ? {
                  statusLabels: new Map(
                    lc.options.map((o) => [
                      o.key,
                      lifecycleOptionLabel({
                        key: o.key,
                        label: o.label ?? undefined,
                      }),
                    ])
                  ),
                }
              : {}),
          };
        });
      shapes.set(key, shape);
    }
    return shape;
  };
  return Promise.all(
    rows.map(async (row) => toLeanListRow(row, await shapeOf(row), options))
  );
}
