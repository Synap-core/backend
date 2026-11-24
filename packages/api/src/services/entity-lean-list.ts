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
 *     booleans, short strings and lists of scalars, then long strings. At
 *     most {@link LEAN_LIST_MAX_PROPERTIES}.
 *     The lifecycle property is not repeated when it equals `status`; a
 *     `title` property equal to the title is not repeated; secrets and nested
 *     objects never ride in a list;
 *   - `omitted`: the property keys and the columns ({@link LEAN_NAMED_COLUMNS})
 *     that were left out, so nothing is unreachable — name them in `fields`
 *     (returned whole, never truncated), or read the one object;
 *   - listed under a ROLE (`listedUnder` names a role-profile): a row that
 *     is not itself of that kind takes `status` / `statusCategory` /
 *     `statusLabel` from its facet of that role (the rich `facets` rows,
 *     `includeFacets: true`), never from the entity — a lead's stage is on
 *     its `lead` facet, the company's own status is not it. No such facet on
 *     the row = no status, never the entity's;
 *   - `truncated`: field → its full length, for a string cut to its first
 *     {@link ENTITY_STRING_CAP} chars (the title, the description, a
 *     property) or a list cut to its first {@link LEAN_LIST_ARRAY_CAP} items.
 *     The length rides BESIDE the data, never inside it: a marker inside a
 *     value (a list of entity ids, a body) would be written back by an agent
 *     that updates from what it read.
 */

import {
  db as defaultDb,
  ProfileResolutionService,
  profileSlugRows,
  resolveSlugKind,
} from "@synap/database";
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
export const LEAN_LIST_ARRAY_CAP = 10;

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

/**
 * Columns a lean row leaves out but NAMES in `omitted` when THIS row has one
 * (a document body, facets), so a caller knows it is there and can ask for it
 * in `fields`. Columns every row carries (`createdAt`, `profileId`) are named
 * once, in {@link ENTITIES_LEAN_NOTE}, not on each of fifty rows.
 */
export const LEAN_NAMED_COLUMNS = ["documentId", "facets"] as const;

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

/**
 * A value as a lean row carries it: a long string cut to its first
 * {@link ENTITY_STRING_CAP} chars, a long list to its first
 * {@link LEAN_LIST_ARRAY_CAP} items, with NO marker inside (`full` is the
 * length it had, for the row's `truncated`).
 */
