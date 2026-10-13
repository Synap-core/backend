/**
 * The pure half of `/rules`: which filter a rule falls in, how it reads as a
 * row, and the one act its row offers. The page only fetches and draws.
 *
 * A rule's HEALTH joins two reads: the `automations` row (status, lifetime
 * counters, `lastRunAt`) and its `runs.groups` row (the latest run's status and
 * `recentFailedCount`, the W2-calm "failing now" number). The counters on the
 * rule are lifetime; a rule that failed 271 times in June and ran clean since
 * is not failing — so "failing" reads the group, never `failureCount`.
 */

import type { StatusKind } from "../../components/status-pill";

export const RULE_FILTERS = [
  { key: "active", label: "Active" },
  { key: "failing", label: "Failing" },
  { key: "never-ran", label: "Never ran" },
  { key: "paused", label: "Paused" },
  { key: "drafts", label: "Drafts" },
] as const;

export type RuleFilter = (typeof RULE_FILTERS)[number]["key"];

/** `?filter=` → a filter; anything unknown is the default (Active). */
export function ruleFilterOf(raw: string | null | undefined): RuleFilter {
  return RULE_FILTERS.find((f) => f.key === raw)?.key ?? "active";
}

/** The `automations` columns a row reads. */
export interface RuleFacts {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  lastRunAt?: Date | string | null;
  runCount: number;
  failureCount: number;
}

/** The `runs.groups` columns a row reads (one group per automation). */
export interface RuleHealth {
  latestStatus: string;
  recentFailedCount: number;
}

/**
 * Never ran — the SAME predicate diagnose's `schema_hygiene` counts
 * (`services/diagnose/schema-hygiene.ts`: status active|draft, runCount 0,
 * lastRunAt null), so Home's "rule never ran" link lands on a list that holds
 * the rule it named.
 */
export function ruleNeverRan(rule: RuleFacts): boolean {
  return (
    (rule.status === "active" || rule.status === "draft") &&
    rule.runCount === 0 &&
    !rule.lastRunAt
  );
}

/** Stopped on an error, or a live rule whose runs failed this week. */
export function ruleIsFailing(
  rule: RuleFacts,
  health: RuleHealth | undefined
): boolean {
  if (rule.status === "error") return true;
  return rule.status === "active" && (health?.recentFailedCount ?? 0) > 0;
}

export function ruleMatches(
  filter: RuleFilter,
  rule: RuleFacts,
  health: RuleHealth | undefined
): boolean {
  switch (filter) {
    case "active":
      return rule.status === "active";
    case "failing":
      return ruleIsFailing(rule, health);
    case "never-ran":
      return ruleNeverRan(rule);
    case "paused":
      return rule.status === "paused";
    case "drafts":
      return rule.status === "draft";
  }
}

export function ruleCounts(
  rules: readonly RuleFacts[],
  healthOf: (id: string) => RuleHealth | undefined
): Record<RuleFilter, number> {
  const counts: Record<RuleFilter, number> = {
    active: 0,
    failing: 0,
    "never-ran": 0,
    paused: 0,
    drafts: 0,
  };
  for (const rule of rules) {
    const health = healthOf(rule.id);
    for (const { key } of RULE_FILTERS) {
      if (ruleMatches(key, rule, health)) counts[key] += 1;
    }
  }
  return counts;
}

/** The row's pill: how the rule is doing, in two or three words. */
export function rulePill(
  rule: RuleFacts,
  health: RuleHealth | undefined
): { kind: StatusKind; label: string } {
  switch (rule.status) {
    case "error":
      return { kind: "down", label: "Stopped on error" };
    case "paused":
      return { kind: "unknown", label: "Paused" };
    case "draft":
      return { kind: "unknown", label: "Draft" };
    case "archived":
      return { kind: "unknown", label: "Archived" };
  }
  if (ruleNeverRan(rule)) return { kind: "unknown", label: "Never ran" };
  if (health?.latestStatus === "failed") {
    return { kind: "down", label: "Failed last run" };
  }
  const recent = health?.recentFailedCount ?? 0;
  if (recent > 0) {
    return {
      kind: "stale",
      label: `${recent} ${recent === 1 ? "failure" : "failures"}`,
    };
  }
  return { kind: "healthy", label: "Working" };
}

export type RuleRowAction = "pause" | "run" | null;

/**
 * The ONE act a row offers. A failing rule offers "Run now" — the question in
 * front of the owner is "does it work again?" — but only when the pod would
 * accept the run (`automations.trigger` refuses paused/error rules unless the
 * rule is manual). Any other live rule offers Pause, the de-escalation that
 * never waits for review. Nothing else is decided from a list.
 */
export function ruleRowAction(
  rule: RuleFacts,
  health: RuleHealth | undefined
): RuleRowAction {
  const runnable =
    rule.status === "active" ||
    rule.status === "draft" ||
    (rule.triggerType === "manual" && rule.status !== "archived");
  if (ruleIsFailing(rule, health) && runnable) return "run";
  if (rule.status === "active") return "pause";
  return null;
}

/** "418 runs · 2 failed" — lifetime counters, said once. */
export function runsPhrase(rule: RuleFacts): string {
  if (rule.runCount === 0) return "No runs yet";
  const runs = `${rule.runCount.toLocaleString("en-US")} ${rule.runCount === 1 ? "run" : "runs"}`;
  return rule.failureCount > 0
    ? `${runs} · ${rule.failureCount.toLocaleString("en-US")} failed`
    : runs;
}

/**
 * The "never ran" callout: how many, why that usually is, and the names that
 * repeat most — duplicates are the usual cause ("Generate report" ×11).
 */
export function neverRanCallout(rules: readonly RuleFacts[]): string | null {
  const idle = rules.filter(ruleNeverRan);
  if (idle.length === 0) return null;
  const byName = new Map<string, number>();
  for (const rule of idle) {
    byName.set(rule.name, (byName.get(rule.name) ?? 0) + 1);
  }
  const top = [...byName.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, n]) => (n > 1 ? `“${name}” ×${n}` : `“${name}”`));
  const head =
    idle.length === 1
      ? "1 rule has never run."
      : `${idle.length} rules have never run.`;
  return `${head} Their trigger has not happened yet, or points at something that no longer exists — e.g. ${top.join(", ")}.`;
}

/** What a manual run came back as, said honestly (`automations.trigger`). */
export function runResultMessage(
  name: string,
  result: { status: "triggered" | "proposed" }
): string {
  return result.status === "proposed"
    ? `Running “${name}” was proposed for review — it starts once someone approves it.`
    : `“${name}” started a run.`;
}
