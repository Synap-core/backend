/**
 * FREEZE CHART EMBEDS — turn a document's LIVE chart embeds into SNAPSHOTS
 * (decision D2: an AI-written report's charts default to a snapshot, so the
 * chart keeps matching the sentence written beside it).
 *
 * The model never writes chart numbers: the report assembler emits live query
 * charts (`profileSlug` + settings), and this step runs each one's query and
 * stores the result as `data` + `capturedAt`, keeping the query keys so a
 * reader can "Make live". The numbers are produced by the SAME shaper the
 * browser's live chart uses (`shapeChartEntities`, @synap-core/types) over the
 * rows of the SAME read the live chart issues (`readEntities`, wired by the
 * caller to the `entities.list` procedure itself) — so a frozen chart is what
 * the live chart drew at `capturedAt`.
 *
 * EMPTY ≠ FAILED. A read that FAILS leaves that chart LIVE and says so with a
 * `freeze_failed` diagnostic — never an empty `data`. A read that returns ZERO
 * rows is a genuine, valid snapshot (an explicit empty series, with its date).
 *
 * Only embeds this can freeze honestly are touched: a `synap-cell` whose
 * catalog binding supports `inline`, that has no `data` yet, and whose props
 * decoded. Everything else is left byte-for-byte.
 */

import { serializeEmbed } from "@synap-core/markdown-core";
import {
  WIDGET_BY_KEY,
  dataBindingFor,
  freezeChartProps,
  hasChartSnapshot,
  isChartCellKey,
  shapeChartEntities,
} from "@synap-core/types/renderables";
import { locateEmbeds } from "../document-patch/patch-ops.js";
import {
  GRAMMAR_FIX,
  type DocumentDiagnostic,
} from "../document-patch/document-diagnostics.js";

/**
 * A chart left live because its read failed — in W4b's document-diagnostic
 * vocabulary (`freeze_failed`), so `document.stamp_diagnostics` can store it
 * on `documents.metadata.diagnostics` beside the content diagnostics.
 */
export interface FreezeChartDiagnostic extends DocumentDiagnostic {
  code: "freeze_failed";
  severity: "warning";
  directive: "synap-cell";
  /** 1-based source line of the embed in the OUTPUT markdown (what gets stored). */
  line: number;
  ref: { cellKey: string };
}

export interface FreezeChartsResult {
  markdown: string;
  /** How many chart embeds now carry a snapshot. */
  frozen: number;
  /** Charts left live because their read failed. */
  diagnostics: FreezeChartDiagnostic[];
}

/**
 * The live chart's read: entity rows for a `profileSlug` (or every profile).
 * MUST be the live chart's own query — the caller wires it to `entities.list`.
 * A thrown error is a FAILED read (the chart stays live).
 */
export type ChartEntitiesReader = (
  profileSlug: string | undefined
) => Promise<Array<Record<string, unknown>>>;

function lineOf(markdown: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (markdown.charCodeAt(i) === 10) line++;
  return line;
}

function reason(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

export async function freezeChartEmbeds(
  markdown: string,
  readEntities: ChartEntitiesReader,
  now: Date = new Date()
): Promise<FreezeChartsResult> {
  const located = locateEmbeds(markdown);
  const candidates = located.filter(({ embed }) => {
    const key = embed.ref.cellKey;
    if (
      embed.directive !== "synap-cell" ||
      embed.ref.instanceId ||
      !key ||
      !isChartCellKey(key)
    )
      return false;
    if (!embed.props || hasChartSnapshot(embed.props)) return false;
    const def = WIDGET_BY_KEY[key];
    return !!def && !!dataBindingFor(def)?.supports.includes("inline");
  });

  // One read per profile, shared by every chart over it (the live charts share
  // one TanStack cache entry per profile too).
  const reads = new Map<string, Promise<Array<Record<string, unknown>>>>();
  const read = (profileSlug: string | undefined) => {
    const k = profileSlug ?? "";
    if (!reads.has(k)) reads.set(k, readEntities(profileSlug));
    return reads.get(k)!;
  };

  const failed: Array<{ index: number; cellKey: string; reason: string }> = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const candidate of candidates) {
    const { embed, start, end, fallbackRange } = candidate;
    const cellKey = embed.ref.cellKey!;
    if (!isChartCellKey(cellKey)) continue;
    const props = embed.props!;
    const profileSlug =
      typeof props.profileSlug === "string" && props.profileSlug
        ? props.profileSlug
        : undefined;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await read(profileSlug);
    } catch (error) {
      failed.push({
        index: located.indexOf(candidate),
        cellKey,
        reason: reason(error),
      });
      continue;
    }
    const data = shapeChartEntities(cellKey, rows, props, now);
    edits.push({
      start,
      end,
      text: serializeEmbed({
        directive: embed.directive,
        ref: embed.ref,
        props: freezeChartProps(props, data, now),
        fallback: fallbackRange
          ? markdown.slice(fallbackRange.start, fallbackRange.end)
          : "",
      }),
    });
  }

  let out = markdown;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  // Lines are reported in the OUTPUT (the stored text): freezing an earlier
  // chart can change the line count above a later one. Edits never add or
  // remove an embed, so the i-th located embed is the same embed after them.
  const after = failed.length > 0 ? locateEmbeds(out) : [];
  const diagnostics: FreezeChartDiagnostic[] = failed.map(
    ({ index, cellKey, reason }) => ({
      code: "freeze_failed",
      severity: "warning",
      message: `Couldn’t snapshot this chart — it still reads live (its data could not be read: ${reason}).`,
      fix: GRAMMAR_FIX.freeze_failed,
      directive: "synap-cell",
      line: lineOf(out, after[index]!.start),
      ref: { cellKey },
    })
  );
  return { markdown: out, frozen: edits.length, diagnostics };
}
