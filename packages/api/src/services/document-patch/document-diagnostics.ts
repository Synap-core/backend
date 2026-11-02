/**
 * WRITE-TIME DOCUMENT DIAGNOSTICS — what will not render in a document, said
 * before anyone opens it.
 *
 * ADVISORY, ALWAYS: diagnostics never reject a write. They ride on the result
 * of create / patch / proposal (so the writer can self-correct in the same
 * turn), are re-run at approval (a referenced object can vanish in between),
 * and are recomputed after a person's save by `documentDiagnosticsReactor`.
 * They are STORED on `documents.metadata.diagnostics` stamped with the content
 * revision they checked — and only when the document is still at that
 * revision, so a stamp never claims to describe text nobody checked.
 *
 * Three sources, one list:
 *   1. GRAMMAR — `collectDiagnostics` from `@synap-core/markdown-core`
 *      (unterminated embeds, legacy/malformed props, missing references,
 *      unknown `synap-*` directives, column rows), mapped onto the wire codes
 *      below;
 *   2. CATALOG — a `synap-cell{cellKey}` whose key is not in this pod's
 *      renderables (`listRenderables`, the ONE catalog door), is not
 *      embeddable in a document, or lacks its required props;
 *   3. ACCESS — an entity / view / cell instance that does not exist, or that
 *      readers of this document cannot see. Judged through the access layer
 *      (`scopedDb`) UNDER THE DOCUMENT'S LENS: a private entity embedded in a
 *      workspace document is `not_visible` ("readers will see a locked
 *      embed"), not `not_found`. And never a leak: an object the WRITER cannot
 *      see reads `not_found`, exactly as if it did not exist.
 */

import { inArray, entities, views, cellInstances } from "@synap/database";
import {
  collectDiagnostics,
  GRAMMAR_WIRE_CODE,
} from "@synap-core/markdown-core/diagnostics";
import type { Diagnostic as GrammarDiagnostic } from "@synap-core/markdown-core/diagnostics";
import {
  WIDGET_BY_KEY,
  dataBindingFor,
  hasChartSnapshot,
  missingRequiredConfig,
  type WidgetCapabilityDef,
} from "@synap-core/types/renderables";
import { isUuid } from "@synap-core/types/property-render";
import type { Embed } from "@synap-core/markdown-core/embeds";
import { AccessContext, scopedDb } from "../../access/index.js";
import { listRenderables, type RenderableRow } from "../cells/renderables.js";
import { locateEmbeds } from "@synap-core/markdown-core/readable";
import { embedFallback } from "@synap-core/markdown-core/plain-text";
import { TEXT_TONES } from "@synap-core/markdown-core/inline-format";
import {
  MAX_COLUMNS,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
} from "@synap-core/markdown-core/columns";

export const DOCUMENT_DIAGNOSTIC_CODES = [
  "unknown_key",
  "missing_attr",
  "not_found",
  "not_visible",
  "bad_props",
  "legacy_props",
  "unterminated",
  /** `:color[…]{tone}` / `==…=={tone}` names a tone that is not a Synap tone (it draws plain). */
  "unknown_tone",
  /**
   * A column row readers render but that is not what its author meant: a
   * column outside a row, a row in a column, a section in a row, content
   * between columns, more than three columns, one column, an empty column.
   */
  "bad_columns",
  /** A column width that is not a width, on only some columns, or not adding up to 100%. */
  "bad_width",
  /** DESIGN (generation contract rule 6): a heading with nothing under it. */
  "empty_heading",
  /** DESIGN (rule 5): a bare id in prose, where a reader needs a door. */
  "bare_id",
  /** DESIGN (rules 1, 16): hand-typed HTML in the body, outside a sandboxed cell. */
  "raw_html",
  /** DESIGN (rule 13): a phrase the failure-words door bans. */
  "banned_phrase",
  /** DESIGN (rule 7, catalog pass): a list cell asks for more rows than its cap. */
  "over_cap",
  /** DESIGN (rule 10, catalog pass): a chart snapshot with no sentence saying what it shows. */
  "chart_no_finding",
  /**
   * RUN-TIME, not grammar: a chart the report flow could not snapshot (its
   * read failed), so it was left live. Never derived from content — stamped
   * once by `document.stamp_diagnostics` for the revision the flow created,
   * and gone at the next revision (the chart is simply live then).
   */
  "freeze_failed",
] as const;
export type DocumentDiagnosticCode = (typeof DOCUMENT_DIAGNOSTIC_CODES)[number];

