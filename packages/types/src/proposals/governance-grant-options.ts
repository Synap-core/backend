/**
 * Governance grant-option derivation — "always approve for…" menu.
 *
 * A per-proposal escape hatch that turns a one-off approval decision into a
 * standing `governance_rules` row (Governance Convergence Plan, Phase A — see
 * `docs/decisions/agent-governance.md`). Given the handful of
 * fields a proposal can resolve (a capability target, an action event key, a
 * profile slug, an authoring agent), this computes WHICH of the five
 * granularities — capability / action / profile / agent / global — are
 * offerable and the exact `governanceRules.create` payload each one writes.
 *
 * Pure, no UI/runtime dependencies — safe to import from any frontend
 * (browser, Electron, Next.js) or server context. This is the SINGLE SOURCE
 * for the derivation: `synap-app`'s `GovernanceMenu` (end-user "Always
 * approve for…") and `pod-admin`'s `AlwaysApproveMenu` ("Approve & always…")
 * both call it — see those files for the two `GovernanceGrantMode`s they use.
 */

/** The exact `governanceRules.create` input shape (see
 * `packages/api/src/routers/governance-rules.ts`'s `CreateInputSchema`). */
export interface GovernanceRuleDraft {
  principalKind: "any" | "agent";
  agentUserId?: string;
  scopeKind: "workspace" | "pod";
  workspaceId?: string;
  // Deliberately NOT `connection`: this menu offers widening for an agent's
  // proposal. A connection rule is minted only by approving a connection's sync
  // import (or the keep-syncing toggle), never from this menu.
  targetKind: "action" | "profile" | "capability";
  targetPattern: string;
  targetProfile?: string;
  verdict: "auto";
  sourceProposalId: string;
}

/** The proposal fields this derivation needs, already resolved by the
 * caller from whatever proposal shape it has on hand (a `UniversalProposal`
 * with review events, or a raw tRPC row) — resolving those fields from a
 * specific proposal shape stays the caller's job; this function only decides
 * what to offer once they're known. */
export interface GovernanceGrantContext {
  proposalId: string;
  workspaceId?: string | null;
  agentUserId?: string | null;
  /** `data.verbId ?? data.skillId ?? data.capabilityId` — whichever field a
   * `capability.run` proposal actually carries (gate paths vary). */
  capabilityTarget?: string | null;
  /** `"<subjectType>.<action>"` off the proposal's requested event. */
  actionKey?: string | null;
  /** The entity/facet profile slug this proposal targets. */
  profileSlug?: string | null;
  /** The proposal's stored `governance_reason` (the engine's reason code).
   * When it names a non-widenable floor, a rule scoped to exactly this
   * proposal's action can never fire, so that option is not offered. A human
   * proposal carries none; `governanceRules.create` refuses the dead rule
   * server-side for that case. */
  governanceReason?: string | null;
}

/**
 * Governance reason codes of the floors NO rule can widen: the codes
 * `nonWidenableFloorFor` (`@synap/governance-policy`) can return. This package
 * cannot import the engine, so the set is MIRRORED under a tripwire —
 * `governance-policy/src/non-widenable-floor.test.ts` derives it from the
 * engine and fails when this list drifts.
 */
export const NON_WIDENABLE_GOVERNANCE_REASONS = [
  "ADMIN",
  "HUMAN_GATE",
  "ARBITRARY_EXECUTION",
  "AGENT_SCHEMA_DEFINITION",
  "AGENT_STRUCTURE_WRITE",
  "DESTRUCTIVE_HARD_FLOOR",
] as const;

/** Did the engine route this proposal to review through a floor no
 * governance rule can widen? */
export function isNonWidenableGovernanceReason(
  code: string | null | undefined
): boolean {
  return (
    !!code &&
    (NON_WIDENABLE_GOVERNANCE_REASONS as readonly string[]).includes(code)
  );
}

/**
 * Capability verb ids a stored `auto` rule never widens to a direct run: a
 * public post stays a person's yes. The ONE list: the capability gate reads
 * it through `@synap/governance-policy`'s re-export and refuses such a rule
 * (`capabilityRuleAuthorizesRun`), and no "always" menu offers one, since a
 * rule that never fires would tell the person the next post goes without
 * asking. Gmail and every other send stay off the list.
 */
export const PROPOSE_ONLY_CAPABILITY_VERBS = [
  "postiz_draft",
  "postiz_schedule",
  "postiz_publish",
  // The code verb that uploads media then creates the post (draft | schedule |
  // now) — the same public send as the three above. `postiz_upload_from_url`
  // is deliberately NOT here: it stores a file in the Postiz media library and
  // publishes nothing, so a person may widen it like any other write.
  "postiz_schedule_post",
] as const;

