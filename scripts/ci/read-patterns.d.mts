/** Types for read-patterns.mjs — see that file for what each pattern is. */

export type ReadPattern =
  "events-unbounded" | "key-cast-to-text" | "proposal-data-whole";

export const PATTERNS: readonly ReadPattern[];
export const MARKER: string;

export interface ReadPatternSite {
  pattern: ReadPattern;
  line: number;
  what: string;
  justified: boolean;
  reason: string | null;
}

export function listScannedFiles(repoRoot: string): string[];
export function mayHoldSite(text: string): boolean;
export function findReadPatternSites(
  fileName: string,
  text: string
): {
  sites: ReadPatternSite[];
  emptyMarkers: number[];
  unusedMarkers: number[];
};
export function scanReadPatterns(
  files: string[],
  keyOf: (abs: string) => string
): {
  counts: Record<ReadPattern, Record<string, number>>;
  justified: string[];
  emptyMarkers: string[];
  unusedMarkers: string[];
};