export interface DocumentDiagnostic {
  code: DocumentDiagnosticCode;
  severity: "error" | "warning" | "info";
  message: string;
  /** What to call to fix it — names the discovery door, never a guess. */
  fix: string;
  /** 1-based source line, when known. */
  line?: number;
  directive?: string;
  /** The reference involved (`cellKey`, `id`, `viewId`, `instanceId`). */
  ref?: Record<string, string>;
}

// ─── Lookups (injectable, so the classification is testable without a DB) ───

/** How an embedded object stands for this document. */
export type ReferentStatus = "visible" | "not_visible" | "not_found";
export type ReferentKind = "entity" | "view" | "instance";

export interface EmbedResolver {
  /** The renderables visible in the document's workspace, by key. */
  renderables(): Promise<
    ReadonlyMap<string, Pick<RenderableRow, "placements" | "requiredConfig">>
  >;
  /** Status of each id of `kind`. Every id in the input has an answer. */
  referents(
    kind: ReferentKind,
    ids: readonly string[]
  ): Promise<ReadonlyMap<string, ReferentStatus>>;
}

const REFERENT_TABLE = {
  entity: entities,
  view: views,
  instance: cellInstances,
} as const;

/**
 * The pod's resolver for one document: `writerUserId` is who is writing (the
 * leak floor), `workspaceId` is the document's own workspace (the readers'
 * lens; `null` = a personal document, read by its owner).
 */
export function podEmbedResolver(args: {
  writerUserId: string;
  workspaceId: string | null;
}): EmbedResolver {
  const writer = AccessContext.operator({ userId: args.writerUserId });
  const readers = args.workspaceId ? writer.withLens(args.workspaceId) : writer;
  return {
    async renderables() {
      const rows = await listRenderables(args.workspaceId);
      return new Map(rows.map((r) => [r.typeKey, r]));
    },
    async referents(kind, ids) {
      const out = new Map<string, ReferentStatus>();
      const uuids = [...new Set(ids.filter((id) => isUuid(id)))];
      for (const id of ids) if (!isUuid(id)) out.set(id, "not_found");
      if (uuids.length === 0) return out;
      const table = REFERENT_TABLE[kind];
      const where = inArray(table.id, uuids);
      const idsOf = (rows: Array<{ id: string }>) =>
        new Set(rows.map((r) => r.id));
      const [writerSees, readersSee] = await Promise.all([
        scopedDb(writer).findMany<{ id: string }>(table, {
          where,
          columns: { id: true },
        }),
        scopedDb(readers).findMany<{ id: string }>(table, {
          where,
          columns: { id: true },
        }),
      ]);
      const w = idsOf(writerSees);
      const r = idsOf(readersSee);
      for (const id of uuids) {
        // Invisible to the writer ⇒ "not found", whether or not it exists: a
        // writer must not learn that an object it cannot see is there.
        out.set(
          id,
          !w.has(id) ? "not_found" : r.has(id) ? "visible" : "not_visible"
        );
      }
      return out;
    },
  };
}

// ─── Classification ──────────────────────────────────────────────────────────

// The grammar → wire renaming itself is `GRAMMAR_WIRE_CODE` (markdown-core,
// `diagnostics.ts` — pure data, exhaustive over `DiagnosticCode` at the
// TYPE level via `satisfies`). Only its subset check against THIS module's
// wire vocabulary lives here.
type _GrammarCodesAreDocumentCodes =
  GrammarDiagnostic["code"] extends keyof typeof GRAMMAR_WIRE_CODE
    ? (typeof GRAMMAR_WIRE_CODE)[GrammarDiagnostic["code"]] extends DocumentDiagnosticCode
      ? true
      : never
    : never;
const _grammarCodesAreDocumentCodes: _GrammarCodesAreDocumentCodes = true;
void _grammarCodesAreDocumentCodes;

