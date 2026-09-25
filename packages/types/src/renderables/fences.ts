/**
 * Fence renderables — the catalog rows written as a fenced code block
 * (` ```<language> `) instead of a directive (plan §3: "content languages are
 * fences"). Widgets are always directives; these are the `form: "fence"` rows.
 *
 * A fence's source IS its content: there is no reference, no props block and no
 * fallback prose. Where a surface cannot draw one (relay, an export, a reader
 * whose renderer failed), it shows the SOURCE — monospace, never blank.
 *
 * There is deliberately no ` ```chart ` row: a chart is `synap-cell{chart-*}`,
 * and a second chart grammar would be a fork.
 *
 * Pure data. No React, no zod.
 */

import type { Placement } from "./content-kinds.js";
import type { RenderableForm } from "./types.js";

export const FENCE_RENDERABLE_KEYS = ["mermaid", "math", "code"] as const;
export type FenceRenderableKey = (typeof FENCE_RENDERABLE_KEYS)[number];

export interface FenceRenderableDef {
  key: FenceRenderableKey;
  form: Extract<RenderableForm, "fence">;
  name: string;
  description: string;
  /**
   * The info-string languages (lower-cased) that select this row. `code` has
   * none: it is the row for every other fence, highlighted when its language
   * is known and plain otherwise.
   */
  languages: readonly string[];
  placements: readonly Placement[];
  aiHint: string;
}

export const FENCE_RENDERABLES: readonly FenceRenderableDef[] = [
  {
    key: "mermaid",
    form: "fence",
    name: "Diagram",
    description:
      "A Mermaid diagram (flowchart, sequence, gantt, …) drawn from its source",
    languages: ["mermaid"],
    placements: ["inline"],
    aiHint:
      "Write a ```mermaid fence for a process, sequence or dependency diagram. Keep it small; relay and exports show the source.",
  },
  {
    key: "math",
    form: "fence",
    name: "Math",
    description: "A display equation typeset from LaTeX (KaTeX)",
    languages: ["math", "latex"],
    placements: ["inline"],
    aiHint:
      'Write a ```math fence holding LaTeX for a display equation. Inline $…$ math is off ("$5 and $10" stays prose).',
  },
  {
    key: "code",
    form: "fence",
    name: "Code",
    description: "A code block, syntax-highlighted when its language is known",
    languages: [],
    placements: ["inline"],
    aiHint: "Write a fenced code block with its language (```ts, ```sql, …).",
  },
];

export const FENCE_RENDERABLE_BY_KEY: Readonly<
  Record<FenceRenderableKey, FenceRenderableDef>
> = Object.fromEntries(
  FENCE_RENDERABLES.map((def) => [def.key, def])
) as Record<FenceRenderableKey, FenceRenderableDef>;

/**
 * The fence row that draws a fenced block with this info-string language.
 * `mermaid` / `math` / `latex` select their row (case-insensitive, first word
 * of the info string); anything else, including no language, is `code`.
 */
export function fenceRenderableFor(
  language: string | null | undefined
): FenceRenderableDef {
  const lang = (language ?? "").trim().split(/\s+/)[0]!.toLowerCase();
  if (lang) {
    for (const def of FENCE_RENDERABLES) {
      if (def.languages.includes(lang)) return def;
    }
  }
  return FENCE_RENDERABLE_BY_KEY.code;
}
