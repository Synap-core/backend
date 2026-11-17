/**
 * The pure half of the rules the POD applies (decision D8: the person sees one
 * "Rules" list): the built-in rules and the roll-ups a relation declares, read
 * by `skills.listReactionRules`, drawn in the SAME list as the automations,
 * with the same filters, pill and one act.
 *
 * A pod rule is shaped as a rule row (`RuleFacts` + `RuleHealth`) so the
 * list's one set of predicates (`rule-rows.ts`) decides it like any other:
 * on = active, paused = paused; its recent outcomes stand in for runs (each
 * outcome is the rule acting on one move), a failed one for a failure. Its
 * act is only Pause or Turn on: a pod rule fires on a move, never on "Run now".
 */

import { formatRelative } from "../../../../lib/format";
import type { RuleFacts, RuleHealth } from "./rule-rows";

/** One outcome as `skills.listReactionRules` returns it (newest first). */
export interface ReactionOutcomeWire {
  outcome: "applied" | "proposed" | "skipped";
  code: string;
  reason: string;
  at: string;
  source?: string;
  target: string | null;
  to: string | null;
  proposalId?: string | null;
}

/** One pod rule as `skills.listReactionRules` returns it. */
export interface ReactionRuleWire {
  id: string;
  title: string;
  when: string;
  via: string;
  do: string;
  enabled: boolean;
  source: "built_in" | "declared";
  chains: boolean;
  terminal: "propose" | "apply";
  terminalWhy: string | null;
  ruleId: string | null;
  owner: { userId: string; name: string | null } | null;
  recent: ReactionOutcomeWire[];
  declaredOn: {
    relationName: string;
    source: { name: string };
    target: { name: string };
    workspaceId: string | null;
  } | null;
}

/** The ids the pod's rules carry (a built-in, or a relation's roll-up). */
export function isReactionRuleId(id: string): boolean {
  return id.startsWith("builtin:") || id.startsWith("declared:");
}

/** A pod rule as a rule row: what the list's predicates read. */
export function reactionRuleFacts(r: ReactionRuleWire): RuleFacts & {
  workspaceId: string | null;
} {
  return {
    id: r.id,
    name: r.title,
    status: r.enabled ? "active" : "paused",
    triggerType: "reaction",
    lastRunAt: r.recent[0]?.at ?? null,
    runCount: r.recent.length,
    failureCount: r.recent.filter((o) => o.code === "failed").length,
    workspaceId: r.declaredOn?.workspaceId ?? null,
  };
}

/** Its health, from what it did lately (a failed write = a failure). */
export function reactionRuleHealth(r: ReactionRuleWire): RuleHealth {
  return {
    latestStatus: r.recent[0]?.code === "failed" ? "failed" : "completed",
    recentFailedCount: r.recent.filter((o) => o.code === "failed").length,
  };
}

/** Its one act: pause a rule that is on, turn on a paused one. */
export function reactionRuleAction(r: ReactionRuleWire): "pause" | "turn_on" {
  return r.enabled ? "pause" : "turn_on";
}

/** "2 applied · 1 skipped lately", or "Nothing lately". */
export function reactionActivityPhrase(r: ReactionRuleWire): string {
  if (r.recent.length === 0) return "Nothing lately";
  const n = (o: ReactionOutcomeWire["outcome"]) =>
    r.recent.filter((x) => x.outcome === o).length;
  const parts = [
    n("applied") ? `${n("applied")} applied` : null,
    n("proposed") ? `${n("proposed")} proposed` : null,
    n("skipped") ? `${n("skipped")} skipped` : null,
  ].filter(Boolean);
  return `${parts.join(" · ")} lately`;
}

/** Who declared it, in words. */
export function reactionOriginLine(r: ReactionRuleWire): string {
  if (!r.declaredOn) return "Built into the pod";
  const d = r.declaredOn;
  return `Declared on the link “${d.source.name} ${d.relationName.toLowerCase()} ${d.target.name}”`;
}

/** What a move into done or lost does, in words (decision D3). */
export function reactionTerminalLine(r: ReactionRuleWire): string {
  return r.terminal === "apply"
    ? `Moves into done or lost are applied${r.terminalWhy ? `: ${r.terminalWhy}` : "."}`
    : "Moves into done or lost wait for your review.";
}

/** One history line: what it did, when, and why when it skipped. */
export function reactionOutcomeLine(o: ReactionOutcomeWire): {
  label: string;
  tone: "healthy" | "stale" | "down" | "unknown";
  detail: string;
  when: string;
} {
  const when = formatRelative(o.at, { empty: "at an unknown time" });
  switch (o.outcome) {
    case "applied":
      return { label: "Applied", tone: "healthy", detail: o.reason, when };
    case "proposed":
      return {
        label: "Proposed",
        tone: "stale",
        detail: "Waiting for your review.",
        when,
      };
    case "skipped":
      return {
        label: o.code === "failed" ? "Failed" : "Skipped",
        tone: o.code === "failed" ? "down" : "unknown",
        detail: o.reason,
        when,
      };
  }
}