/** What to do about each code — one sentence per code, the ONE copy. */
export const GRAMMAR_FIX: Record<DocumentDiagnosticCode, string> = {
  unterminated:
    "Close the embed with a line of colons matching its opener (e.g. `:::`).",
  legacy_props:
    "Move the props into a ```json block as the embed's first child (it is read as-is; rewrite on your next edit).",
  bad_props: "Make the ```json props block a single JSON object.",
  unknown_tone: `Name one of the Synap tones: ${TEXT_TONES.join(", ")} (e.g. \`:color[text]{tone=info}\`).`,
  bad_columns: `Write a row as \`:::::synap-columns\` holding 2 to ${MAX_COLUMNS} \`::::synap-column\` blocks (the row's fence longer than its columns'), inside a section, never around one.`,
  bad_width: `Give every column a whole-percentage width from ${MIN_COLUMN_WIDTH}% to ${MAX_COLUMN_WIDTH}% (\`width="40%"\`), adding up to 100%, or give none.`,
  missing_attr:
    "Name what the embed shows: `id` (synap-entity), `viewId` (synap-view), `cellKey` or `instanceId` (synap-cell).",
  unknown_key:
    'Call synap_list_widgets({ surface: "document" }) for the keys a document can embed.',
  not_found:
    "Search with synap_find (entities) or synap_list_views (views) and use an id it returns.",
  not_visible:
    "Embed something the document's readers can see, or move the object into this document's workspace.",
  empty_heading:
    "Write what belongs under the heading, or remove the heading (omit a section with nothing to say).",
  bare_id:
    "Name the thing as a door: `[[kind:id|label]]` or an embed (`:::synap-entity{id}`), never the bare id.",
  raw_html:
    "Write it as markdown or a Synap directive; HTML belongs only inside an `html-embed` cell's props.",
  banned_phrase:
    'Say what happened and what to do next, plainly ("Couldn’t …"), without "Oops", "Sorry" or "Something went wrong".',
  over_cap: `Lower the limit to the cap and let "Show all" open the full list (synap_list_widgets({ surface: "document" }) shows each cell's props).`,
  chart_no_finding:
    "Write one sentence after the chart's ```json block saying what it shows; the phone and exports read that sentence.",
  freeze_failed:
    "The chart still reads live. Press Freeze on it once its data can be read, or leave it live.",
};

const KIND_OF_DIRECTIVE: Record<
  string,
  { kind: ReferentKind; attrs: string[] } | undefined
> = {
  "synap-entity": { kind: "entity", attrs: ["id"] },
  "synap-view": { kind: "view", attrs: ["viewId", "data-view-id"] },
};

