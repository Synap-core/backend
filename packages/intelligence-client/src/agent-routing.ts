/**
 * Workspace Agent Routing
 *
 * Resolves WHICH registered agent should handle a unit of work, from the
 * workspace's `agentRouting` policy (workspace.settings.agentRouting):
 *
 *   1. first matching rule  (rule.match vs. the dispatch context)
 *   2. workspace default    (agentRouting.defaultAgentSlug)
 *   3. capability match     (an active agent whose capabilities cover the task)
 *   4. plain IS fallback    (resolveIntelligenceService — no specific agent)
 *
 * Explicit operator config (rule, default) beats inferred capability matching,
 * which beats the blind IS fallback. The capability tier prevents a novel task
 * from silently routing to the wrong default when no rule/default is set.
 *
 * This is the canonical, runtime-agnostic dispatch path: Hermes, the IS
 * orchestrator, a persona, or an external provider are all just registered
 * `agents` rows referenced by slug. Mirrors the precedence shape of
 * resolveIntelligenceService and reuses resolveIntelligenceServiceByAgentId to
 * derive the service (never lets a rule pick a raw intelligence service).
 */

import { db, eq, and } from "@synap/database";
import { agents, workspaces } from "@synap/database/schema";
import type {
  AgentRoutingMatch,
  AgentRoutingPolicy,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  resolveIntelligenceService,
  resolveIntelligenceServiceByAgentId,
  type ResolvedService,
  type ServiceResolutionContext,
} from "./intelligence-routing.js";

const logger = createLogger({ module: "agent-routing" });

/** Dispatch context matched against routing rules. */
export interface AgentResolutionContext {
  userId: string;
  workspaceId?: string;
  taskType?: string;
  profileSlug?: string;
  eventPattern?: string;
  channelType?: string;
  fromState?: string;
  toState?: string;
}

export interface ResolvedAgent {
  /** Registered agent id, or null when nothing matched (pure IS fallback). */
  agentId: string | null;
  agentSlug: string | null;
  /** The intelligence service that backs the chosen agent (or workspace default). */
  service: ResolvedService;
  source: "rule" | "workspace_default" | "capability" | "fallback";
}

// AgentRoutingPolicy / AgentRoutingMatch are the canonical schema types,
// imported above from @synap/database/schema (workspaces.ts).
interface WorkspaceSettingsShape {
  agentRouting?: AgentRoutingPolicy;
  [key: string]: unknown;
}

/** undefined rule value = wildcard; trailing "*" = prefix match; else exact. */
function fieldMatch(
  ruleVal: string | undefined,
  ctxVal: string | undefined
): boolean {
  if (ruleVal === undefined) return true;
  if (ctxVal === undefined) return false;
  if (ruleVal.endsWith("*")) return ctxVal.startsWith(ruleVal.slice(0, -1));
  return ruleVal === ctxVal;
}

function ruleMatches(
  match: AgentRoutingMatch,
  ctx: AgentResolutionContext
): boolean {
  return (
    fieldMatch(match.taskType, ctx.taskType) &&
    fieldMatch(match.profileSlug, ctx.profileSlug) &&
    fieldMatch(match.eventPattern, ctx.eventPattern) &&
    fieldMatch(match.channelType, ctx.channelType) &&
    fieldMatch(match.fromState, ctx.fromState) &&
    fieldMatch(match.toState, ctx.toState)
  );
}

/** Resolve an agent by slug → its backing service. Null if no active agent. */
async function resolveBySlug(
  agentSlug: string,
  serviceCtx: ServiceResolutionContext,
  source: "rule" | "workspace_default"
): Promise<ResolvedAgent | null> {
  const [agent] = await db
    .select({ id: agents.id, slug: agents.slug })
    .from(agents)
    .where(and(eq(agents.slug, agentSlug), eq(agents.active, true)))
    .limit(1);

  if (!agent) {
    logger.warn(
      { agentSlug },
      "Routing rule references unknown/inactive agent slug"
    );
    return null;
  }

  const service = await resolveIntelligenceServiceByAgentId(
    agent.id,
    serviceCtx
  );
  logger.info(
    { agentSlug, agentId: agent.id, source },
    "Agent resolved for task"
  );
  return { agentId: agent.id, agentSlug: agent.slug, service, source };
}

