/**
 * THE AGENT BINDING — how the pod hands work to an EXTERNAL agent.
 *
 * ── The model (validated 2026-10-08, plan "Agents Synap can dispatch work to") ──
 *   IDENTITY  the existing agent user (`users.userType='agent'`). Its agentType,
 *             governance rules, scorecard and its OWN door key (for write-back
 *             through `/mcp`) are unchanged by a binding.
 *   BINDING   a `tools` row (`kind:'external'`, `executor:'external-agent'`)
 *             whose `config.agentBinding` names the provider's verbs.
 *   LINK      `participant(agentUserId) --dispatched_via--> tool(toolId)`,
 *             at most one per agent, written only by a person
 *             (`agentUsers.setBinding`).
 *
 * ONE door reads a binding: `resolveAgentBinding`. ONE rule says how the pod
 * reaches an agent: `resolveAgentReach`. Every dispatch, wake, poll and cancel
 * goes through them — never a second reader of `config.agentBinding`.
 *
 * ── An EMPTY binding and a BROKEN one are different facts ─────────────────────
 * No edge ⇒ `null` (the agent is not dispatchable). An edge whose tool is gone,
 * inactive, the wrong kind, or whose `agentBinding` does not parse ⇒ a typed
 * `AgentBindingError`, never `null`: a broken binding read as "not bound" would
 * silently drop a run on the floor and render as a calm "nothing to do".
 *
 * Synap NEVER spawns a coding agent itself. The binding's verbs are capability
 * verbs (`delegate_agent_task`), run through `executeCapability` — governed,
 * attributed to the agent user.
 */

import { z } from "zod";
import type {
  AgentBindingErrorCode,
  AgentReach,
} from "@synap-core/types/agents";
import {
  db,
  links,
  tools,
  users,
  apiKeys,
  and,
  eq,
  inArray,
  drizzleSql,
} from "@synap/database";

/** The intent every verb an agent binding lists carries (migration 0314). */
export const DELEGATE_AGENT_TASK_INTENT = "delegate_agent_task";

/**
 * The link type that binds an agent to its dispatch tool. Producers and readers
 * spell the LITERAL (`linkType: "dispatched_via"`), not this constant: the
 * links-type SSOT tripwire derives which members are live by scanning for the
 * literal, and a constant would hide this edge from it.
 */
export const DISPATCHED_VIA_LINK_TYPE = "dispatched_via" as const;

const verbId = z.string().trim().min(1).max(200);

/**
 * `tools.config.agentBinding` — validated, never trusted. The provider template
 * (a capability pack) writes it; this schema is the contract the pod reads.
 */
export const AgentBindingConfigSchema = z
  .object({
    protocol: z.string().trim().min(1).max(100),
    provider: z.string().trim().min(1).max(100),
    supports: z.object({
      /** The provider can push status to the pod (v1 polls regardless). */
      push: z.boolean(),
      /** The agent can stop and ask for input (`needs_input`). */
      inputRequired: z.boolean(),
      /** The provider can cancel a started task (`verbs.cancel`). */
      cancel: z.boolean(),
    }),
    verbs: z.object({
      start: verbId,
      send: verbId,
      cancel: verbId.optional(),
      status: verbId.optional(),
    }),
  })
  .refine((b) => !b.supports.cancel || !!b.verbs.cancel, {
    message: "supports.cancel is true but verbs.cancel is missing",
    path: ["verbs", "cancel"],
  });
export type AgentBindingConfig = z.infer<typeof AgentBindingConfigSchema>;

/** What `resolveAgentBinding` hands back — the binding, resolved to its tool. */
export interface AgentBinding {
  toolId: string;
  /** The tool's workspace — the lens its verbs execute in (`null` = pod-wide). */
  workspaceId: string | null;
  provider: string;
  protocol: string;
  supports: AgentBindingConfig["supports"];
  verbs: AgentBindingConfig["verbs"];
}

/**
 * Why a binding cannot be used — the ONE code list lives in
 * `@synap-core/types/agents` (`AGENT_BINDING_ERROR_CODES`), beside the words
 * every surface shows for it; a code without words fails that package's build.
 */
export type { AgentBindingErrorCode };