function firstOf(
  ref: Record<string, string>,
  attrs: readonly string[]
): string | undefined {
  for (const a of attrs) {
    const v = ref[a]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * The version of `diagnoseDocument`'s verdicts. A stored stamp is served only
 * while it carries THIS version, so a checker fix reaches documents stamped
 * before it (their next read re-checks) instead of their old verdict being
 * served for as long as their text does not change. Bump it whenever the
 * checker's verdicts change meaning.
 */
export const DOCUMENT_DIAGNOSTICS_CHECKER = 3;

/**
 * Codes a flow may stamp: run-time facts only; content codes are derived,
 * never asserted. They live only in the stamp (content cannot re-derive them),
 * so a re-check of the same revision carries them over.
 */
export const RUN_TIME_DIAGNOSTIC_CODES = ["freeze_failed"] as const;

/**
 * The generation contract's cap on a list cell's rows (rule 7): a document is
 * read, not scrolled; more rows go behind "Show all". A widget whose config
 * field declares its own maximum is held to that instead.
 */
export const LIST_PROP_CAP = 8;
const LIST_PROP_KEYS = ["limit", "maxItems"] as const;

/** The maximum a widget's config field declares for itself, when it declares one. */
function declaredMax(field: unknown): number | undefined {
  const f = field as {
    max?: unknown;
    constraints?: { max?: unknown };
  } | null;
  const max = f?.constraints?.max ?? f?.max;
  return typeof max === "number" && Number.isFinite(max) ? max : undefined;
}

/**
 * The catalog half of the design pass (generation contract rules 7 and 10):
 * what only the widget's own definition can say. Advisory, like every
 * diagnostic.
 */
function designOfCell(
  key: string,
  builtin: WidgetCapabilityDef,
  embed: Pick<Embed, "props" | "fallback">,
  at: { line?: number; directive: string; ref: Record<string, string> }
): DocumentDiagnostic[] {
  const out: DocumentDiagnostic[] = [];
  for (const prop of LIST_PROP_KEYS) {
    const value = embed.props?.[prop];
    if (typeof value !== "number") continue;
    const field = builtin.configSchema?.find((f) => f.key === prop);
    const cap = declaredMax(field) ?? LIST_PROP_CAP;
    if (value > cap) {
      out.push({
        code: "over_cap",
        severity: "warning",
        message: `"${key}" asks for ${prop} ${value}; a document shows at most ${cap} rows of it.`,
        fix: GRAMMAR_FIX.over_cap,
        ...at,
      });
    }
  }
  if (hasChartSnapshot(embed.props) && embedFallback(embed) === "") {
    out.push({
      code: "chart_no_finding",
      severity: "warning",
      message: `The "${key}" snapshot says nothing in words; on the phone and in exports it reads as a bare chip.`,
      fix: GRAMMAR_FIX.chart_no_finding,
      ...at,
    });
  }
  return out;
}

/** Every diagnostic for `markdown`, judged with `resolver`. Never throws on content. */
export async function diagnoseDocument(
  markdown: string,
  resolver: EmbedResolver
): Promise<DocumentDiagnostic[]> {
  const out: DocumentDiagnostic[] = collectDiagnostics(markdown).map((d) => {
    const code: DocumentDiagnosticCode = GRAMMAR_WIRE_CODE[d.code];
    return {
      code,
      severity: d.severity,
      message: d.message,
      fix: GRAMMAR_FIX[code],
      ...(d.line !== undefined ? { line: d.line } : {}),
      ...(d.directive ? { directive: d.directive } : {}),
    };
  });

  const located = locateEmbeds(markdown);
  const pending: Array<{
    kind: ReferentKind;
    id: string;
    embed: (typeof located)[number]["embed"];
  }> = [];
  const cells: Array<(typeof located)[number]["embed"]> = [];
  for (const { embed } of located) {
    const target = KIND_OF_DIRECTIVE[embed.directive];
    if (target) {
      const id = firstOf(embed.ref, target.attrs);
      if (id) pending.push({ kind: target.kind, id, embed });
      continue;
    }
    if (embed.directive === "synap-cell") {
      const instanceId = firstOf(embed.ref, ["instanceId", "data-instance-id"]);
      if (instanceId) pending.push({ kind: "instance", id: instanceId, embed });
      else if (firstOf(embed.ref, ["cellKey", "data-cell-key"]))
        cells.push(embed);
    }
  }

  if (cells.length > 0) {
    const catalog = await resolver.renderables();
    for (const embed of cells) {
      const key = firstOf(embed.ref, ["cellKey", "data-cell-key"])!;
      const row = catalog.get(key);
      const at = {
        line: embed.line,
        directive: embed.directive,
        ref: { cellKey: key },
      };
      if (!row) {
        out.push({
          code: "unknown_key",
          severity: "error",
          message: `No renderable "${key}" exists on this pod; the embed will show as unknown.`,
          fix: GRAMMAR_FIX.unknown_key,
          ...at,
        });
        continue;
      }
      if (!row.placements.includes("inline")) {
        out.push({
          code: "unknown_key",
          severity: "error",
          message: `"${key}" is not embeddable in a document (its placements are ${row.placements.join(", ") || "none"}).`,
          fix: GRAMMAR_FIX.unknown_key,
          ...at,
        });
        continue;
      }
      // A props error is already reported by the grammar pass.
      if (embed.propsError) continue;
      const builtin = WIDGET_BY_KEY[key];
      // A chart that carries its own numbers (a snapshot) draws them without a
      // query, so the query keys it would need to go live (profileSlug, groupBy,
      // stageField…) are not missing: useChartSeries reads `data` and never runs
      // the query. Only a chart whose binding supports `inline` can hold one; a
      // live-only chart with `data` still needs its query keys.
      const drawnFromSnapshot =
        !!builtin &&
        hasChartSnapshot(embed.props) &&
        !!dataBindingFor(builtin)?.supports.includes("inline");
      const missing = drawnFromSnapshot
        ? []
        : builtin
          ? missingRequiredConfig(builtin, embed.props)
          : row.requiredConfig.filter(
              (k) => embed.props?.[k] == null || embed.props?.[k] === ""
            );
      if (missing.length > 0) {
        out.push({
          code: "bad_props",
          severity: "error",
          message: `"${key}" needs props.${missing.join(", props.")}; without ${missing.length === 1 ? "it" : "them"} the cell renders empty.`,
          fix: `Add ${missing.map((k) => `"${k}"`).join(", ")} to the embed's \`\`\`json block (synap_list_widgets({ surface: "document" }) shows each key's props).`,
          ...at,
        });
      }
      if (builtin) out.push(...designOfCell(key, builtin, embed, at));
    }
  }

  for (const kind of ["entity", "view", "instance"] as const) {
    const mine = pending.filter((p) => p.kind === kind);
    if (mine.length === 0) continue;
    const status = await resolver.referents(
      kind,
      mine.map((p) => p.id)
    );
    for (const p of mine) {
      const s = status.get(p.id);
      if (s === undefined) {
        // A resolver that skipped an id is a broken resolver, not a pass.
        throw new Error(
          `embed resolver returned no status for ${kind} ${p.id}`
        );
      }
      if (s === "visible") continue;
      const noun = kind === "instance" ? "cell instance" : kind;
      out.push({
        code: s,
        severity: s === "not_found" ? "error" : "warning",
        message:
          s === "not_found"
            ? `The ${noun} ${p.id} does not exist (or you cannot see it); the embed will show as missing.`
            : `The ${noun} ${p.id} is not visible to this document's readers; they will see a locked embed.`,
        fix: GRAMMAR_FIX[s],
        ...(p.embed.line !== undefined ? { line: p.embed.line } : {}),
        directive: p.embed.directive,
        ref: { ...p.embed.ref },
      });
    }
  }

  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