export function capabilityVerbAllowsRuleWiden(
  verbName: string | null | undefined
): boolean {
  if (!verbName) return true;
  return !(PROPOSE_ONLY_CAPABILITY_VERBS as readonly string[]).includes(
    verbName
  );
}

/**
 * The two menus that consume this derivation offer it with deliberately
 * different reach — an intentional, not-yet-reconciled divergence between
 * the end-user and operator surfaces:
 *
 * - `"agent-scoped"` (synap-app `GovernanceMenu`, per-row on a proposal list
 *   the acting user may not administer): "this action"/"this type" are only
 *   offered when the proposal is agent-authored, and scope to that agent
 *   (`principalKind: "agent"`) rather than every principal. "This agent" is
 *   a wildcard action grant (`targetPattern: "*"`) requiring only that an
 *   agent authored the proposal.
 * - `"operator-any"` (pod-admin `AlwaysApproveMenu`, a pod-admin-only ops
 *   tool): "this action"/"this type" are offered for ANY proposal
 *   (`principalKind: "any"`), agent-authored or not — an operator can widen
 *   regardless of who filed it. "This agent" additionally requires an
 *   action key and scopes to that exact action, never a wildcard, and there
 *   is no "globally": this mode writes no wildcard rule at all.
 */
export type GovernanceGrantMode = "agent-scoped" | "operator-any";

export interface GovernanceGrantOption {
  id: "capability" | "action" | "profile" | "agent" | "global";
  /** The resolved value the option's label should interpolate (verbId,
   * action key, or profile slug) — label copy stays the caller's concern
   * (the two menus intentionally word these differently). */
  value?: string;
  rule: GovernanceRuleDraft;
}

/** Resolve a `capability.run` proposal's capability target from its raw
 * `request.data` payload. Prefers `verbId` (what `gateCapabilityExecution`
 * matches on), falls back to `skillId`, then the older `capabilityId` shape
 * some gate paths still store — so the stored rule is byte-identical to
 * what the gate resolves. */
