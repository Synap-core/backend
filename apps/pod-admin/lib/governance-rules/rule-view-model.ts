/**
 * Pure view-model helpers for `governance_rules` rows — humanizing
 * principal/scope/target/provenance for display.
 *
 * Framework-agnostic on purpose (no React/HeroUI/trpc imports): this is the
 * extraction the founder asked for so a second UI stack (the browser
 * Settings panel, a different trpc client + component library entirely) can
 * mirror the same derivation without depending on pod-admin's components.
 * pod-admin and browser are separate pnpm workspaces (browser's root
 * workspace does not include synap-backend/apps/*), so this file isn't
 * literally imported across the repo boundary today — copy it verbatim if
 * you wire the browser side, and keep the two in sync by hand until a real
 * shared package is worth the cross-repo plumbing.
 *
 * Mirrors the granularity vocabulary documented in the header of
 * `packages/api/src/routers/governance-rules.ts` — keep the two in sync if
 * a new targetKind/principalKind is ever added there.
 */

export interface GovernanceRuleRow {
  id: string;
  principalKind: "agent" | "any";
  agentUserId: string | null;
  agentLabel: string | null;
  scopeKind: "workspace" | "pod";
  workspaceId: string | null;
  targetKind: "action" | "profile" | "capability";
  targetPattern: string;
  targetProfile: string | null;
  verdict: "auto" | "propose";
  createdAt: string | Date;
  createdBy: string | null;
  sourceProposalId: string | null;
  expiresAt: string | Date | null;
}

export function humanizePrincipal(rule: GovernanceRuleRow): string {
  if (rule.principalKind === "agent") {
    return rule.agentLabel ?? "an agent";
  }
  return "Any agent";
}

export function humanizeScope(
  rule: GovernanceRuleRow,
  workspaceName?: string
): string {
  if (rule.scopeKind === "pod") return "Pod-wide";
  return workspaceName ?? "This workspace";
}

/** targetKind → a readable description of what the rule matches. */
export function humanizeTarget(rule: GovernanceRuleRow): string {
  if (rule.targetKind === "capability") {
    return `Capability "${rule.targetPattern}"`;
  }
  if (rule.targetKind === "profile") {
    return `Everything of type "${rule.targetProfile ?? "?"}"`;
  }
  // targetKind === "action"
  return rule.targetPattern === "*"
    ? "Every action"
    : `Action "${rule.targetPattern}"`;
}

export type RuleProvenance = "settings" | "proposal";

/**
 * `sourceProposalId` is a clean binary: NULL = authored directly in
 * Settings (the JSONB form's `syncAutoApproveRules` mirror or a manual
 * `create` call), non-NULL = authored by approving a proposal via "Approve
 * & always…". No new plumbing — this predicate is already correct on the
 * stored column.
 */
export function ruleProvenance(rule: GovernanceRuleRow): RuleProvenance {
  return rule.sourceProposalId ? "proposal" : "settings";
}

export function provenanceLabel(rule: GovernanceRuleRow): string {
  return ruleProvenance(rule) === "proposal"
    ? "From a proposal"
    : "From settings";
}

export function verdictLabel(rule: GovernanceRuleRow): string {
  return rule.verdict === "auto" ? "Auto-approve" : "Require proposal";
}
