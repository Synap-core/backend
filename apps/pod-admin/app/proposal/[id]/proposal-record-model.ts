/**
 * What approving would create or change, as RECORDS — pure, so every rule a
 * reviewer reads is tested apart from the markup.
 *
 * Founder dogfood (2026-10-23): the first panel drew the pod's diff as one
 * narrow column of `Title: [Léa]`, `Kind: [Person]`, `Role: [CTO]`,
 * `ResolvedWorkspaceId: empty` — every value in a chip, the record's own name
 * as a field, a machine key as a fact. A record reads the way an object reads
 * everywhere else in the console:
 *
 *   - its TITLE is the card's heading and its KIND a quiet mark beside it
 *     (a create; an update keeps a renamed title as a before → after field);
 *   - each property is labelled by its DEFINED label (the kind's property
 *     defs, `resolvePropertyLabel`) or the one label door (`formatFieldLabel`),
 *     and classified by the shared classifier (`classifyPropertyKind`) so a
 *     status draws as a status, a url as a link, a reference as a door;
 *   - machine keys never show: the shared `isSystemField`, and any key that
 *     names an object by id (`…Id`, `…Ids` — the same rule the pod's
 *     `objectRefs` resolver reads) is a door when the pod resolved it and is
 *     otherwise left to Advanced, where the raw request already is;
 *   - an empty value is not a fact: a create drops it, an update keeps it only
 *     as the "empty" side of a real change.
 *
 * The diff itself stays the pod's (`review.changes`, `routers/proposals/
 * changes.ts`); a capture graph's items come from its own operations.
 */

