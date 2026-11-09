/**
 * What a pending data change does, as before → after (finding 4e4b2858, the
 * founder: "I struggle understanding what this text even means … make it more
 * graphical"). Two outputs from ONE read of the pod:
 *
 *   - `DataChangePreview` (`@synap-core/types/package-updates`): the kinds,
 *     the status or field on each side, the engine's count, sample titles and
 *     the records left as they are, grouped by why. Pod admin draws it.
 *   - `previewLines`: the same, as short plain lines, for the terminal
 *     (`synap market update` prints the change's `description`).
 *
 * Words are LABELS wherever the pod has one: a kind's display name (profile),
 * a field's label (property def, `resolvePropertyLabel`), a status's label
 * (lifecycle option, `lifecycleOptionLabel`). The raw slug shows only when no
 * label exists, or when reading the labels FAILED: a failed label read never
 * throws the count away (`readDataChangeWords` swallows into slugs, logged).
 */

import type { Sql } from "postgres";
import { lifecycleOptionLabel } from "@synap-core/types/lifecycle";
import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";
import type {
  DataChangeKeptGroup,
  DataChangeKindLabel,
  DataChangeLabel,
  DataChangePreview,
  DataChangeSamples,
} from "@synap-core/types/package-updates";
import type {
  ConversionOp,
  RekindByStatusOp,
  RemapPropertyValuesOp,
  RenameProfileOp,
  RenamePropertyKeyOp,
} from "./manifest.js";
import type { OpCounts } from "./engine.js";
import { renameTemplateRows } from "./engine.js";
import { resolvePropertyLabel } from "../utils/property-presentation.js";
import { readStoredEnumOptions } from "../utils/property-enum.js";

/** How many record titles a preview carries per list. */
export const DATA_CHANGE_SAMPLE_CAP = 25;

// ─── Words: labels for slugs, keys and values ───────────────────────────────

/** The words a change is told in. Every lookup answers; a miss is the raw token. */
export interface DataChangeWords {
  kind(slug: string): DataChangeKindLabel;
  field(kindSlug: string, key: string): DataChangeLabel;
  /** A value of a field: a lifecycle status, or an option of a closed set. */
  value(kindSlug: string, key: string, value: string): DataChangeLabel;
}

/** No labels: every word is its raw token (a failed read, or a unit test). */
export const SLUG_WORDS: DataChangeWords = {
  kind: (slug) => ({ key: slug, label: slug, plural: slug }),
  field: (_kind, key) => ({ key, label: key }),
  value: (_kind, _key, value) => ({ key: value, label: value }),
};

/** What an op names: the kinds, and the fields of each kind. */
export interface DataChangeTerms {
  kinds: string[];
  fields: Array<{ kind: string; key: string }>;
}

/** The kinds and fields an op's words name (what `readDataChangeWords` loads). */
export function opTerms(op: ConversionOp): DataChangeTerms {
  switch (op.op) {
    case "rekindByStatus":
      return {
        kinds: [op.slug, op.toSlug],
        fields: [
          { kind: op.slug, key: op.status.key },
          { kind: op.toSlug, key: op.targetStatus.key },
          ...(op.skipWhenSet ?? []).map((key) => ({ kind: op.slug, key })),
        ],
      };
    case "renamePropertyKey":
    case "remapPropertyValues":
      return {
        kinds: [op.slug],
        fields: [
          { kind: op.slug, key: op.sourceKey },
          { kind: op.slug, key: op.targetKey },
        ],
      };
    case "moveBasePropertyToFacet":
      return {
        kinds: [op.slug, op.facetSlug],
        fields: [{ kind: op.slug, key: op.sourceKey }],
      };
    case "remapFacetPropertyValues":
      return {
        kinds: [op.slug],
        fields: [
          { kind: op.slug, key: op.sourceKey },
          { kind: op.slug, key: op.targetKey },
        ],
      };
    case "renameProfile":
      return { kinds: [op.slug, op.toSlug], fields: [] };
    case "convertToFacet":
      return { kinds: [op.slug, op.targetKindSlug], fields: [] };
    case "convertToKind":
      return { kinds: [op.slug, op.fromKindSlug], fields: [] };
    case "mergeInto":
      return { kinds: [...op.fromSlugs, op.intoSlug], fields: [] };
    case "foldRoleIntoStatus":
      return { kinds: [op.slug, ...op.targets.map((t) => t.role)], fields: [] };
    case "foldBookingDealIntoLead":
      return { kinds: [op.slug, op.lead.role], fields: [] };
    case "declareKind":
    case "seedKindProfile":
    case "keep":
    case "extractNonEntity":
    case "dedupeProfileRows":
      return { kinds: [op.slug], fields: [] };
    case "dedupeRelationDefs":
    case "projectLifecycleColumns":
    case "fillFacetInitialStatus":
    case "dropStaleLifecycleLists":
      return { kinds: [], fields: [] };
    case "reconcileEntityScope":
    case "reconcileFacetScope":
      return { kinds: op.slug ? [op.slug] : [], fields: [] };
    default: {
      const unhandled: never = op;
      return unhandled;
    }
  }
}

