/**
 * The `filters` INPUT of an entity-list door, read the same way by every door
 * that takes it as text or as an array (Hub `GET /entities`, Hub
 * `GET /users/{id}/entities`, MCP `synap_get_entities`): ONE parse, ONE error
 * wording, so no door grows its own grammar and none ignores a filter it was
 * given. The compile (and the unknown/secret property checks) stay in
 * `entityListFiltersWhere`, which `entities.list` runs.
 */
import { isViewFilterField, type ViewFilter } from "@synap-core/types";
import {
  EntityListFiltersSchema,
  filteredPropertySlugs,
} from "./entity-list-filters.js";

export type ParsedListFilters =
  | { ok: true; filters: ViewFilter[] | undefined }
  | { ok: false; error: string };

function barePropertyField(filter: unknown): unknown {
  if (!filter || typeof filter !== "object") return filter;
  const f = filter as { field?: unknown };
  return typeof f.field === "string" &&
    f.field !== "" &&
    !f.field.includes(".") &&
    !isViewFilterField(f.field)
    ? { ...f, field: `properties.${f.field}` }
    : filter;
}

/**
 * `raw`: a JSON string (query string) or an already-parsed array (MCP).
 * `undefined`, `null` and a blank string mean "no filters".
 */
export function parseEntityListFiltersInput(
  raw: unknown,
  profileSlug: string | undefined
): ParsedListFilters {
  if (raw === undefined || raw === null)
    return { ok: true, filters: undefined };
  let value = raw;
  if (typeof value === "string") {
    if (value.trim() === "") return { ok: true, filters: undefined };
    try {
      value = JSON.parse(value);
    } catch {
      return {
        ok: false,
        error: "filters must be a JSON array of view filters",
      };
    }
  }
  // With a kind named, a bare field that is not a core column is that kind's
  // property: `recommendation` reads as `properties.recommendation`.
  if (profileSlug && Array.isArray(value)) value = value.map(barePropertyField);
  const parsed = EntityListFiltersSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid filters: ${parsed.error.issues.map((i: { message: string }) => i.message).join("; ")}`,
    };
  }
  const filters = parsed.data.length > 0 ? parsed.data : undefined;
  const slugs = filters ? filteredPropertySlugs(filters) : [];
  if (slugs.length > 0 && !profileSlug) {
    return {
      ok: false,
      error: `A filter on a property (${slugs.map((s) => `properties.${s}`).join(", ")}) needs profileSlug: properties are declared per kind`,
    };
  }
  return { ok: true, filters };
}
