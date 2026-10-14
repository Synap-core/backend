/**
 * DESCRIPTIVE fields a slug-idempotent define (`synap_define_kind` /
 * `synap_define_role` / Hub `POST /profiles` → `profiles.create`) may change on
 * a profile that ALREADY exists: its name, its description, its icon, and its
 * default values.
 *
 * Before this, re-declaring an existing slug only ever ADDED (fields, role
 * kinds) and silently ignored every descriptive field — so a role whose
 * description was wrong ("Growth Research Positioning" on a role now meaning
 * Génération · Rémunération · Partage) had no governed agent door at all
 * (observed 2026-09-28). The define door is the ONE door for "declare what this
 * kind/role is", so a changed description rides it as a governed update rather
 * than a second `update_profile` tool beside it.
 *
 * CHANGE, NOT PRESENCE: a field that is absent, or equal to what is stored,
 * changes nothing — the common re-declare (add one field, same name) files no
 * update. Default values MERGE (a key the caller does not name is kept), never
 * replace. Pure — no reads.
 */
import {
  buildObjectActionTitle,
  humanizeToken,
} from "@synap-core/types/vocabulary";

/**
 * The descriptive uiHints keys the define door carries. `presentation` (how
 * the kind renders — family + media source, `@synap-core/types/presentation`)
 * is descriptive too: a re-declare that changes it is the same governed update.
 */
const DESCRIPTIVE_UI_HINTS = ["description", "icon", "presentation"] as const;

export interface DescriptiveProfileState {
  displayName: string;
  uiHints?: Record<string, unknown> | null;
  defaultValues?: Record<string, unknown> | null;
}

export interface DescriptiveProfileInput {
  displayName?: string;
  uiHints?: Record<string, unknown>;
  defaultValues?: Record<string, unknown>;
}

export interface DescriptiveProfilePatch {
  displayName?: string;
  uiHints?: Record<string, unknown>;
  defaultValues?: Record<string, unknown>;
}

export interface DescriptiveProfileDiff {
  /** Changed field names, in a fixed order (`displayName`, `description`, `icon`, `presentation`, `defaultValues`). */
  changed: string[];
  /** What to write — full merged `uiHints` / `defaultValues`, never a partial. */
  patch: DescriptiveProfilePatch;
}

/**
 * Key-order blind: a stored jsonb object comes back with Postgres's key order
 * (`presentation` is written by `setProfilePresentation`), so a plain
 * `JSON.stringify` compare would read an unchanged object as changed.
 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`
      )
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a ?? null) === stableJson(b ?? null);
}

export function diffDescriptiveProfileFields(
  existing: DescriptiveProfileState,
  input: DescriptiveProfileInput
): DescriptiveProfileDiff {
  const changed: string[] = [];
  const patch: DescriptiveProfilePatch = {};

  const name = input.displayName?.trim();
  if (name && name !== existing.displayName) {
    changed.push("displayName");
    patch.displayName = name;
  }

  const storedHints = existing.uiHints ?? {};
  const nextHints: Record<string, unknown> = { ...storedHints };
  for (const key of DESCRIPTIVE_UI_HINTS) {
    const value = input.uiHints?.[key];
    if (value === undefined || sameJson(value, storedHints[key])) continue;
    changed.push(key);
    nextHints[key] = value;
  }
  if (
    changed.some((k) => (DESCRIPTIVE_UI_HINTS as readonly string[]).includes(k))
  ) {
    patch.uiHints = nextHints;
  }

  if (input.defaultValues && Object.keys(input.defaultValues).length > 0) {
    const stored = existing.defaultValues ?? {};
    const merged = { ...stored, ...input.defaultValues };
    if (!sameJson(merged, stored)) {
      changed.push("defaultValues");
      patch.defaultValues = merged;
    }
  }

  return { changed, patch };
}

/**
 * The review title: `Update Role "GRP interrogation": description, default values`.
 * The verb and noun come from the vocabulary door; the changed field names are
 * humanized tokens (never a local label map).
 */
export function buildDescriptiveProfileUpdateSummary(data: {
  profileKind?: unknown;
  previousDisplayName?: unknown;
  displayName?: unknown;
  changedFields?: unknown;
}): string {
  const name =
    typeof data.previousDisplayName === "string" && data.previousDisplayName
      ? data.previousDisplayName
      : typeof data.displayName === "string"
        ? data.displayName
        : undefined;
  const head = buildObjectActionTitle({
    action: "update",
    objectKind: data.profileKind === "role" ? "role" : "kind",
    objectName: name,
  });
  const fields = Array.isArray(data.changedFields)
    ? data.changedFields.filter((f): f is string => typeof f === "string")
    : [];
  const renamedTo =
    fields.includes("displayName") &&
    typeof data.displayName === "string" &&
    data.displayName !== name
      ? ` (renamed to "${data.displayName}")`
      : "";
  return fields.length > 0
    ? `${head}: ${fields.map((f) => humanizeToken(f).toLowerCase()).join(", ")}${renamedTo}`
    : head;
}