type Row = Record<string, unknown>;

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Read the labels an op's words need, in two queries. Rows are read whole
 * (`to_jsonb`), so a pod whose tables lack a label column answers "no label"
 * rather than failing. A failed read is logged and answers SLUG_WORDS: the
 * count and the change still show, in raw words.
 */
export async function readDataChangeWords(
  sql: Sql,
  terms: DataChangeTerms
): Promise<DataChangeWords> {
  const slugs = [
    ...new Set([...terms.kinds, ...terms.fields.map((f) => f.kind)]),
  ];
  if (slugs.length === 0) return SLUG_WORDS;
  try {
    const profiles = await sql<Array<{ row: Row }>>`
      SELECT to_jsonb(p) AS row FROM profiles p
      WHERE p.slug = ANY(${slugs}::text[]) AND p.is_active = true
      ORDER BY (p.workspace_id IS NULL) DESC, p.created_at ASC NULLS LAST
    `;
    const keys = [...new Set(terms.fields.map((f) => f.key))];
    const defs =
      keys.length === 0
        ? []
        : await sql<Array<{ row: Row; owner_ids: string[] | null }>>`
            SELECT to_jsonb(pd) AS row,
                   ARRAY(SELECT pp.profile_id::text FROM profile_properties pp
                         WHERE pp.property_def_id = pd.id) AS owner_ids
            FROM property_defs pd
            WHERE pd.slug = ANY(${keys}::text[])
          `;
    return wordsFrom(
      profiles.map((p) => p.row),
      defs
    );
  } catch (err) {
    console.warn(
      `[data-changes] could not read labels for ${slugs.join(", ")}; showing slugs: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return SLUG_WORDS;
  }
}

/** The words from the rows read: the first live row per slug, the owning def per field. */
function wordsFrom(
  profiles: Row[],
  defs: Array<{ row: Row; owner_ids: string[] | null }>
): DataChangeWords {
  const kindRow = new Map<string, Row>();
  const slugOfId = new Map<string, string>();
  for (const p of profiles) {
    const slug = String(p.slug);
    slugOfId.set(String(p.id), slug);
    // Prefer a row that carries a display name (rows are pod-wide first).
    const held = kindRow.get(slug);
    if (!held || (!text(held.display_name) && text(p.display_name)))
      kindRow.set(slug, p);
  }
  /** The def of `key` on `kind`: one the kind owns, else a global one. */
  const defOf = (kind: string, key: string): Row | undefined => {
    let global: Row | undefined;
    for (const d of defs) {
      if (d.row.slug !== key) continue;
      const owners = [
        ...(d.owner_ids ?? []),
        ...(d.row.profile_id ? [String(d.row.profile_id)] : []),
      ];
      if (owners.some((id) => slugOfId.get(id) === kind)) return d.row;
      if (!d.row.profile_id && !global) global = d.row;
    }
    return global;
  };
  return {
    kind(slug) {
      const row = kindRow.get(slug);
      const label = text(row?.display_name);
      if (!label) return SLUG_WORDS.kind(slug);
      return {
        key: slug,
        label,
        plural: text(row?.plural) ?? resolveObjectNounPlural(label),
      };
    },
    field(kind, key) {
      const def = defOf(kind, key);
      if (!def) return SLUG_WORDS.field(kind, key);
      return {
        key,
        label: resolvePropertyLabel({ slug: key, uiHints: def.ui_hints }),
      };
    },
    value(kind, key, value) {
      const def = defOf(kind, key);
      const options = def
        ? readStoredEnumOptions({
            constraints: (def.constraints ?? null) as Row | null,
            uiHints: (def.ui_hints ?? null) as Row | null,
          })
        : undefined;
      const option = options?.find((o) => o.key === value);
      if (!option) return SLUG_WORDS.value(kind, key, value);
      return { key: value, label: lifecycleOptionLabel(option) };
    },
  };
}

// ─── The preview, per op shape ──────────────────────────────────────────────

/** A capped title list from a full count and the titles read (nulls dropped). */
function samplesOf(n: number, titles: Array<string | null>): DataChangeSamples {
  const shown = titles
    .map((t) => text(t))
    .filter((t): t is string => t !== null)
    .slice(0, DATA_CHANGE_SAMPLE_CAP);
  return { titles: shown, more: Math.max(0, n - shown.length) };
}

/** A record's title, whether the pod keeps it in a column or in its properties. */
const TITLE = (sql: Sql) =>
  sql`COALESCE(to_jsonb(e)->>'title', e.properties->>'title')`;

/**
 * rekindByStatus: the things at the status, grouped by WHICH `skipWhenSet`
 * fields they hold (the engine's own "held" test: not null, "", [] or {}).
 * The empty group moves; every other group stays, with its fields as the
 * reason. Mirrors `rekindAtStatus` / `rekindHeld` (engine.ts).
 */
async function rekindPreview(
  sql: Sql,
  op: RekindByStatusOp,
  counts: OpCounts,
  w: DataChangeWords
): Promise<DataChangePreview> {
  const skip = op.skipWhenSet ?? [];
  const groups = await sql<
    Array<{ held: string[]; n: number; titles: Array<string | null> }>
  >`
    SELECT held, COUNT(*)::int AS n,
           (array_agg(title ORDER BY title NULLS LAST))[1:${DATA_CHANGE_SAMPLE_CAP}::int] AS titles
    FROM (
      SELECT ${TITLE(sql)} AS title,
             ARRAY(
               SELECT k.key FROM unnest(${skip}::text[]) WITH ORDINALITY AS k(key, i)
               WHERE jsonb_typeof(e.properties -> k.key) IS NOT NULL
                 AND jsonb_typeof(e.properties -> k.key) <> 'null'
                 AND (e.properties -> k.key) NOT IN ('""'::jsonb, '[]'::jsonb, '{}'::jsonb)
               ORDER BY k.i
             ) AS held
      FROM entities e
      JOIN profiles p ON p.id = e.profile_id AND p.slug = ${op.slug} AND p.is_active = true
      WHERE e.deleted_at IS NULL
        AND e.properties->>${op.status.key}::text = ${op.status.value}::text
    ) s
    GROUP BY held
  `;
  const moving = groups.find((g) => g.held.length === 0);
  const keptGroups: DataChangeKeptGroup[] = groups
    .filter((g) => g.held.length > 0)
    .sort((a, b) => a.held.length - b.held.length || a.n - b.n)
    .map((g) => ({
      reason: "fieldsSet" as const,
      fields: g.held.map((key) => w.field(op.slug, key)),
      count: g.n,
      samples: samplesOf(g.n, g.titles),
    }));
  const moved = counts.entitiesRekinded ?? 0;
  const keptCount =
    counts.entitiesKeptByRule ?? keptGroups.reduce((n, g) => n + g.count, 0);
  return {
    change: "rekind",
    from: {
      kind: w.kind(op.slug),
      detail: {
        as: "status",
        label: w.value(op.slug, op.status.key, op.status.value),
      },
      count: moved,
    },
    to: {
      kind: w.kind(op.toSlug),
      detail: {
        as: "status",
        label: w.value(op.toSlug, op.targetStatus.key, op.targetStatus.value),
      },
      count: moved,
    },
    samples: samplesOf(moved, moving?.titles ?? []),
    kept: keptCount > 0 ? { count: keptCount, groups: keptGroups } : null,
  };
}

/** renamePropertyKey: the things carrying the old key (the apply's own selection). */
async function renameFieldPreview(
  sql: Sql,
  op: RenamePropertyKeyOp,
  affected: number,
  w: DataChangeWords
): Promise<DataChangePreview> {
  const titles = await sql<Array<{ title: string | null }>>`
    SELECT ${TITLE(sql)} AS title FROM entities e
    JOIN profiles p ON p.id = e.profile_id AND p.slug = ${op.slug}
    WHERE e.deleted_at IS NULL AND e.properties ? ${op.sourceKey}::text
    ORDER BY 1 NULLS LAST LIMIT ${DATA_CHANGE_SAMPLE_CAP}
  `;
  const kind = w.kind(op.slug);
  return {
    change: "renameField",
    from: {
      kind,
      detail: { as: "field", label: w.field(op.slug, op.sourceKey) },
      count: affected,
    },
    to: {
      kind,
      detail: { as: "field", label: w.field(op.slug, op.targetKey) },
      count: affected,
    },
    samples: samplesOf(
      affected,
      titles.map((t) => t.title)
    ),
    kept: null,
  };
}

/** remapPropertyValues: each mapped old value, its new one, and how many hold it. */
async function translateValuesPreview(
  sql: Sql,
  op: RemapPropertyValuesOp,
  affected: number,
  w: DataChangeWords
): Promise<DataChangePreview> {
  const mapped = Object.keys(op.valueMap);
  const byValue = await sql<Array<{ value: string; n: number }>>`
    SELECT e.properties->>${op.sourceKey}::text AS value, COUNT(*)::int AS n
    FROM entities e
    JOIN profiles p ON p.id = e.profile_id AND p.slug = ${op.slug}
    WHERE e.deleted_at IS NULL
      AND e.properties->>${op.sourceKey}::text = ANY(${mapped}::text[])
    GROUP BY 1
  `;
  const titles = await sql<Array<{ title: string | null }>>`
    SELECT ${TITLE(sql)} AS title FROM entities e
    JOIN profiles p ON p.id = e.profile_id AND p.slug = ${op.slug}
    WHERE e.deleted_at IS NULL
      AND e.properties->>${op.sourceKey}::text = ANY(${mapped}::text[])
    ORDER BY 1 NULLS LAST LIMIT ${DATA_CHANGE_SAMPLE_CAP}
  `;
  const kind = w.kind(op.slug);
  const count = new Map(byValue.map((r) => [r.value, r.n]));
  return {
    change: "translateValues",
    from: {
      kind,
      detail: { as: "field", label: w.field(op.slug, op.sourceKey) },
      count: affected,
    },
    to: {
      kind,
      detail: { as: "field", label: w.field(op.slug, op.targetKey) },
      count: affected,
    },
    samples: samplesOf(
      affected,
      titles.map((t) => t.title)
    ),
    values: mapped
      .filter((v) => (count.get(v) ?? 0) > 0)
      .map((v) => ({
        from: w.value(op.slug, op.sourceKey, v),
        to: w.value(op.slug, op.targetKey, op.valueMap[v]!),
        count: count.get(v)!,
      })),
    kept: null,
  };
}

/** renameProfile: every thing of the kind (of one template's rows with `fromTemplate`); the new name is the op's, else the slug's. */
async function renameKindPreview(
  sql: Sql,
  op: RenameProfileOp,
  affected: number,
  w: DataChangeWords
): Promise<DataChangePreview> {
  // A `fromTemplate` rename samples only the rows it renames.
  const ids = op.fromTemplate
    ? (await renameTemplateRows(sql, { ...op, fromTemplate: op.fromTemplate }))
        .filter((r) => !r.twin)
        .map((r) => r.id)
    : null;
  const titles = await sql<Array<{ title: string | null }>>`
    SELECT ${TITLE(sql)} AS title FROM entities e
    JOIN profiles p ON p.id = e.profile_id AND p.slug = ${op.slug}
    WHERE e.deleted_at IS NULL
      AND (${ids === null} OR p.id = ANY(${ids ?? []}::uuid[]))
    ORDER BY 1 NULLS LAST LIMIT ${DATA_CHANGE_SAMPLE_CAP}
  `;
  const named = text(op.displayName);
  return {
    change: "renameKind",
    from: { kind: w.kind(op.slug), detail: null, count: affected },
    to: {
      kind: named
        ? {
            key: op.toSlug,
            label: named,
            plural: resolveObjectNounPlural(named),
          }
        : w.kind(op.toSlug),
      detail: null,
      count: affected,
    },
    samples: samplesOf(
      affected,
      titles.map((t) => t.title)
    ),
    kept: null,
  };
}

/**
 * The preview of one measured op, or `undefined` for an op with no from → to
 * shape. A failed read of the samples is logged and answers `undefined`: the
 * change still shows, as its sentence, with its count.
 */
export async function buildDataChangePreview(
  sql: Sql,
  op: ConversionOp,
  counts: OpCounts,
  affected: number,
  w: DataChangeWords
): Promise<DataChangePreview | undefined> {
  try {
    switch (op.op) {
      case "rekindByStatus":
        return await rekindPreview(sql, op, counts, w);
      case "renamePropertyKey":
        return await renameFieldPreview(sql, op, affected, w);
      case "remapPropertyValues":
        return await translateValuesPreview(sql, op, affected, w);
      case "renameProfile":
        return await renameKindPreview(sql, op, affected, w);
      default:
        return undefined;
    }
  } catch (err) {
    console.warn(
      `[data-changes] could not read the preview of ${op.opKey}; showing its sentence: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return undefined;
  }
}

// ─── The same, in plain lines (the terminal) ────────────────────────────────

/** "A, B and C". */
export function andList(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const sideWords = (s: DataChangePreview["from"]): string =>
  s.detail ? `${s.kind.label} · ${s.detail.label.label}` : s.kind.label;

/**
 * Continuation lines are indented 6 spaces: `synap market update` prints a
 * change as "    • <description> (<count> · <op key>)", so they sit under
 * the first line's words, and the count lands after the last line, which is
 * the line that says what changes.
 */
export const DESCRIPTION_INDENT = "      ";

/** The preview, as the short plain lines the terminal prints. */
export function previewLines(p: DataChangePreview): string[] {
  const looked = p.from.count + (p.kept?.count ?? 0);
  const kinds = (n: number, k: DataChangeKindLabel) =>
    `${n} ${n === 1 ? k.label : k.plural}`;
  const move = `${sideWords(p.from)} → ${sideWords(p.to)}: ${p.from.count}.`;
  switch (p.change) {
    case "rekind": {
      const lines = [
        `${p.from.kind.plural} at ${p.from.detail?.label.label ?? ""} become ${p.to.kind.plural} (${kinds(looked, p.from.kind)} looked at).`,
      ];
      if (p.kept) {
        lines.push(`Stay as ${p.from.kind.plural}: ${p.kept.count}.`);
        for (const g of p.kept.groups)
          lines.push(
            `  ${andList(g.fields.map((f) => f.label))} already set: ${g.count}.`
          );
      }
      lines.push(`${move} Same records: content, links and history are kept.`);
      return lines;
    }
    case "renameField":
      return [
        `A field is renamed on ${p.from.kind.plural}.`,
        `${move} Every value moves as it is.`,
      ];
    case "renameKind":
      return [
        `The kind ${p.from.kind.label} is renamed ${p.to.kind.label}.`,
        `${move} Same records: content, links and history are kept.`,
      ];
    case "translateValues":
      return [
        `The values of ${p.from.detail?.label.label ?? ""} on ${p.from.kind.plural} are translated.`,
        ...(p.values ?? []).map(
          (v) => `  ${v.from.label} → ${v.to.label}: ${v.count}.`
        ),
        move,
      ];
    default: {
      const unhandled: never = p.change;
      return unhandled;
    }
  }
}

/** Lines joined for `description`: the first as is, the rest indented. */
export function joinDescription(lines: readonly string[]): string {
  return lines.join(`\n${DESCRIPTION_INDENT}`);
}
