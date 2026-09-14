/**
 * LEAN projections for the MCP list doors `synap_list_profiles` and
 * `synap_get_entities` — same convention as `synap_get_entity` (`detail:
 * lean|full`) and `synap_list_proposals` (`detail: summary|full`): the small
 * shape is the DEFAULT, `detail: "full"` returns today's rows unchanged.
 *
 * WHY (measured on the live pod, 2026-09-14). `synap_list_profiles` with no
 * arguments — the call its own description says to make "ALWAYS at session
 * start" — returned 117,197 chars (117 profiles = 39,699; 409 relation-type
 * rows = 77,468). `synap_get_entities {profileSlug:"note", limit:50}` returned
 * 70,138 chars (`properties` 20,292 + `preview` 14,618, plus 50 × six
 * always-null file columns and `systemData: {}`). Claude Code caps MCP tool
 * output at ~25k tokens and other clients are stricter, so a cold agent could
 * not read its own schema on call #1.
 *
 * Nothing here is withheld silently: every lean payload carries a `note`
 * naming what was cut and how to get it back.
 */

/** Profile description cap in the digest. Live p90 = 110 chars, max = 151. */
export const PROFILE_DESCRIPTION_CAP = 120;

/**
 * Long string cap in a lean entity row. 120 chars is enough to recognise a
 * note. Measured: at 200 the 50-note budget fixture came to 41,710 chars (over
 * budget), because the ~14 live UUID/timestamp columns per row are fixed cost.
 */
export const ENTITY_STRING_CAP = 120;

function capString(value: string, cap: number): string {
  return value.length > cap
    ? `${value.slice(0, cap)}…[truncated: ${value.length} chars total]`
    : value;
}

/**
 * One profile as the default digest carries it: what an agent needs to CHOOSE
 * a kind — `id` stays because `synap_create_view` / `synap_list_views` take a
 * `profileId`. Omitted: `scope`, `icon`, and `applicableKinds` when empty
 * (it is only meaningful on a role). `description` is capped, never dropped.
 */
export function toProfileDigest(
  p: Record<string, unknown>,
  description: string | null,
  workspaceId?: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: p.id,
    slug: p.slug,
    displayName: p.displayName,
    profileKind: p.profileKind ?? "kind",
    entityScope: p.entityScope,
  };
  if (Array.isArray(p.applicableKinds) && p.applicableKinds.length > 0) {
    out.applicableKinds = p.applicableKinds;
  }
  if (description) {
    out.description = capString(description, PROFILE_DESCRIPTION_CAP);
  }
  if (workspaceId !== undefined) out.workspaceId = workspaceId;
  return out;
}

export interface RelationTypeRow {
  slug: string;
  workspaceId: string | null;
}

export interface RelationTypeLensGroup {
  /** `null` = pod-wide (valid in every workspace). */
  workspaceId: string | null;
  slugs: string[];
}

/**
 * The relation vocabulary as the default digest carries it: slugs grouped by
 * lens. The pod-wide group (`workspaceId: null`) lists slugs valid everywhere;
 * a workspace group lists ONLY the slugs that workspace adds beyond them. This
 * is exactly the set `relations.create` validates against (pod-wide ∪ that
 * workspace's defs), so every slug a write accepts is still named here — the
 * full rows (displayName, description, isDirectional, inverseLabel, one row
 * per workspace override) come back with `detail: "full"`.
 */
export function compactRelationTypes(
  rows: readonly RelationTypeRow[]
): RelationTypeLensGroup[] {
  const podWide = new Set(
    rows.filter((r) => r.workspaceId === null).map((r) => r.slug)
  );
  const groups = new Map<string | null, Set<string>>();
  groups.set(null, podWide);
  for (const r of rows) {
    if (r.workspaceId === null || podWide.has(r.slug)) continue;
    const set = groups.get(r.workspaceId) ?? new Set<string>();
    set.add(r.slug);
    groups.set(r.workspaceId, set);
  }
  return [...groups.entries()]
    .filter(([ws, slugs]) => ws === null || slugs.size > 0)
    .map(([workspaceId, slugs]) => ({
      workspaceId,
      slugs: [...slugs].sort(),
    }));
}

export const PROFILES_DIGEST_NOTE =
  "Digest. Profiles omit scope/icon, empty applicableKinds, and cap description at " +
  `${PROFILE_DESCRIPTION_CAP} chars. relationTypes are slugs grouped by lens: workspaceId null = ` +
  "valid in every workspace; a workspace group lists only the slugs it adds. Pass " +
  "detail:'full' for complete profile rows and full relation-type rows (displayName, " +
  "description, isDirectional, inverseLabel).";

/** Top-level entity columns a lean row never carries (always `{}` / internal). */
const ENTITY_WITHHELD_COLUMNS: ReadonlySet<string> = new Set(["systemData"]);

/**
 * One entity row as the default `synap_get_entities` carries it. Null
 * top-level columns and `systemData` are dropped; long top-level strings and
 * long top-level string PROPERTY values are truncated with an explicit marker.
 * Every property KEY is kept (including null-valued ones) — a value may be
 * cut, a key is never removed. Nested objects/arrays inside properties are
 * passed through untouched.
 */
export function toLeanEntity(
  row: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (ENTITY_WITHHELD_COLUMNS.has(key)) continue;
    if (key === "properties" && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        props[pk] =
          typeof pv === "string" ? capString(pv, ENTITY_STRING_CAP) : pv;
      }
      out.properties = props;
      continue;
    }
    out[key] =
      typeof value === "string" ? capString(value, ENTITY_STRING_CAP) : value;
  }
  return out;
}

export const ENTITIES_LEAN_NOTE =
  "Lean rows: null columns and systemData omitted; string values longer than " +
  `${ENTITY_STRING_CAP} chars end in '…[truncated: N chars total]' (every property key is kept). ` +
  "synap_get_entity { entityId } returns one full row; detail:'full' here returns every row unprojected.";
