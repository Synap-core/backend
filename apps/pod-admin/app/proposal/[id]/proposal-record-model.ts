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
  humanizeToken,
  resolveObjectNoun,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import {
  resolveEntityMedia,
  type MediaRef,
} from "@synap-core/types/presentation";
import { formatDate, formatTimestamp } from "../../../lib/format";
import {
  hasChanges,
  textChanges,
  type TextChange,
} from "../../_lib/object/content/document-changes-model";
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
  | { kind: "tags"; items: string[] }
  /** Source code, whole: never clipped (the card may fold it, never cut it). */
  | { kind: "code"; text: string; lines: number }
  /**
   * A rewritten text, whole, with its changes where they happen (instructions,
   * a goal, a note's body). `code`: read as source, line by line.
   */
  | { kind: "changes"; change: TextChange; code: boolean };

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

/**
 * What approving lets RUN or lets an agent READ, before anything else: a
 * skill's code, its instructions (they land in an agent's system prompt),
 * and the tools it declared it calls (its runs call them with no second
 * review). These lead the card, in this order, so they never sit behind
 * "Show all N fields"; and the code and the instructions are drawn whole.
 * Approving a skill create turns it on (the one-approval rule): this page is
 * the one review.
 */
const MUST_READ_KEYS: readonly string[] = [
  "code",
  "body",
  "instructions",
  "requiredToolNames",
];

/** The record's own keys drawn whole, as written: never clipped. */
const WHOLE_TEXT_KEYS: ReadonlySet<string> = new Set([
  "code",
  "body",
  "instructions",
]);

/** Whole texts that are prose (markdown): a rewrite reads as its changes. */
const PROSE_TEXT_KEYS: ReadonlySet<string> = new Set(["body", "instructions"]);

/**
 * The property kinds whose rewrite reads as a diff. Never a secret (the card
 * never draws one), a link, a date or a choice: those keep their own reading.
 */
const DIFFABLE_KINDS: ReadonlySet<PropertyRenderKind> = new Set([
  "text",
  "richtext",
]);

/**
 * A rewritten text, whole, with its changes in place, or `null` when the two
 * sides are not both text or nothing changed.
 */
export function proseChanges(
  before: unknown,
  after: unknown
): RecordValue | null {
  if (typeof before !== "string" || typeof after !== "string") return null;
  if (before.trim() === "" || after.trim() === "") return null;
  const lines = textChanges(before, after);
  return hasChanges(lines)
    ? { kind: "changes", change: { before, after, lines }, code: false }
    : null;
}

/** Rewritten code, read line by line, or `null` when it did not change. */
export function codeChanges(
  before: unknown,
  after: unknown
): RecordValue | null {
  if (typeof before !== "string" || typeof after !== "string") return null;
  if (before.trim() === "" || after.trim() === "" || before === after) {
    return null;
  }
  return { kind: "changes", change: { before, after, lines: [] }, code: true };
}

/** Text past this many characters (or with a line break) takes the card's width. */
const WIDE_TEXT_CHARS = 80;

/** A text a rewrite of reads as a diff: too long to compare by eye. */
function isLongText(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.trim().length > WIDE_TEXT_CHARS || value.trim().includes("\n"))
  );
}
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
  if (def) return resolvePropertyLabel(def);
  if (change.path.startsWith("properties.")) return formatFieldLabel(key);
  if (key === "profileSlug") return resolveObjectNoun("kind");
  const label = change.label?.trim();
  const mechanical = !label || (!label.includes(" ") && /[A-Z]/.test(key));
  return mechanical ? formatFieldLabel(key) : label;
}

/** Source code as the reviewer reads it: every character, every line. */
export function codeValue(value: unknown): RecordValue | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return { kind: "code", text: value, lines: value.split("\n").length };
}

/** The value of one side of a change, through its type. */
function sideValue(
  key: string,
  value: unknown,
  def: EffectivePropertyDef | undefined,
  resolved: ResolvedRef | undefined,
  isProperty: boolean
): RecordValue | null {
  if (key === "profileSlug" && typeof value === "string" && value.trim()) {
    return { kind: "text", text: resolveObjectNoun(value), long: false };
  }
  // The record's own code and instructions (a skill's), never a property that
  // happens to be named so: drawn as written, every line, so the reviewer
  // reads exactly what will run or what an agent will be told.
  if (!isProperty && WHOLE_TEXT_KEYS.has(key)) return codeValue(value);
  const renderKind = classifyPropertyKind({ slug: key, value, def });
  return recordValue(renderKind, value, resolved);
}

/**
 * The media of the entity a create proposes — an uploaded image waiting for
 * approval — read by the one resolver from the record the gate stored
 * (`documentId`, `properties.mimeType`). `null` when it has none. The bytes
 * are already stored, so the reviewer sees what they approve.
 */
