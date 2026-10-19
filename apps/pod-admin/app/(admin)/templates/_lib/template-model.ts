/**
 * The pure half of `/templates` (playbooks): its one-sentence summary, its executor in words, its
 * runs this week, and the "why is it failing?" read over its recent runs.
 * The pages only fetch and draw.
 */

import { oneLine } from "../../../../lib/format";
import { isRecentFailure } from "@synap-core/types/run-activity";

const SUMMARY_MAX = 200;

/** `@{arg:topic}` and `{topic}` — a goal's references, read as their names. */
const ARG_REF = /@\{arg:([^}]+)\}|\{([A-Za-z_][\w.-]*)\}/g;

/**
 * One sentence on what the template does: its description when it has one,
 * else its goal template with each reference read as ‹name›. First sentence
 * only, bounded — the summary line is not the place for the whole brief.
 */
export function templateSummary(
  description: string | null | undefined,
  goalTemplate: string | null | undefined
): string | null {
  const source = description?.trim() || goalTemplate?.trim();
  if (!source) return null;
  const text = withArgNames(source).replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return oneLine(sentence, SUMMARY_MAX);
}

/** Each goal reference read as its name (‹topic›). */
function withArgNames(text: string): string {
  return text.replace(
    ARG_REF,
    (_m, arg?: string, bare?: string) => `‹${(arg ?? bare ?? "").trim()}›`
  );
}

/**
 * The whole description, to read in full (markdown) — or null when the
 * summary line already says all of it.
 */
export function templateDescription(
  description: string | null | undefined
): string | null {
  const source = description?.trim();
  if (!source) return null;
  const full = withArgNames(source);
  const flat = full.replace(/\s+/g, " ").trim();
  return flat === templateSummary(source, null) ? null : full;
}

/** Who carries out a run (`playbooks.executor`). */
export function executorLabel(executor: string | null | undefined): string {
  switch (executor) {
    case "is-agent":
      return "Synap’s agent";
    case "external-agent":
      return "A connected agent";
    case "hybrid":
      return "Synap’s agent with a connected one";
    default:
      return "—";
  }
}

/** The `UnifiedRun` columns the week count and explanation read. */
export interface TemplateRunFacts {
  id: string;
  status: string;
  startedAt: Date | string | null;
  completedAt?: Date | string | null;
  error?: string | null;
}

/**
 * Runs this week and how many failed, over the newest runs read. `atLeast`
 * when every run read is inside the week — the read was the limit, not the
 * week, so the true count may be higher.
 */
export function runsThisWeek(
  runs: readonly TemplateRunFacts[],
  now: Date,
  readLimit: number
): { total: number; failed: number; atLeast: boolean } {
  const nowMs = now.getTime();
  const inWeek = runs.filter(
    (r) =>
      r.startedAt !== null &&
      isRecentFailure(
        { startedAt: r.startedAt, completedAt: r.completedAt },
        nowMs
      )
  );
  return {
    total: inWeek.length,
    failed: inWeek.filter((r) => r.status === "failed").length,
    atLeast: runs.length >= readLimit && inWeek.length === runs.length,
  };
}

/** Stage names in order (`playbooks.stages`: `{ key, name? }[]`). */
export function stageNames(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages.flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const { name, key } = s as { name?: unknown; key?: unknown };
    const label =
      typeof name === "string" && name.trim()
        ? name.trim()
        : typeof key === "string" && key.trim()
          ? key.trim()
          : null;
    return label ? [label] : [];
  });
}

/** A run error on one line, for a list or a sentence. */
export function errorLine(error: string | null | undefined): string | null {
  return error?.trim() ? oneLine(error, 160) : null;
}

/**
 * "Why is it failing?" from the runs themselves: how many of the recent runs
 * failed, and the error they share (or the latest one). The pod has no
 * tRPC door that explains a template by id — MCP `diagnose({id})` answers a
 * playbook with `why: null` and a run with the same `runs.get` detail this
 * page reads — so this is the honest equivalent, not a guess.
 */
export function failureExplanation(runs: readonly TemplateRunFacts[]): {
  sentence: string;
  latestFailedRunId: string;
} | null {
  const failed = runs.filter((r) => r.status === "failed");
  const latest = failed[0];
  if (!latest) return null;
  const head = `${failed.length} of the last ${runs.length} ${runs.length === 1 ? "run" : "runs"} failed.`;
  const counts = new Map<string, number>();
  for (const r of failed) {
    const line = errorLine(r.error);
    if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const [common, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [
    null,
    0,
  ];
  if (common && n > 1) {
    return {
      sentence: `${head} ${n} of them stopped with the same error: “${common}”`,
      latestFailedRunId: latest.id,
    };
  }
  const latestLine = errorLine(latest.error);
  return {
    sentence: latestLine
      ? `${head} The latest stopped with: “${latestLine}”`
      : `${head} The latest failed without recording why — open it to see how far it got.`,
    latestFailedRunId: latest.id,
  };
}
