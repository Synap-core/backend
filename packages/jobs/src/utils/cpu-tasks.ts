/**
 * The CPU pool's tasks (cpu-pool.ts), PURE: what runs in its worker thread
 * (cpu-worker.ts), and, for a tiny input, inline. The same function for both,
 * so the two paths cannot drift; the pool's parity test pins that the thread
 * hop (a structured clone each way) changes nothing.
 *
 * No database, no logger, no network: a worker imports only this.
 */

import {
  collectDiagnostics,
  type Diagnostic,
} from "@synap-core/markdown-core/diagnostics";
import {
  locateEmbeds,
  type LocatedEmbed,
} from "@synap-core/markdown-core/readable";
import {
  segmentPassages,
  type Passage,
} from "@synap-core/markdown-core/sections";
import { markdownToPlainText } from "@synap-core/markdown-core/plain-text";
import { buildAdjacency, pageRank, type Edge } from "./pagerank.js";

export type CpuTask =
  /** The content half of a document's diagnostics (api `diagnoseDocument`). */
  | { kind: "diagnose"; markdown: string }
  /** Recall passages with their prose (the document-passages worker). */
  | { kind: "passages"; markdown: string }
  /** Recall passages alone (the synthesis excerpt). */
  | { kind: "segment"; markdown: string }
  /** Global PageRank over one user's edges (the pagerank-centrality worker). */
  | { kind: "pagerank"; edges: Edge[] };

export interface DiagnoseResult {
  diagnostics: Diagnostic[];
  embeds: LocatedEmbed[];
}

export interface PassageWithProse {
  passage: Passage;
  /** The passage as plain text, trimmed (may be "": a passage with no prose). */
  prose: string;
}

export interface CpuTaskResult {
  diagnose: DiagnoseResult;
  passages: PassageWithProse[];
  segment: Passage[];
  /** `[entityId, score]` pairs: a Map does not cross the thread as itself. */
  pagerank: Array<[string, number]>;
}

export type CpuTaskOf<K extends CpuTask["kind"]> = Extract<
  CpuTask,
  { kind: K }
>;

/** The content half of a document's diagnostics. */
export function diagnoseTask(markdown: string): DiagnoseResult {
  return {
    diagnostics: collectDiagnostics(markdown),
    embeds: locateEmbeds(markdown),
  };
}

/** Recall passages, each with its prose. */
export function passagesTask(markdown: string): PassageWithProse[] {
  return segmentPassages(markdown).map((passage) => ({
    passage,
    prose: markdownToPlainText(passage.text).trim(),
  }));
}

/** Recall passages alone. */
export function segmentTask(markdown: string): Passage[] {
  return segmentPassages(markdown);
}

/** PageRank over `edges`, as pairs. */
export function pagerankTask(edges: Edge[]): Array<[string, number]> {
  return [...pageRank(buildAdjacency(edges))];
}

/**
 * One task, by kind: the worker's dispatch. The pool's inline path calls the
 * task's own function above, so a caller that never parses (PageRank) does
 * not reach the parser through this switch.
 */
export function runCpuTask(task: CpuTask): CpuTaskResult[CpuTask["kind"]] {
  switch (task.kind) {
    case "diagnose":
      return diagnoseTask(task.markdown);
    case "passages":
      return passagesTask(task.markdown);
    case "segment":
      return segmentTask(task.markdown);
    case "pagerank":
      return pagerankTask(task.edges);
  }
}