import {
  classifyPropertyKind,
  describeValue,
  formatFieldLabel,
  isSystemField,
  readObjectRef,
  resolvePropertyLabel,
  summarizeShape,
  type EffectivePropertyDef,
  type PropertyRenderKind,
} from "@synap-core/types/property-render";
import {
  resolveObjectNoun,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { formatDate, formatTimestamp } from "../../../lib/format";
import type { ProposalChangeInput } from "./proposal-review-model";

/** An object the pod resolved from an id in the payload (`objectRefs`). */
export interface ResolvedRef {
  id: string;
  kind: string;
  name: string | null;
}

/** One value, said the way its type reads. */
export type RecordValue =
  | { kind: "text"; text: string; long: boolean }
  | { kind: "status"; label: string; raw: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "ref"; objectKind: string; id: string; name: string }
  | { kind: "tags"; items: string[] };

export interface RecordField {
  key: string;
  label: string;
  op: "add" | "change" | "remove";
  /** `undefined` = not recorded (draw nothing); `null` = recorded empty. */
  before: RecordValue | null | undefined;
  after: RecordValue | null | undefined;
  /** The field moved after this was proposed: the `before` shown is stale. */
  stale: boolean;
  /** Prose that needs the card's whole width. */
  wide: boolean;
}

export interface ProposedRecord {
  /** The graph item's op ref, for a capture graph; `"single"` otherwise. */
  ref: string;
  title: string | null;
  /** The record's kind (a profile slug or an object kind), drawn as a mark. */
  kind: string | null;
  op: "create" | "update" | "delete";
  fields: RecordField[];
}

/** How many fields a card shows before "Show all N fields". */
export const RECORD_FIELDS_SHOWN = 9;

/** Text past this many characters (or with a line break) takes the card's width. */
const WIDE_TEXT_CHARS = 80;
/** The longest text drawn in a card; the whole value stays in Advanced. */
const MAX_TEXT_CHARS = 600;

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…`
    : text;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value as object).length === 0;
  }
  return false;
}

/**
 * A key that names an object by its id — `id`, `documentId`, `ownerIds`,
 * `parent_id`. The same reading as the pod's `objectRefs` resolver (a key
 * ending in `Id` / `Ids`), so what it resolves is exactly what can be a door.
 */
export function isIdKey(key: string): boolean {
  return key === "id" || /[a-z0-9]Ids?$/.test(key) || /_ids?$/i.test(key);
}

/** A key a reviewer never reads as a fact (the shared rule, plus ids). */
export function isMachineKey(key: string): boolean {
  return isSystemField(key) || isIdKey(key);
}

function textValue(text: string): RecordValue {
  const clipped = clip(text.trim());
  return {
    kind: "text",
    text: clipped,
    long: clipped.length > WIDE_TEXT_CHARS || clipped.includes("\n"),
  };
}

function safeHref(kind: PropertyRenderKind, raw: string): string | null {
  const v = raw.trim();
  if (kind === "email")
    return /^[^\s@]+@[^\s@]+$/.test(v) ? `mailto:${v}` : null;
  if (kind === "phone")
    return /^[+\d][\d\s().-]{3,}$/.test(v)
      ? `tel:${v.replace(/\s/g, "")}`
      : null;
  // Only a web address is a link; any other scheme stays text.
  return /^https?:\/\//i.test(v) ? v : null;
}

function dateText(raw: string | Date): string | null {
  // A bare day (`2026-10-23`) is a date, not midnight in the reader's zone.
  const text =
    typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
      ? formatDate(`${raw.trim()}T12:00:00`)
      : formatTimestamp(raw);
  return text === "—" ? null : text;
}

/**
 * One value in the reading its type gives it, or `null` when it has nothing a
 * reviewer can read (empty, a secret, a bare id the pod did not resolve).
 */
export function recordValue(
  renderKind: PropertyRenderKind,
  value: unknown,
  resolved?: ResolvedRef
): RecordValue | null {
  if (isEmptyValue(value)) return null;
  if (resolved) {
    return {
      kind: "ref",
      objectKind: resolved.kind,
      id: resolved.id,
      name: resolved.name?.trim() || resolveObjectNoun(resolved.kind),
    };
  }
  switch (renderKind) {
    case "secret":
      return null;
    case "status":
    case "priority":
    case "select":
      if (typeof value === "string") {
        return { kind: "status", label: resolveStatusLabel(value), raw: value };
      }
      break;
    case "date":
      if (typeof value === "string" || value instanceof Date) {
        const text = dateText(value);
        return text ? { kind: "text", text, long: false } : null;
      }
      break;
    case "url":
    case "email":
    case "phone":
      if (typeof value === "string") {
        const href = safeHref(renderKind, value);
        return href
          ? {
              kind: "link",
              href,
              text: value
                .trim()
                .replace(/^https?:\/\//i, "")
                .replace(/\/$/, ""),
            }
          : textValue(value);
      }
      break;
    case "boolean":
      if (typeof value === "boolean") {
        return { kind: "text", text: value ? "Yes" : "No", long: false };
      }
      break;
    case "tags":
    case "multi-select":
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        const items = (value as string[]).map((v) => v.trim()).filter(Boolean);
        return items.length > 0 ? { kind: "tags", items } : null;
      }
      break;
    case "entity-ref":
    case "multi-entity-ref": {
      const ref = readObjectRef(value);
      return ref
        ? {
            kind: "ref",
            objectKind: "entity",
            id: ref.id,
            name: ref.title ?? resolveObjectNoun(ref.type ?? "entity"),
          }
        : null;
    }
    default:
      break;
  }
  // Everything else through the ONE structured-value door: a record reads as
  // its named parts, an object ref as a door, a bare id as nothing.
  const shape = describeValue(value);
  switch (shape.kind) {
    case "empty":
    case "id":
      return null;
    case "objectRef":
      return {
        kind: "ref",
        objectKind: "entity",
        id: shape.ref.id,
        name: shape.ref.title ?? resolveObjectNoun(shape.ref.type ?? "entity"),
      };
    case "text":
      return textValue(shape.text);
    case "date": {
      const text = dateText(shape.iso);
      return text ? { kind: "text", text, long: false } : null;
    }
    default: {
      const text = summarizeShape(shape);
      return text ? textValue(text) : null;
    }
  }
}

/**
 * The field's name. A property: its DEFINED label, else the one label door.
 * Any other key: the pod's own label when it wrote words (a brief field, a
 * stage's name, "External hosts (sandbox allowlist)"); a label that is only
 * the key capitalised (`labelFromPath`: "ProfileSlug") is said again through
 * the label door instead.
 */
function fieldLabel(
  change: ProposalChangeInput,
  key: string,
  def: EffectivePropertyDef | undefined
): string {
  void resolvePropertyLabel;
  void def;
  if (change.path.startsWith("properties.")) return formatFieldLabel(key);
  if (key === "profileSlug") return resolveObjectNoun("kind");
  const label = change.label?.trim();
  const mechanical = !label || (!label.includes(" ") && /[A-Z]/.test(key));
  return mechanical ? formatFieldLabel(key) : label;
}

/** The value of one side of a change, through its type. */
function sideValue(
  change: ProposalChangeInput,
  key: string,
  value: unknown,
  def: EffectivePropertyDef | undefined,
  resolved: ResolvedRef | undefined
): RecordValue | null {
  if (key === "profileSlug" && typeof value === "string" && value.trim()) {
    return { kind: "text", text: resolveObjectNoun(value), long: false };
  }
  const renderKind = classifyPropertyKind({ slug: key, value, def });
  return recordValue(renderKind, value, resolved);
}

export interface RecordInput {
  changes: readonly ProposalChangeInput[] | null | undefined;
  /** The proposal's verb (`resolveProposalAction`). */
  action: string;
  /** The record's name the pod resolved (`targetName`). */
  targetName?: string | null;
  /** The record's kind when the diff does not carry it (an update). */
  kind?: string | null;
  /** The kind's property definitions; absent = labels from the key. */
  definitions?: readonly EffectivePropertyDef[];
  /** `objectRefs`: ids in the payload the pod resolved, keyed by path. */
  objectRefs?: Readonly<Record<string, ResolvedRef>>;
  ref?: string;
}

/**
 * One proposal's diff as the record it creates, changes or removes. `null`
 * when the diff has nothing a reviewer can read — the raw request is still in
 * Advanced.
 */
export function proposedRecord(input: RecordInput): ProposedRecord | null {
  if (!Array.isArray(input.changes)) return null;
  const op: ProposedRecord["op"] =
    input.action === "create"
      ? "create"
      : input.action === "delete"
        ? "delete"
        : "update";
  const defs = new Map((input.definitions ?? []).map((d) => [d.slug, d]));
  let title = op === "create" ? null : input.targetName?.trim() || null;
  let kind = input.kind ?? null;
  const fields: RecordField[] = [];

  for (const change of input.changes) {
    const isProperty = change.path.startsWith("properties.");
    const key = isProperty
      ? change.path.slice("properties.".length)
      : change.path;

    // A create's name and kind ARE the card's heading and mark.
    if (op === "create" && change.path === "title") {
      if (typeof change.after === "string" && change.after.trim()) {
        title = change.after.trim();
      }
      continue;
    }
    if (op === "create" && change.path === "profileSlug") {
      if (typeof change.after === "string" && change.after.trim()) {
        kind = change.after.trim();
      }
      continue;
    }

    const def = isProperty ? defs.get(key) : undefined;
    const resolved = input.objectRefs?.[change.path];
    // Machine keys: a door when the pod resolved the object, else nothing.
    void isMachineKey;

    const fieldOp: RecordField["op"] =
      change.operation === "delete"
        ? "remove"
        : change.operation === "update"
          ? "change"
          : "add";
    const after =
      fieldOp === "remove"
        ? undefined
        : sideValue(change, key, change.after, def, resolved);
    const before =
      fieldOp === "add"
        ? undefined
        : change.before === undefined && fieldOp === "change"
          ? undefined
          : sideValue(change, key, change.before, def, resolved);

    // An empty value is not a fact: an add needs a value; a change needs one
    // real side; a removal needs the thing it removes.
    if (fieldOp === "change" && !after && !before) continue;

    const wide = [after, before].some((v) => v?.kind === "text" && v.long);
    fields.push({
      key: change.path,
      label: fieldLabel(change, key, def),
      op: fieldOp,
      before,
      after,
      stale: change.drift === "changed_since",
      wide,
    });
  }

  if (!title && !kind && fields.length === 0) return null;
  return { ref: input.ref ?? "single", title, kind, op, fields };
}

/** The slice of a capture graph's stored operations this reads. */
interface GraphEntityOp {
  op?: unknown;
  ref?: unknown;
  title?: unknown;
  profileSlug?: unknown;
  description?: unknown;
  properties?: unknown;
  existingEntityId?: unknown;
}

/**
 * A capture graph's NEW records, one per `create_entity` op, each keyed by the
 * ref the duplicate door and the approve map use (`op.ref`, else `$opN` —
 * `buildProposalGraph`'s reading). An op that links an existing record creates
 * nothing and has no card.
 */
export function graphRecords(
  payload: unknown,
  definitionsFor: (kind: string) => readonly EffectivePropertyDef[] | undefined
): ProposedRecord[] {
  const ops =
    payload && typeof payload === "object"
      ? (payload as { operations?: unknown }).operations
      : undefined;
  if (!Array.isArray(ops)) return [];
  const out: ProposedRecord[] = [];
  ops.forEach((raw: GraphEntityOp, index) => {
    if (!raw || raw.op !== "create_entity" || raw.existingEntityId) return;
    const ref =
      typeof raw.ref === "string" && raw.ref ? raw.ref : `$op${index}`;
    const kind = typeof raw.profileSlug === "string" ? raw.profileSlug : null;
    const properties =
      raw.properties && typeof raw.properties === "object"
        ? (raw.properties as Record<string, unknown>)
        : {};
    const changes: ProposalChangeInput[] = [
      ...(typeof raw.title === "string"
        ? [
            {
              path: "title",
              label: "",
              operation: "create" as const,
              after: raw.title,
            },
          ]
        : []),
      ...(raw.description !== undefined
        ? [
            {
              path: "description",
              label: "",
              operation: "create" as const,
              after: raw.description,
            },
          ]
        : []),
      ...Object.entries(properties).map(([key, value]) => ({
        path: `properties.${key}`,
        label: "",
        operation: "create" as const,
        after: value,
      })),
    ];
    const record = proposedRecord({
      changes,
      action: "create",
      kind,
      definitions: kind ? definitionsFor(kind) : undefined,
      ref,
    });
    if (record) out.push(record);
  });
  return out;
}
