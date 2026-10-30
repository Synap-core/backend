/**
 * A ```mermaid fence drawn as a diagram — the pure half (catalog row
 * `mermaid`, form fence; the same rule as the desktop's `MermaidFence`).
 *
 * Inert by construction: mermaid runs with `securityLevel: "strict"` and SVG
 * text labels, and its SVG is never put in the page — `mermaid-fence.tsx`
 * shows it as `<img src=blob:>`, where scripts, links, event handlers and
 * outside loads cannot run.
 *
 * An `<img>` cannot read the page's CSS variables, so the console's HeroUI
 * colours are resolved when the diagram renders and handed to mermaid's
 * `base` theme as concrete values.
 */

import { fenceRenderableFor } from "@synap-core/types/renderables";

/** The fence's info string selects the diagram row (`mermaid`, any case). */
export function isMermaidFence(lang: string | null | undefined): boolean {
  return fenceRenderableFor(lang).key === "mermaid";
}

/** mermaid `base` themeVariable → the HeroUI colour it takes its value from. */
export const MERMAID_COLOR_TOKENS = {
  background: "content1",
  mainBkg: "content1",
  primaryColor: "content1",
  primaryBorderColor: "primary",
  nodeBorder: "primary",
  primaryTextColor: "foreground",
  textColor: "foreground",
  titleColor: "foreground",
  lineColor: "default-500",
  secondaryColor: "content2",
  tertiaryColor: "background",
  clusterBkg: "content2",
  clusterBorder: "divider",
  edgeLabelBackground: "content1",
} as const;

/** A HeroUI colour (`primary`, `content1`) as a value mermaid parses, or null. */
export type ColorReader = (heroColor: string) => string | null;

export function mermaidThemeVariables(
  read: ColorReader | null,
  dark: boolean
): Record<string, unknown> {
  const vars: Record<string, unknown> = { darkMode: dark };
  if (!read) return vars;
  for (const [slot, color] of Object.entries(MERMAID_COLOR_TOKENS)) {
    const value = read(color);
    if (value) vars[slot] = value;
  }
  return vars;
}

/** What `mermaid.initialize` gets. Strict, and labels as SVG text (no HTML). */
export function mermaidConfig(themeVariables: Record<string, unknown>) {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  } as const;
}

/** The image's words: what kind of diagram, from its first line. */
export function diagramAlt(source: string): string {
  const first = source.trim().split("\n")[0]?.trim() ?? "";
  return first ? `Diagram: ${first.slice(0, 80)}` : "Diagram";
}

/** A DOM id mermaid can render under, from React's `useId`. */
export function mermaidRenderId(reactId: string): string {
  return `pa-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