function leanValue(value: unknown): { value: unknown; full?: number } {
  if (typeof value === "string" && value.length > ENTITY_STRING_CAP) {
    return { value: value.slice(0, ENTITY_STRING_CAP), full: value.length };
  }
  if (Array.isArray(value) && value.length > LEAN_LIST_ARRAY_CAP) {
    return { value: value.slice(0, LEAN_LIST_ARRAY_CAP), full: value.length };
  }
  return { value };
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
 * The role a list was asked for, and its lifecycle's words: a row listed
 * under it reads its status from its facet of that role.
 */
export interface LeanRoleStatus {
  /** The role-profile slug (`lead`). */
  slug: string;
  /** lifecycle option key → its words. */
  statusLabels?: ReadonlyMap<string, string>;
  /** lifecycle option key → its category (the rule that writes the column). */
  statusCategories?: ReadonlyMap<string, string>;
}

/** A row's facet of `slug` from its rich `facets` rows, if it carries one. */
function facetOf(
  row: Record<string, unknown>,
  slug: string
): { status?: unknown } | undefined {
  if (!Array.isArray(row.facets)) return undefined;
  return (row.facets as unknown[]).find(
    (f): f is { slug: string; status?: unknown } =>
      typeof f === "object" &&
      f !== null &&
      (f as { slug?: unknown }).slug === slug
  );
}

/**
 * One entity row → its lean list row. Pure. `shape` undefined = the kind's
 * defs are unknown (the row's profile is gone): properties are then ranked by
 * their stored values alone — the status columns are kept either way.
 */
export function toLeanListRow(
  row: Record<string, unknown>,
  shape: LeanKindShape | undefined,
  options: LeanListOptions & { role?: LeanRoleStatus } = {}
): Record<string, unknown> {
  const fields = new Set(options.fields ?? []);
  const out: Record<string, unknown> = {};
  const truncated: Record<string, number> = {};
  /** Put a cut value on `into[key]`; its full length goes in `truncated`. */
  const putLean = (
    into: Record<string, unknown>,
    key: string,
    value: unknown
  ): void => {
    const lean = leanValue(value);
    into[key] = lean.value;
    if (lean.full !== undefined) truncated[key] = lean.full;
  };
  for (const col of LEAN_ROW_COLUMNS) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    if (col === "title") putLean(out, col, v);
    else out[col] = v;
  }
  const kind = row.profileSlug ?? row.type;
  if (typeof kind === "string") out.kind = kind;
  const role = options.role;
  if (role && kind !== role.slug) {
    // Listed under a role: the status is the role's (its facet), not the
    // entity's. No facet of that role on the row = no status.
    delete out.status;
    delete out.statusCategory;
    const facetStatus = facetOf(row, role.slug)?.status;
    if (typeof facetStatus === "string" && facetStatus !== "") {
      out.status = facetStatus;
      const category = role.statusCategories?.get(facetStatus);
      if (category) out.statusCategory = category;
      const label = role.statusLabels?.get(facetStatus);
      if (label && label !== facetStatus) out.statusLabel = label;
    }
  } else if (typeof row.status === "string" && shape?.statusLabels) {
    const label = shape.statusLabels.get(row.status);
    if (label && label !== row.status) out.statusLabel = label;
  }
  if (typeof row.description === "string" && row.description) {
    putLean(out, "description", row.description);
  }
  // Named top-level columns come back whole.
  for (const f of fields) {
    if (f === "properties" || f === "systemData") continue;
    if (f in row && row[f] !== null && row[f] !== undefined) {
      out[f] = row[f];
      delete truncated[f];
    }
  }
  const omitted: string[] = LEAN_NAMED_COLUMNS.filter(
    (col) => !fields.has(col) && !isEmpty(row[col])
  );

  const props =
    row.properties && typeof row.properties === "object"
      ? (row.properties as Record<string, unknown>)
      : {};
  const defBySlug = new Map((shape?.defs ?? []).map((d) => [d.slug, d]));
  const candidates: Array<{
    key: string;
    rank: number;
    displayOrder: number;
    storage: number;
  }> = [];
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
      // An undeclared key sorts after every declared one.
      displayOrder: def?.displayOrder ?? Number.MAX_SAFE_INTEGER,
      storage,
    });
  }
  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.displayOrder - b.displayOrder ||
      a.storage - b.storage
  );
  for (const [i, c] of candidates.entries()) {
    if (i < LEAN_LIST_MAX_PROPERTIES) {
      putLean(picked, c.key, props[c.key]);
    } else {
      omitted.push(c.key);
    }
  }
  if (Object.keys(picked).length > 0) out.properties = picked;
  if (Object.keys(truncated).length > 0) out.truncated = truncated;
  if (omitted.length > 0) out.omitted = omitted;
  return out;
}

export const ENTITIES_LEAN_NOTE =
  "Lean rows: id, title, kind, status (+ statusCategory/statusLabel) and the kind's selected " +
  `properties (at most ${LEAN_LIST_MAX_PROPERTIES}). A string over ${ENTITY_STRING_CAP} chars keeps its first ` +
  `${ENTITY_STRING_CAP} and a list over ${LEAN_LIST_ARRAY_CAP} items its first ${LEAN_LIST_ARRAY_CAP}, with no marker ` +
  "inside: `truncated` names each cut field with its full length (chars or items). Never write a cut value back. " +
  "`omitted` names each row's property keys and columns (documentId, facets) " +
  "left out; createdAt and profileId are left out of every row. Pass any of them in " +
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
        options: ReadonlyArray<{
          key: string;
          label?: string | null;
          category?: string | null;
        }>;
      }
    >
  >;
  /** The profile rows a slug names (default: `profileSlugRows`). */
  profileRowsForSlug?(
    slug: string
  ): Promise<ReadonlyArray<{ id: string; profileKind: string }>>;
}

