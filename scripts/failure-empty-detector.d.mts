/** Types for failure-empty-detector.mjs — see that file for what it counts and what it cannot see. */

export interface FailureEmptySite {
  /** 1-based line of the `catch`. */
  line: number;
  kind: "catch-call" | "try-catch";
  /** The handler logs before it ends empty (still counted). */
  logged: boolean;
  /** Inside a react-query `queryFn` (the parse/storage filter does not apply). */
  queryFn: boolean;
  /** `// empty-ok: <reason>` sits on the line above the swallow itself (its
   * catch line, or the first line of its `.catch` call or `try`), and no
   * earlier site spent that marker: not counted. */
  justified: boolean;
}

export function findFailureEmptySites(
  fileName: string,
  text: string
): { sites: FailureEmptySite[]; emptyReasons: number[] };

export function countFailureEmpty(fileName: string, text: string): number;

export function listSourceFiles(roots: string[]): string[];

export function scanFailureEmpty(files: string[]): {
  counts: Map<string, number>;
  emptyReasons: string[];
  total: number;
};

export const SELF_CHECK: ReadonlyArray<{
  shape: string;
  n: number;
  src: string;
}>;