/** A binding edge exists and cannot be used — said, never folded into `null`. */
export class AgentBindingError extends Error {
  readonly code: AgentBindingErrorCode;
  readonly agentUserId: string;
  readonly toolId: string | null;
  constructor(
    code: AgentBindingErrorCode,
    agentUserId: string,
    toolId: string | null,
    message: string
  ) {
    super(message);
    this.name = "AgentBindingError";
    this.code = code;
    this.agentUserId = agentUserId;
    this.toolId = toolId;
  }
}

/** Validate a tool row as an agent-binding tool. Throws `AgentBindingError`. */
export function parseAgentBindingTool(
  agentUserId: string,
  tool: {
    id: string;
    workspaceId: string | null;
    kind: string;
    executor: string | null;
    status: string | null;
    config: unknown;
  }
): AgentBinding {
  if (tool.kind !== "external" || tool.executor !== "external-agent") {
    throw new AgentBindingError(
      "not_an_agent_tool",
      agentUserId,
      tool.id,
      `Tool ${tool.id} is not an external-agent tool (kind ${tool.kind}, executor ${tool.executor ?? "none"})`
    );
  }
  if (tool.status && tool.status !== "active") {
    throw new AgentBindingError(
      "tool_inactive",
      agentUserId,
      tool.id,
      `The agent's dispatch tool ${tool.id} is ${tool.status}`
    );
  }
  const raw = (tool.config as { agentBinding?: unknown } | null)?.agentBinding;
  const parsed = AgentBindingConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentBindingError(
      "malformed",
      agentUserId,
      tool.id,
      `The agent's dispatch tool ${tool.id} has no valid config.agentBinding: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "agentBinding"} ${i.message}`)
        .join("; ")}`
    );
  }
  return {
    toolId: tool.id,
    workspaceId: tool.workspaceId,
    provider: parsed.data.provider,
    protocol: parsed.data.protocol,
    supports: parsed.data.supports,
    verbs: parsed.data.verbs,
  };
}

/** The tool ids an agent is bound to (0 or 1 when healthy). */
async function boundToolIds(agentUserId: string): Promise<string[]> {
  const rows = await db
    .select({ toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "participant"),
        eq(links.fromId, agentUserId),
        eq(links.toType, "tool"),
        eq(links.linkType, "dispatched_via")
      )
    );
  return rows.map((r) => r.toId);
}

/**
 * THE ONE DOOR that reads an agent's binding.
 *
 * `null` ⇒ the agent has no `dispatched_via` edge (not dispatchable).
 * Throws `AgentBindingError` ⇒ it has one and it cannot be used.
 */
export async function resolveAgentBinding(
  agentUserId: string
): Promise<AgentBinding | null> {
  const toolIds = await boundToolIds(agentUserId);
  if (toolIds.length === 0) return null;
  if (toolIds.length > 1) {
    throw new AgentBindingError(
      "ambiguous",
      agentUserId,
      null,
      `Agent ${agentUserId} is bound to ${toolIds.length} dispatch tools — at most one is allowed`
    );
  }
  const toolId = toolIds[0]!;
  const [tool] = await db
    .select({
      id: tools.id,
      workspaceId: tools.workspaceId,
      kind: tools.kind,
      executor: tools.executor,
      status: tools.status,
      config: tools.config,
    })
    .from(tools)
    .where(eq(tools.id, toolId))
    .limit(1);
  if (!tool) {
    throw new AgentBindingError(
      "tool_missing",
      agentUserId,
      toolId,
      `Agent ${agentUserId} is bound to dispatch tool ${toolId}, which no longer exists`
    );
  }
  return parseAgentBindingTool(agentUserId, tool);
}

// ── Reach ────────────────────────────────────────────────────────────────────

/**
 * How the pod reaches an agent:
 *   'pod'      — an Intelligence-Service agent the pod runs itself (IS turn).
 *   'dispatch' — an external agent with a binding: the pod calls its verbs.
 *   'pull'     — an external agent with no binding: it reads its work through
 *                its own door key (continuation packet, answers poll). Also the
 *                answer for anything that is not an agent user — nothing to run.
 *
 * INVARIANT: an external agent NEVER gets an IS turn under its name. Both
 * external signals (a binding, or a non-internal key it owns, live or revoked)
 * are checked BEFORE 'pod' can be returned.
 *
 * `'dispatch'` is decided by the EDGE alone, not by its health: a bound agent
 * with a broken binding is still external, and the dispatch path surfaces the
 * `AgentBindingError` where a person can see it.
 */
export type { AgentReach };

export async function resolveAgentReach(
  agentUserId: string
): Promise<AgentReach> {
  return (await resolveAgentReachMany([agentUserId])).get(agentUserId)!;
}

/** Batched `resolveAgentReach` — every id gets an answer. */
export async function resolveAgentReachMany(
  agentUserIds: readonly string[]
): Promise<Map<string, AgentReach>> {
  const ids = [...new Set(agentUserIds)];
  const out = new Map<string, AgentReach>();
  if (ids.length === 0) return out;
  const [agentRows, boundRows, keyRows] = await Promise.all([
    db
      .select({
        id: users.id,
        userType: users.userType,
        agentType: users.agentType,
      })
      .from(users)
      .where(inArray(users.id, ids)),
    db
      .select({ fromId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "participant"),
          inArray(links.fromId, ids),
          eq(links.toType, "tool"),
          eq(links.linkType, "dispatched_via")
        )
      ),
    db
      .select({ userId: apiKeys.userId })
      .from(apiKeys)
      .where(
        and(
          inArray(apiKeys.userId, ids),
          drizzleSql`${apiKeys.keyType} IS DISTINCT FROM 'is_internal'`
        )
      ),
  ]);
  const bound = new Set(boundRows.map((r) => r.fromId));
  const ownsKey = new Set(keyRows.map((r) => r.userId));
  const agents = new Map(agentRows.map((r) => [r.id, r]));
  for (const id of ids) {
    const agent = agents.get(id);
    if (!agent || agent.userType !== "agent") out.set(id, "pull");
    else if (bound.has(id)) out.set(id, "dispatch");
    else if (ownsKey.has(id) || !agent.agentType?.trim()) out.set(id, "pull");
    else out.set(id, "pod");
  }
  return out;
}

/**
 * The agent users bound for dispatch (a `dispatched_via` edge), oldest edge
 * first. Health is NOT checked here — the caller resolves the binding and
 * surfaces its error. Used by the run's "which agent" rule.
 */
export async function listDispatchableAgentIds(): Promise<string[]> {
  const rows = await db
    .select({ fromId: links.fromId })
    .from(links)
    .innerJoin(users, drizzleSql`${users.id}::text = ${links.fromId}`)
    .where(
      and(
        eq(links.fromType, "participant"),
        eq(links.toType, "tool"),
        eq(links.linkType, "dispatched_via"),
        eq(users.userType, "agent")
      )
    )
    .orderBy(links.createdAt);
  return [...new Set(rows.map((r) => r.fromId))];
}

/** The UI's view of a binding: `{ toolId, provider, supports }`, or a broken one. */
export interface AgentBindingSummary {
  toolId: string | null;
  provider: string | null;
  supports: AgentBindingConfig["supports"] | null;
  /** Set when the edge exists but the binding cannot be used. */
  error?: { code: AgentBindingErrorCode; message: string };
}

/**
 * Batched read for roster surfaces: reach + binding summary per agent. A broken
 * binding becomes a summary carrying `error` (the roster must still render the
 * other agents), never a silent `null`.
 */
export async function loadAgentDispatchSummaries(
  agentUserIds: readonly string[]
): Promise<
  Map<string, { reach: AgentReach; binding: AgentBindingSummary | null }>
> {
  const reach = await resolveAgentReachMany(agentUserIds);
  const out = new Map<
    string,
    { reach: AgentReach; binding: AgentBindingSummary | null }
  >();
  for (const id of new Set(agentUserIds)) {
    const r = reach.get(id) ?? "pull";
    if (r !== "dispatch") {
      out.set(id, { reach: r, binding: null });
      continue;
    }
    try {
      const b = await resolveAgentBinding(id);
      out.set(id, {
        reach: r,
        binding: b
          ? { toolId: b.toolId, provider: b.provider, supports: b.supports }
          : null,
      });
    } catch (err) {
      if (!(err instanceof AgentBindingError)) throw err;
      out.set(id, {
        reach: r,
        binding: {
          toolId: err.toolId,
          provider: null,
          supports: null,
          error: { code: err.code, message: err.message },
        },
      });
    }
  }
  return out;
}
