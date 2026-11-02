/**
 * The rules a person set from a request — "Approve and always allow…" (an
 * `auto` row) and "Reject and never allow…" (a `deny` row) — as Settings
 * lists them, so each one has a place to be read and taken back. Both menus
 * stamp `sourceProposalId`; the settings mirrors and the posture rows never
 * do, so that stamp is what makes a row the person's own answer. The
 * hand-off switch above already shows an "always" hand-off. Pure.
 */
import {
  buildObjectActionTitle,
  humanizeToken,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import {
  isHandOffRule,
  type RuleRow,
} from "../../../review/_lib/hand-off-rule";

export interface RequestRuleRow extends RuleRow {
  sourceProposalId?: string | null;
  targetProfile?: string | null;
}

export interface RequestRule {
  id: string;
  /** The AI the rule is about. */
  agent: string;
  verdict: "auto" | "deny";
  /** What it covers: a tool, a change, or a kind of record. */
  what: string;
}

export function requestRules(rows: readonly RequestRuleRow[]): RequestRule[] {
  const out: RequestRule[] = [];
  for (const r of rows) {
    if (r.principalKind !== "agent" || !r.agentUserId) continue;
    if (!r.sourceProposalId) continue;
    if (r.verdict !== "auto" && r.verdict !== "deny") continue;
    if (isHandOffRule(r)) continue;
    out.push({
      id: r.id,
      agent: r.agentLabel || resolveObjectNoun("agent"),
      verdict: r.verdict,
      what: ruleTarget(r),
    });
  }
  return out;
}

/** A rule's target in the vocabulary's words, never a raw key. */
export function ruleTarget(r: RequestRuleRow): string {
  if (r.targetKind === "capability") return r.targetPattern;
  if (r.targetKind === "profile")
    return resolveObjectNoun(r.targetProfile ?? r.targetPattern);
  if (r.targetKind === "action") {
    const dot = r.targetPattern.indexOf(".");
    if (dot > 0)
      return buildObjectActionTitle({
        objectKind: r.targetPattern.slice(0, dot),
        action: r.targetPattern.slice(dot + 1),
      });
  }
  return humanizeToken(r.targetPattern);
}