export function resolveCapabilityTarget(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  for (const key of ["verbId", "skillId", "capabilityId"]) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function deriveGovernanceGrantOptions(
  ctx: GovernanceGrantContext,
  mode: GovernanceGrantMode = "agent-scoped"
): GovernanceGrantOption[] {
  const opts: GovernanceGrantOption[] = [];
  const workspaceId = ctx.workspaceId ?? undefined;
  const agentUserId = ctx.agentUserId ?? undefined;
  const scopeKind: "workspace" | "pod" = workspaceId ? "workspace" : "pod";
  const isOperator = mode === "operator-any";
  // A rule scoped to EXACTLY this proposal's action sits below a floor that
  // already routed it to review, so it could never fire. Wildcard options
  // ("this agent" in agent-scoped mode, "globally") still widen other actions.
  // A capability run is widened only by a rule naming that capability (the
  // outward floor in `resolveGovernanceRule`, @synap/database): an action rule
  // `capability.run` would cover every capability, so it never fires.
  const actionFloored =
    isNonWidenableGovernanceReason(ctx.governanceReason) ||
    ctx.actionKey === "capability.run";

  // "This capability" — always principalKind:"any" in both menus. Not for a
  // verb no rule widens (a public post), nor under a floor no rule widens:
  // that rule would never fire.
  if (
    ctx.capabilityTarget &&
    capabilityVerbAllowsRuleWiden(ctx.capabilityTarget) &&
    !isNonWidenableGovernanceReason(ctx.governanceReason)
  ) {
    opts.push({
      id: "capability",
      value: ctx.capabilityTarget,
      rule: {
        principalKind: "any",
        scopeKind,
        workspaceId,
        targetKind: "capability",
        targetPattern: ctx.capabilityTarget,
        verdict: "auto",
        sourceProposalId: ctx.proposalId,
      },
    });
  }

  // "This action type" — operator mode offers it for any proposal;
  // agent-scoped mode only when the proposal is agent-authored, and scopes
  // the rule to that agent rather than every principal.
  const offerAction =
    !actionFloored &&
    (isOperator ? !!ctx.actionKey : !!(ctx.actionKey && agentUserId));
  if (offerAction) {
    opts.push({
      id: "action",
      value: ctx.actionKey!,
      rule: {
        principalKind: isOperator ? "any" : "agent",
        ...(isOperator ? {} : { agentUserId }),
        scopeKind,
        workspaceId,
        targetKind: "action",
        targetPattern: ctx.actionKey!,
        verdict: "auto",
        sourceProposalId: ctx.proposalId,
      },
    });
  }

  // "This type" — same agent-scoped-vs-any split as "this action".
  const offerProfile = isOperator
    ? !!ctx.profileSlug
    : !!(ctx.profileSlug && agentUserId);
  if (offerProfile) {
    opts.push({
      id: "profile",
      value: ctx.profileSlug!,
      rule: {
        principalKind: isOperator ? "any" : "agent",
        ...(isOperator ? {} : { agentUserId }),
        scopeKind,
        workspaceId,
        targetKind: "profile",
        targetPattern: "*",
        targetProfile: ctx.profileSlug!,
        verdict: "auto",
        sourceProposalId: ctx.proposalId,
      },
    });
  }

  // "This agent" — agent-scoped mode offers a wildcard action grant whenever
  // an agent authored the proposal; operator mode additionally requires an
  // action key and scopes the rule to that exact action (never a wildcard).
  if (
    isOperator
      ? !!(agentUserId && ctx.actionKey) && !actionFloored
      : !!agentUserId
  ) {
    opts.push({
      id: "agent",
      rule: {
        principalKind: "agent",
        agentUserId: agentUserId!,
        scopeKind,
        workspaceId,
        targetKind: "action",
        targetPattern: isOperator ? ctx.actionKey! : "*",
        verdict: "auto",
        sourceProposalId: ctx.proposalId,
      },
    });
  }

  // "Globally" — agent-scoped mode only; server-side `assertCanManageRule`
  // gates it to pod admins, so a non-admin sees the option and gets a clear
  // FORBIDDEN toast rather than a silently hidden capability. Pod admin does
  // not offer it (finding c173cc51): one click should not let every agent
  // make every change in the pod. Sending and grants stay asked either way
  // (the outward floor), and deletes, members and keys sit under floors.
  if (isOperator) return opts;
  opts.push({
    id: "global",
    rule: {
      principalKind: "any",
      scopeKind: "pod",
      targetKind: "action",
      targetPattern: "*",
      verdict: "auto",
      sourceProposalId: ctx.proposalId,
    },
  });

  return opts;
}

/** The `governanceRules.create` input a request's "Never" writes: always ONE
 * agent and ONE named act, so the types cannot express a wildcard principal. */
export interface GovernanceDenyDraft {
  principalKind: "agent";
  agentUserId: string;
  scopeKind: "pod";
  targetKind: "action" | "capability";
  targetPattern: string;
  verdict: "deny";
  sourceProposalId: string;
}

export interface GovernanceNeverOption {
  id: "never";
  /** The capability or action key the deny names (label interpolation). */
  value: string;
  rule: GovernanceDenyDraft;
}

/**
 * "Never" on a request (founder, audit 110dd4ab G3, 30 Oct 2026): reject it AND
 * store a `deny` rule, so the pod refuses this agent's same act from then on
 * with `DENIED_BY_RULE` (decision 956930ad: above the floors, so it is offered
 * on a floored request too). Narrow by construction: this agent only, and the
 * capability a run names, else the exact action key. Null when the request
 * names no agent (a person is never refused) or no single act: a wildcard or
 * glob action, or a capability run with no capability, whose action key
 * `capability.run` would refuse every tool. A broad deny stays possible
 * through `governanceRules.create`; this option never writes one.
 *
 * Pod-wide, whatever space the request was filed in: the words promise "this
 * AI can no longer use this tool", and a space-scoped deny would let the same
 * agent run the same act from another space (the resolver reads a space rule
 * only for a run in that space). Refusing more is always safe.
 */
export function deriveGovernanceNeverOption(
  ctx: GovernanceGrantContext
): GovernanceNeverOption | null {
  const agentUserId = ctx.agentUserId ?? undefined;
  if (!agentUserId) return null;
  const base = {
    principalKind: "agent" as const,
    agentUserId,
    scopeKind: "pod" as const,
    verdict: "deny" as const,
    sourceProposalId: ctx.proposalId,
  };

  if (ctx.capabilityTarget) {
    return {
      id: "never",
      value: ctx.capabilityTarget,
      rule: {
        ...base,
        targetKind: "capability",
        targetPattern: ctx.capabilityTarget,
      },
    };
  }

  const actionKey = ctx.actionKey;
  if (!actionKey || actionKey.includes("*") || actionKey === "capability.run")
    return null;
  return {
    id: "never",
    value: actionKey,
    rule: { ...base, targetKind: "action", targetPattern: actionKey },
  };
}