function optionLabels(
  options: ReadonlyArray<{ key: string; label?: string | null }>
): Map<string, string> {
  return new Map(
    options.map((o) => [
      o.key,
      lifecycleOptionLabel({ key: o.key, label: o.label ?? undefined }),
    ])
  );
}

/**
 * The slug a lean list is "listed under" when it names a ROLE, else
 * `undefined`. A caller asks this BEFORE listing: a role's lean rows read
 * their status from the role's facet, so the list must load the facet rows
 * (`includeFacets: true`) and pass the slug as `listedUnder`. One cached
 * vocabulary lookup (`resolveSlugKind`).
 */
export async function leanListedUnderRole(
  profileSlug: string | undefined
): Promise<string | undefined> {
  if (!profileSlug) return undefined;
  const { hasRoleRow } = await resolveSlugKind(defaultDb, profileSlug);
  return hasRoleRow ? profileSlug : undefined;
}

/**
 * Project a page of entity rows to lean rows, reading each kind's effective
 * property defs once per (profile, workspace) pair and every lifecycle in one
 * batch. A failed def read THROWS (a failed read is not "no defs").
 */
export async function projectLeanEntityList(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: LeanListOptions & {
    source?: LeanShapeSource;
    /**
     * The `profileSlug` the list was asked for. When it names a ROLE, rows
     * take their status from their facet of it — so the caller must list
     * with `includeFacets: true` (the rich `facets` rows).
     */
    listedUnder?: string;
  } = {}
): Promise<Array<Record<string, unknown>>> {
  const source: LeanShapeSource =
    options.source ?? new ProfileResolutionService(defaultDb);
  const roleProfileIds = options.listedUnder
    ? (
        await (source.profileRowsForSlug
          ? source.profileRowsForSlug(options.listedUnder)
          : profileSlugRows(defaultDb, options.listedUnder))
      )
        .filter((p) => p.profileKind === "role")
        .map((p) => p.id)
    : [];
  const profileIds = [
    ...new Set([
      ...rows
        .map((r) => r.profileId)
        .filter((id): id is string => typeof id === "string"),
      ...roleProfileIds,
    ]),
  ];
  const lifecycles: Awaited<
    ReturnType<LeanShapeSource["getEffectiveLifecycles"]>
  > =
    profileIds.length > 0
      ? await source.getEffectiveLifecycles(profileIds)
      : new Map();
  let role: LeanRoleStatus | undefined;
  if (options.listedUnder && roleProfileIds.length > 0) {
    // Twin role rows of one slug share its lifecycle: the first that
    // declares one gives the words.
    const lc = roleProfileIds
      .map((id) => lifecycles.get(id))
      .find((l) => l !== undefined);
    role = {
      slug: options.listedUnder,
      ...(lc
        ? {
            statusLabels: optionLabels(lc.options),
            statusCategories: new Map(
              lc.options
                .filter((o) => typeof o.category === "string")
                .map((o) => [o.key, o.category as string])
            ),
          }
        : {}),
    };
  }
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
            ...(lc ? { statusLabels: optionLabels(lc.options) } : {}),
          };
        });
      shapes.set(key, shape);
    }
    return shape;
  };
  const { fields } = options;
  return Promise.all(
    rows.map(async (row) =>
      toLeanListRow(row, await shapeOf(row), {
        ...(fields ? { fields } : {}),
        ...(role ? { role } : {}),
      })
    )
  );
}
