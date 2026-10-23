/**
 * The words for a document embed — the vocabulary half of the shared embed
 * model (`describeEmbed`, `@synap-core/types/renderables`, which carries only
 * facts). Every surface that names an embed (the web console, relay, the
 * desktop) asks here, so "Card", "Kanban view" and "Weekly pulse" read the
 * same everywhere and no surface keeps its own noun table.
 *
 *   noun   what kind of thing it is ("Chart", "Entity", "View", "Card")
 *   label  what it is called: the authored label, else the catalog's name,
 *          else the humanized key or type, else the noun — never blank
 */

import type { EmbedModel } from "../renderables/embed-model.js";
import type { ChartGeometry } from "../renderables/chart-geometry.js";
import { humanizeToken, nounInSentence, resolveObjectNoun } from "./index.js";

export interface EmbedWords {
  noun: string;
  label: string;
}

/** The object kind whose noun names this embed. */
function nounKind(model: EmbedModel): string {
  switch (model.kind) {
    case "chart-snapshot":
    case "chart-broken":
    case "chart-live":
      return "chart";
    case "entity":
    case "view":
      return model.kind;
    case "cell-frame":
    case "cell-builtin":
      return "cell";
    case "broken":
    case "unknown":
      return model.directiveKind;
  }
}

export function resolveEmbedWords(model: EmbedModel): EmbedWords {
  const noun = resolveObjectNoun(nounKind(model));
  switch (model.kind) {
    case "chart-snapshot":
    case "chart-broken":
    case "chart-live":
      return { noun, label: model.label ?? humanizeToken(model.cellKey) };
    case "view":
      return {
        noun,
        label:
          model.label ??
          (model.viewType
            ? `${humanizeToken(model.viewType)} ${nounInSentence(noun)}`
            : noun),
      };
    case "cell-frame":
      return {
        noun,
        label:
          model.label ?? (model.keyName ? humanizeToken(model.keyName) : noun),
      };
    case "cell-builtin":
      return { noun, label: model.label };
    case "unknown":
      return {
        noun,
        label:
          model.label ?? (model.cellKey ? humanizeToken(model.cellKey) : noun),
      };
    case "entity":
      return { noun, label: model.label ?? noun };
    case "broken":
      return { noun, label: noun };
  }
}

// ── A drawn chart's words (the geometry carries only marks and numbers) ─────

/** How many values a chart's spoken label names before "and N more". */
export const CHART_SPOKEN_VALUES = 24;

/** How a value with no label is spoken. */
const NO_LABEL = "(no label)";

/**
 * What assistive tech hears for a drawn chart: its title, then each value
 * ("Open 3, Done 5, and 2 more"); for a ring, the number and its percent.
 * Null for a table (its caption is the title and its cells speak) and for an
 * empty snapshot (the surface says it holds no values).
 */
export function resolveChartSpokenLabel(
  title: string,
  geometry: ChartGeometry
): string | null {
  switch (geometry.kind) {
    case "bars":
    case "line": {
      const parts = geometry.values.map(
        (v) => `${v.name ?? NO_LABEL} ${v.value}`
      );
      const named = parts.slice(0, CHART_SPOKEN_VALUES).join(", ");
      const rest = parts.length - CHART_SPOKEN_VALUES;
      return `${title}: ${named}${rest > 0 ? `, and ${rest} more` : ""}`;
    }
    case "ring":
      return `${title}: ${geometry.valueText} (${geometry.percentRounded}%)`;
    case "table":
    case "empty":
      return null;
  }
}

const CHART_TABLE_HEAD: Record<
  Extract<ChartGeometry, { kind: "table" }>["shape"],
  string[]
> = {
  composed: ["Bucket", "Bar", "Line"],
  points: ["Label", "x", "y"],
  flow: ["From", "To", "Value"],
  regions: ["Region", "Value"],
};

/** The column headings of a chart drawn as a table, in the geometry's column order. */
export function resolveChartTableHead(
  shape: Extract<ChartGeometry, { kind: "table" }>["shape"]
): string[] {
  return CHART_TABLE_HEAD[shape];
}