export function proposedEntityMedia(payload: unknown): MediaRef | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const properties =
    row.properties && typeof row.properties === "object"
      ? (row.properties as Record<string, unknown>)
      : null;
  const { primary } = resolveEntityMedia({
    id: typeof row.id === "string" ? row.id : "",
    documentId: typeof row.documentId === "string" ? row.documentId : null,
    properties,
  });
  return primary.via === "none" ? null : primary;
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
 * A link proposal as what it joins: its two ends (doors when the pod resolved
 * them, else the names the pod wrote beside them) and the relation between
 * them — never its columns. Live (proposal f15b68ae, 2026-10-28): a link
 * delete drew Title, From ID, To type, Source label… each "empty removed", and
 * the founder could not tell what the agent was deleting.
 */
function linkRecord(
  input: RecordInput,
  op: "create" | "delete"
): ProposedRecord | null {
  const changes = input.changes ?? [];
  const valueAt = (path: string): unknown => {
    const change = changes.find((c) => c.path === path);
    return op === "delete" ? change?.before : change?.after;
  };
  const end = (idPath: string, namePath: string): RecordValue | null => {
    const resolved = input.objectRefs?.[idPath];
    if (resolved) return recordValue("text", valueAt(idPath), resolved);
    const name = valueAt(namePath);
    return typeof name === "string" && name.trim() ? textValue(name) : null;
  };
  const linkType = valueAt("linkType");
  const relationText =
    typeof linkType === "string" && linkType.trim()
      ? humanizeToken(linkType)
      : null;
  const relation = relationText ? textValue(relationText) : null;
  const from = end("fromId", "sourceLabel");
  const to = end("toId", "targetLabel");
  const fieldOp: RecordField["op"] = op === "delete" ? "remove" : "add";
  const fields = (
    [
      ["fromId", "From", from],
      ["linkType", "Relation", relation],
      ["toId", "To", to],
    ] as const
  ).flatMap(([key, label, value]): RecordField[] =>
    value
      ? [
          {
            key,
            label,
            op: fieldOp,
            before: op === "delete" ? value : undefined,
            after: op === "delete" ? undefined : value,
            stale: false,
            wide: false,
          },
        ]
      : []
  );
  const name = (v: RecordValue | null) =>
    v?.kind === "ref" ? v.name : v?.kind === "text" ? v.text : null;
  // "Markdown → pod cleanup blocked by Resolve what needs you", not the pod's
  // generic "Session blocked by session".
  const title =
    from && to && relationText
      ? `${name(from)} ${relationText.toLowerCase()} ${name(to)}`
      : input.targetName?.trim() || null;
  if (fields.length === 0) return null;
  return { ref: input.ref ?? "single", title, kind: "link", op, fields };
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
  if (input.kind === "link" && op !== "update") return linkRecord(input, op);
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
    // `profileSlug` is the record's KIND — a kind change is the change itself,
    // though the shared rule files the column under bookkeeping.
    const isKind = key === "profileSlug";
    if (!def && !isKind && isMachineKey(key) && !resolved) continue;

    const fieldOp: RecordField["op"] =
      change.operation === "delete"
        ? "remove"
        : change.operation === "update"
          ? "change"
          : "add";
    // A rewritten text reads as the whole text with its changes in place,
    // never two whole copies: a skill's code line by line, its instructions,
    // and any long text (a goal, a description, a note's body) as prose.
    const rewrite =
      fieldOp !== "change"
        ? null
        : !isProperty && key === "code"
          ? codeChanges(change.before, change.after)
          : (!isProperty && PROSE_TEXT_KEYS.has(key)) ||
              ((isLongText(change.before) || isLongText(change.after)) &&
                !(!isProperty && WHOLE_TEXT_KEYS.has(key)) &&
                DIFFABLE_KINDS.has(
                  classifyPropertyKind({ slug: key, value: change.after, def })
                ))
            ? proseChanges(change.before, change.after)
            : null;
    const after = rewrite
      ? rewrite
      : fieldOp === "remove"
        ? undefined
        : sideValue(key, change.after, def, resolved, isProperty);
    const before =
      rewrite || fieldOp === "add"
        ? undefined
        : change.before === undefined && fieldOp === "change"
          ? undefined
          : sideValue(key, change.before, def, resolved, isProperty);

    // An empty value is not a fact: an add needs a value; a change needs one
    // real side; a removal needs the thing it removes.
    if (fieldOp === "add" && !after) continue;
    if (fieldOp === "change" && !after && !before) continue;
    if (fieldOp === "remove" && !before) continue;

    const wide = [after, before].some(
      (v) =>
        (v?.kind === "text" && v.long) ||
        v?.kind === "code" ||
        v?.kind === "changes"
    );
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
  const rank = (f: RecordField) => {
    const i = MUST_READ_KEYS.indexOf(f.key);
    return i < 0 ? MUST_READ_KEYS.length : i;
  };
  fields.sort((a, b) => rank(a) - rank(b)); // stable: the rest keep their order
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
