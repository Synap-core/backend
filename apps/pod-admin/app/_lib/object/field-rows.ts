/**
 * `planEntityFields` → the rows `FieldList` draws.
 *
 * The SECTIONING is the shared plan (`@synap-core/types/property-render`):
 * hero (status / priority) first, then the primary facts, the overflow and
 * the body prose behind a disclosure. Identity duplicates, bookkeeping and
 * empty fields are never rows. What this file adds is only the one-line TEXT
 * a console row can hold — the web skin's half of the job.
 */

import {
  describeValue,
  resolvePropertyLabel,
  summarizeShape,
  type EntityFieldPlan,
  type PlannedEntityField,
} from "@synap-core/types/property-render";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { formatTimestamp } from "../../../lib/format";
import { statusPillFor } from "../../(admin)/components/status-tone";
import type { StatusKind } from "../../(admin)/components/status-pill";
import { oneLine } from "../../../lib/format";

export interface FieldRow {
  key: string;
  label: string;
  value: string;
  /** Present on status / priority rows: the value draws as a pill. */
  pill?: { kind: StatusKind; label: string };
  /** Ids and raw tokens render in mono. */
  mono?: boolean;
}

/** Long prose folds to this many characters in a row. */
const ROW_TEXT_MAX = 160;

/** At least this many rows show before the disclosure, when the plan has them. */
export const FIELD_LIST_MIN_SHOWN = 3;

/** One planned field → its row, or null when it has nothing a row can show. */
function fieldRow(field: PlannedEntityField): FieldRow | null {
  const { def, value, renderKind } = field;
  const base = { key: def.slug, label: resolvePropertyLabel(def) };

  // Never a row: a secret's plaintext has no business in a read card, and an
  // entity reference is a bare uuid that names nothing the reader can use
  // (resolving it is a relations read, not a field).
  if (
    renderKind === "secret" ||
    renderKind === "entity-ref" ||
    renderKind === "multi-entity-ref"
  ) {
    return null;
  }

  if (renderKind === "status" || renderKind === "priority") {
    if (typeof value !== "string" || !value.trim()) return null;
    // Priority has no health meaning, so it stays a plain word.
    const pill = renderKind === "status" ? statusPillFor(value) : null;
    return {
      ...base,
      value: resolveStatusLabel(value),
      ...(pill ? { pill } : {}),
    };
  }

  if (renderKind === "date") {
    if (typeof value !== "string" && !(value instanceof Date)) return null;
    const when = formatTimestamp(value);
    return when === "—" ? null : { ...base, value: when };
  }

  // Everything else reads through the ONE structured-value door, so a record
  // or JSON-in-a-string becomes named parts instead of `[object Object]`.
  const shape = describeValue(value);
  if (shape.kind === "empty") return null;
  const text = summarizeShape(shape);
  if (!text) return null;
  return {
    ...base,
    value: oneLine(text, ROW_TEXT_MAX),
    mono: shape.kind === "id",
  };
}

/**
 * The plan as two row lists: what shows, and what sits behind "More fields".
 *
 * `hero` + `primary` show (the plan already capped primary at its limit); if
 * that leaves fewer than {@link FIELD_LIST_MIN_SHOWN}, overflow fields are
 * promoted so a sparse entity does not hide its only facts behind a click.
 * `secondary` and `body` are the rest. `omit` drops fields the page already
 * shows elsewhere (the body field it used as the header summary).
 */
export function fieldRows(
  plan: EntityFieldPlan,
  { omit = [] }: { omit?: readonly string[] } = {}
): {
  shown: FieldRow[];
  more: FieldRow[];
} {
  const rows = (fields: PlannedEntityField[]) =>
    fields
      .filter((f) => !omit.includes(f.def.slug))
      .map(fieldRow)
      .filter((r): r is FieldRow => r !== null);
  const shown = rows([...plan.hero, ...plan.primary]);
  const rest = rows([...plan.secondary, ...plan.body]);
  const promote = Math.max(0, FIELD_LIST_MIN_SHOWN - shown.length);
  return {
    shown: [...shown, ...rest.slice(0, promote)],
    more: rest.slice(promote),
  };
}

/** A prose field drawn as content (whole, read as markdown) instead of a row. */
export interface ProseField {
  key: string;
  label: string;
  text: string;
}

/**
 * The fields worth reading in full: every rich-text field (markdown, a text
 * area) and the plan's body prose (`description`, `notes`, …), when they hold
 * text. A row folds them to one line; the page draws these as content and
 * passes their keys to `fieldRows`' `omit`, so nothing shows twice.
 */
export function proseFields(plan: EntityFieldPlan): ProseField[] {
  const out: ProseField[] = [];
  const seen = new Set<string>();
  const take = (field: PlannedEntityField) => {
    const { def, value, renderKind } = field;
    if (seen.has(def.slug)) return;
    if (renderKind !== "richtext" && renderKind !== "text") return;
    if (typeof value !== "string" || !value.trim()) return;
    seen.add(def.slug);
    out.push({ key: def.slug, label: resolvePropertyLabel(def), text: value });
  };
  for (const field of plan.body) take(field);
  for (const field of [...plan.hero, ...plan.primary, ...plan.secondary]) {
    if (field.renderKind === "richtext") take(field);
  }
  return out;
}