/**
 * Resolve an active agent whose `capabilities` cover the task's type/profile.
 * Inferred routing — used only when no explicit rule or workspace default
 * matched, so a novel task reaches a capable agent instead of a blind default.
 * Agent counts per pod are small, so a simple in-memory overlap check is fine.
 */
async function resolveByCapability(
  ctx: AgentResolutionContext,
  serviceCtx: ServiceResolutionContext
): Promise<ResolvedAgent | null> {
  // NOTE: capabilities is a flat text[] with no namespace, so a taskType and a
  // profileSlug that share a string collide. Acceptable for v1; namespace
  // (e.g. "task:" / "profile:" prefixes) when capabilities are formalized.
  const wanted = [ctx.taskType, ctx.profileSlug].filter((v): v is string =>
    Boolean(v)
  );
  if (wanted.length === 0) return null;

  // Deterministic order (createdAt) so the winner is stable across queries.
  const candidates = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      capabilities: agents.capabilities,
    })
    .from(agents)
    .where(eq(agents.active, true))
    .orderBy(agents.createdAt);

  // Prefer an agent advertising ALL of the task's dimensions; else ANY.
  const match =
    candidates.find((a) =>
      wanted.every((w) => (a.capabilities ?? []).includes(w))
    ) ??
    candidates.find((a) =>
      (a.capabilities ?? []).some((c) => wanted.includes(c))
    );
  if (!match) return null;

  const service = await resolveIntelligenceServiceByAgentId(
    match.id,
    serviceCtx
  );
  logger.info(
    { agentSlug: match.slug, agentId: match.id, source: "capability" },
    "Agent resolved by capability match"
  );
  return {
    agentId: match.id,
    agentSlug: match.slug,
    service,
    source: "capability",
  };
}

/**
 * Resolve which agent should handle a unit of work for a workspace.
 * Always returns a ResolvedAgent — falls back to a plain IS resolution
 * (agentId: null) when no rule or default matches.
 */
export async function resolveAgentForTask(
  ctx: AgentResolutionContext
): Promise<ResolvedAgent> {
  const serviceCtx: ServiceResolutionContext = {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  };

  let policy: AgentRoutingPolicy | undefined;
  if (ctx.workspaceId) {
    try {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, ctx.workspaceId),
      });
      policy = (workspace?.settings as WorkspaceSettingsShape | undefined)
        ?.agentRouting;
    } catch (err) {
      logger.warn(
        { err, workspaceId: ctx.workspaceId },
        "Failed to load agentRouting"
      );
    }
  }

  // 1. First matching rule wins (guard against malformed settings — degrade to
  //    fallback rather than throwing if `rules` is not a well-formed array)
  const rules = Array.isArray(policy?.rules) ? policy.rules : [];
  const rule = rules.find((r) => r?.match && ruleMatches(r.match, ctx));
  if (rule?.agentSlug) {
    const resolved = await resolveBySlug(rule.agentSlug, serviceCtx, "rule");
    if (resolved) return resolved;
  }

  // 2. Workspace default agent
  if (policy?.defaultAgentSlug) {
    const resolved = await resolveBySlug(
      policy.defaultAgentSlug,
      serviceCtx,
      "workspace_default"
    );
    if (resolved) return resolved;
  }

  // 3. Capability match: an active agent that advertises the task's type/profile
  const byCapability = await resolveByCapability(ctx, serviceCtx);
  if (byCapability) return byCapability;

  // 4. Fallback: no registered agent matched — resolve the IS the normal way
  const service = await resolveIntelligenceService(serviceCtx);
  return { agentId: null, agentSlug: null, service, source: "fallback" };
}
