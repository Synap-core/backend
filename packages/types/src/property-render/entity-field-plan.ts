/**
 * `planEntityFields` — the ONE sectioning of an entity's properties: which are
 * the identity (a duplicate of the title), the hero (status / priority), the
 * 3–6 primary facts, the overflow, the body prose, machine bookkeeping, and
 * the empty ones. Every renderer draws the same plan, so a field cannot be a
 * headline fact on one surface and buried on another.
 *
 * HOME: here (`@synap-core/types/property-render`), moved down from app-bases
 * `@synap-core/hooks/profile-renderer/entity-field-plan.ts`. Follow-up:
 * re-point that copy's importers here and delete it (see `./index.ts`).
 */

import { classifyPropertyKind } from "./classify-property.js";
import type { EffectivePropertyDef, PropertyRenderKind } from "./types.js";

export interface PlannedEntityField {
  def: EffectivePropertyDef;
  value: unknown;
  renderKind: PropertyRenderKind;
}

export interface EntityFieldPlan {
  identity: PlannedEntityField[];
  hero: PlannedEntityField[];
  primary: PlannedEntityField[];
  secondary: PlannedEntityField[];
  body: PlannedEntityField[];
  system: PlannedEntityField[];
  empty: PlannedEntityField[];
}

export interface EntityFieldPlanInput {
  definitions: readonly EffectivePropertyDef[];
  values: Record<string, unknown>;
  header?: { title?: string | null; name?: string | null };
  primaryLimit?: number;
}

const BODY_FIELDS = new Set([
  "body",
  "content",
  "message",
  "summary",
  "description",
  "notes",
  "note",
  "text",
  "detail",
  "details",
  "overview",
  "brief",
  "comment",
  "comments",
  "remark",
  "remarks",
]);
const SYSTEM_FIELDS = new Set([
  "id",
  "type",
  "profile",
  "profileslug",
  "profileid",
  "createdat",
  "updatedat",
  "deletedat",
  "archivedat",
  "version",
  "revision",
  "checksum",
  "embedding",
  "vector",
  "searchtext",
  "raw",
  "payload",
  "metadata",
]);
const REFERENCE_FIELDS = new Set([
  "channelid",
  "messageid",
  "threadid",
  "documentid",
  "workspaceid",
  "entityid",
]);

function normalizeKey(value: string): string {
  return value
    .replace(/^(properties|metadata)\./, "")
    .replace(/[-_]/g, "")
    .toLowerCase();
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return (
    typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

function isTitleField(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    normalized === "title" ||
    normalized === "name" ||
    normalized === "displayname"
  );
}

function isDuplicateTitle(
  key: string,
  value: unknown,
  header: EntityFieldPlanInput["header"]
): boolean {
  if (!isTitleField(key)) return false;
  const fieldValue = typeof value === "string" ? value.trim() : "";
  const headerValue = (header?.title ?? header?.name ?? "").trim();
  return (
    fieldValue.length === 0 ||
    (headerValue.length > 0 && fieldValue === headerValue)
  );
}

/**
 * Machine bookkeeping a user should never be shown as a "property": ids,
 * timestamps, embeddings, raw payloads, debug blobs.
 *
 * Exported (and re-exported from the `/classify` subpath) because relay needs
 * exactly this predicate for its property list and must not hand-roll a second
 * copy of the field set — the two would drift the first time a field is added
 * here. `planEntityFields` remains the door for full sectioning; this is the
 * one bucket a surface can want on its own.
 */
export function isSystemField(key: string): boolean {
  const normalized = normalizeKey(key);
  if (REFERENCE_FIELDS.has(normalized)) return false;
  return (
    SYSTEM_FIELDS.has(normalized) ||
    normalized.startsWith("__") ||
    normalized.startsWith("debug") ||
    normalized.startsWith("internal") ||
    normalized.endsWith("debug") ||
    normalized.endsWith("json")
  );
}

export function planEntityFields({
  definitions,
  values,
  header,
  primaryLimit = 6,
}: EntityFieldPlanInput): EntityFieldPlan {
  const plan: EntityFieldPlan = {
    identity: [],
    hero: [],
    primary: [],
    secondary: [],
    body: [],
    system: [],
    empty: [],
  };

  const sorted = [...definitions].sort(
    (left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0)
  );

  for (const def of sorted) {
    const value = values[def.slug];
    const field: PlannedEntityField = {
      def,
      value,
      renderKind: classifyPropertyKind({ slug: def.slug, value, def }),
    };

    if (isEmpty(value)) {
      plan.empty.push(field);
    } else if (isDuplicateTitle(def.slug, value, header)) {
      plan.identity.push(field);
    } else if (BODY_FIELDS.has(normalizeKey(def.slug))) {
      plan.body.push(field);
    } else if (isSystemField(def.slug)) {
      plan.system.push(field);
    } else if (
      field.renderKind === "status" ||
      field.renderKind === "priority"
    ) {
      plan.hero.push(field);
    } else if (plan.primary.length < primaryLimit) {
      plan.primary.push(field);
    } else {
      plan.secondary.push(field);
    }
  }

  return plan;
}
