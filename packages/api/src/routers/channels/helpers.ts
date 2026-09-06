/**
 * Channels Router - tRPC routes for channels (conversations) with branching
 *
 * Handles:
 * - Channel management (channels table, was chat_threads)
 * - Message sending/receiving with Intelligence Hub
 * - Entity extraction
 * - Branching logic
 * - Context tracking via channel_context_items
 */

import { z } from "zod";

import { AccessContext, scopedDb } from "../../access/index.js";

import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { ownerPrivateVisibleWhere } from "../../utils/user-visible-where.js";

import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  ne,
  desc,
  and,
  or,
  inArray,
  isNull,
  exists,
  drizzleSql,
} from "@synap/database";
import {
  channels,
  channelMembers,
  ChannelMemberKind,
  messages,
  channelContextItems,
  entities as entitiesTable,
  documents as documentsTable,
  ChannelType,
  FeedScope,
  ChannelStatus,
  MessageRole,
  users,
  workspaceMembers,
  workspaces,
  projects,
  projectMembers,
  mcpServers,
  agents,
} from "@synap/database/schema";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";

import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";

import { randomUUID } from "crypto";

import type { Channel } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

import { AgentRepository } from "@synap/database";
import { resolveVaultReferences } from "../../utils/vault-resolver.js";

const logger = createLogger({ module: "channels" });

export const TURN_CONTEXT_SENSITIVE_KEY =
  /(?:api[-_]?key|authorization|cookie|credential|email|password|phone|private|secret|token)/i;

/**
 * TURN CONTEXT — the canonical wire contract, with ONE deliberate twin.
 *
 * The Intelligence Service re-declares this exact shape at
 * `synap-intelligence-service/apps/intelligence-hub/src/routes/chat-stream.ts`
 * (`TurnContextSchema`) because the two live in separate repos and neither can
 * import the other. They MUST be kept in lockstep: the pod validates first and
 * forwards, so a field the pod strips or rejects can never reach the agent, and
 * a field the IS rejects 400s a turn the pod already persisted. That asymmetry
 * IS the 2026-08-20 Companion outage — three definitions of this contract
 * disagreeing on what "20 items" meant. Do not add a fourth definition; when
 * you change anything here, change the IS twin in the same wave.
 *
 * `channels.turn-context.test.ts` pins the field list and every bound below.
 */
export const TURN_CONTEXT_MAX_ENTRIES = 20;
export const TURN_CONTEXT_MAX_KEY_LENGTH = 64;
export const TURN_CONTEXT_MAX_STRING_LENGTH = 400;
export const TURN_CONTEXT_MAX_ARRAY_ITEMS = 12;
export const TURN_CONTEXT_MAX_ARRAY_STRING_LENGTH = 128;
export const TURN_CONTEXT_MAX_SESSION_CHAIN = 8;
export const TURN_CONTEXT_MAX_SERIALIZED_LENGTH = 8_000;

export const TurnContextValueSchema = z.union([
  z.string().max(TURN_CONTEXT_MAX_STRING_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z
    .array(z.string().max(TURN_CONTEXT_MAX_ARRAY_STRING_LENGTH))
    .max(TURN_CONTEXT_MAX_ARRAY_ITEMS),
]);

export const TurnContextEntrySchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(TURN_CONTEXT_MAX_KEY_LENGTH)
      .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/),
    value: TurnContextValueSchema,
  })
  .strict();

/**
 * The caller's view of the focus session this turn belongs to.
 *
 * A SIBLING of `entries`, deliberately — not an entry, and not nested in one.
 * `entries` is the flat primitive bag whose 20-item cap is shared verbatim with
 * the browser and the IS; flattening a goal chain into it would spend that
 * shared budget on one field. This field carries its OWN bounds and counts
 * against neither the entry cap nor the entry value union. The serialized
 * ceiling still covers it, which is why its chain and strings are length-capped.
 *
 * `version` is a literal so an incompatible caller fails loudly at the boundary
 * instead of silently under-populating the prompt.
 */
export const TurnContextSessionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(TURN_CONTEXT_MAX_KEY_LENGTH),
    goal: z.string().min(1).max(TURN_CONTEXT_MAX_STRING_LENGTH),
    stage: z.string().max(TURN_CONTEXT_MAX_KEY_LENGTH).optional(),
    progress: z.number().finite().min(0).max(100).optional(),
    depth: z.number().int().min(0).max(TURN_CONTEXT_MAX_SESSION_CHAIN),
    chain: z
      .array(
        z
          .object({
            id: z.string().min(1).max(TURN_CONTEXT_MAX_KEY_LENGTH),
            goal: z.string().min(1).max(TURN_CONTEXT_MAX_STRING_LENGTH),
          })
          .strict()
      )
      .max(TURN_CONTEXT_MAX_SESSION_CHAIN),
    suspendedIntent: z.string().max(TURN_CONTEXT_MAX_STRING_LENGTH).optional(),
  })
  .strict();

/**
 * Bounded, surface-agnostic per-turn context. Entries deliberately stay flat:
 * callers can attach compact hints without smuggling an unbounded UI state or
 * a deeply nested arbitrary payload into chat history or the Intelligence Hub.
 */
export const TurnContextSchema = z
  .object({
    // OPTIONAL since the session sibling landed: a turn may carry a session and
    // no surface entries. Still `.min(1)` WHEN PRESENT, so "never an empty
    // entries array" is unchanged.
    entries: z
      .array(TurnContextEntrySchema)
      .min(1)
      .max(TURN_CONTEXT_MAX_ENTRIES)
      .optional(),
    session: TurnContextSessionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // `{}` is a caller bug, not a valid payload — it must not become newly
    // acceptable just because `entries` went optional.
    if (!value.entries && !value.session) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "turnContext must carry entries, session, or both",
      });
    }
    if (JSON.stringify(value).length > TURN_CONTEXT_MAX_SERIALIZED_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `turnContext may not exceed ${TURN_CONTEXT_MAX_SERIALIZED_LENGTH} serialized characters`,
      });
    }
  });
export type TurnContext = z.infer<typeof TurnContextSchema>;

// Includes "proposal" so a single-chat front door can open a thread bound to a
// pending proposal — the canonical `resolve-or-create-channel` util already
// accepts it, and the hub context path (hub-protocol/context.ts) hydrates a
// `contextObjectType: "proposal"` thread into the prompt. This tRPC enum was a
// shadow that omitted it, closing that door.
export const CONTEXT_OBJECT_TYPE_VALUES = [
  "entity",
  "document",
  "view",
  "proposal",
] as const;

/**
 * Shared wire contract for the tRPC mutation and the canonical HTTP sender
 * stream. Keeping this schema in one place prevents their authorization and
 * workflow inputs from drifting apart.
 */
export const channelSendMessageInputSchema = z.object({
  /** Client-generated retry key. Canonical HTTP streaming requires it; legacy tRPC remains compatible. */
  clientRequestId: z.string().uuid().optional(),
  /** When omitted, backend creates a new channel and returns its id. */
  channelId: z.string().uuid().optional(),
  content: z.string().min(1).max(50_000),
  workspaceId: z.string().uuid().optional(),
  /** Active project lens. Authorized independently before any IS request. */
  projectId: z.string().uuid().optional(),
  /** UUID of the agent to use — validated against agents table */
  agentId: z.string().uuid().optional(),
  /** @mention handle, e.g. "cto" or "ai" — resolved to agent slug for this call only */
  agentHandle: z.string().optional(),
  /** Originating channel ID when spawning a new THREAD from a non-AI channel */
  parentChannelId: z.string().uuid().optional(),
  /** Entity IDs of uploaded files to attach to this message */
  attachmentEntityIds: z.array(z.string().uuid()).max(10).optional(),
  /** Deep Analysis mode — routes to the COMPLEX tier (Opus) for max reasoning quality */
  deepAnalysis: z.boolean().optional(),
  /** Channel type for resolving default channel when channelId is omitted (V2 vocab) */
  channelType: z
    .enum([
      ChannelType.PERSONAL,
      ChannelType.THREAD,
      ChannelType.SUB_THREAD,
      ChannelType.AGENT_COLLAB,
    ])
    .optional(),
  contextObjectId: z.string().uuid().optional(),
  contextObjectType: z.enum(CONTEXT_OBJECT_TYPE_VALUES).optional(),
  branchPurpose: z.string().max(500).optional(),
  /** Exclude both messages from durable channel history. */
  ephemeral: z.boolean().optional(),
  /** Compact, generic per-turn context; intentionally flat and bounded. */
  turnContext: TurnContextSchema.optional(),
  /**
   * First-party contextual workflow. Keep this an allowlist: Browser callers
   * must never be able to force-load an arbitrary Pod skill.
   */
  onboardingSkill: z.enum(["onboard", "agent-os"]).optional(),
});

/** Redact credential-like entry keys before persisting or forwarding context. */
/**
 * Redacts sensitive ENTRY values. Every other field must be carried through
 * verbatim — this used to rebuild the object as `{ entries }`, which would
 * silently strip the `session` sibling on its way to the IS, i.e. exactly the
 * "pod accepts, agent never sees it" severance the twin comment above warns of.
 * Spread first, then overwrite only what is redacted.
 */
export function redactTurnContext(turnContext: TurnContext): TurnContext {
  return {
    ...turnContext,
    ...(turnContext.entries
      ? {
          entries: turnContext.entries.map((entry) =>
            TURN_CONTEXT_SENSITIVE_KEY.test(entry.key)
              ? { ...entry, value: "[redacted]" }
              : entry
          ),
        }
      : {}),
  };
}

/**
 * Canonical visibility floor for a project-scoped AI turn:
 * owner-private projects, workspace-visible projects, or an explicit project
 * membership. The project lens may narrow agent recall, but it never grants
 * access by itself.
 */
export function projectTurnAccessWhere(userId: string) {
  return or(
    ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId),
    inArray(
      projects.id,
      db
        .select({ id: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, userId))
    )
  )!;
}

/** Channel kinds whose user turns receive the internal memory-session boundary. */
export function usesInternalSessionBoundary(channelType: ChannelType): boolean {
  return (
    channelType === ChannelType.PERSONAL ||
    channelType === ChannelType.THREAD ||
    channelType === ChannelType.AGENT_COLLAB ||
    channelType === ChannelType.GROUP
  );
}

/**
 * Derive the set of @handle spellings a human's display name could be mentioned
 * by. Used to match a plain `@handle` in message content to a channel member.
 * All lower-cased to match `extractHumanMentionHandles`. E.g. "Antoine Servant"
 * → {"antoineservant", "antoine", "antoine-servant", "antoine_servant"}.
 */
export function handleCandidatesFor(name: string | null): Set<string> {
  const out = new Set<string>();
  if (!name) return out;
  const lower = name.trim().toLowerCase();
  if (!lower) return out;
  const alnum = lower.replace(/[^a-z0-9]+/g, "");
  if (alnum) out.add(alnum); // "antoineservant"
  const firstToken = lower.split(/\s+/)[0]?.replace(/[^a-z0-9]+/g, "");
  if (firstToken) out.add(firstToken); // "antoine"
  const hyphen = lower.replace(/\s+/g, "-").replace(/[^a-z0-9-]+/g, "");
  if (hyphen) out.add(hyphen); // "antoine-servant"
  const underscore = lower.replace(/\s+/g, "_").replace(/[^a-z0-9_]+/g, "");
  if (underscore) out.add(underscore); // "antoine_servant"
  return out;
}

/** A concrete fetch target produced by the CP query planner. */
export interface DerivedQuery {
  upstreamType: string;
  config: Record<string, unknown>;
  label: string;
  rationale?: string;
}

/**
 * Ask the CP relay to expand archetype + criteria into concrete DerivedQuery[].
 * Best-effort: returns [] on any error so setupFeed can proceed unblocked.
 */
export async function deriveFeedQueries(
  archetypeConfig: { config: unknown; userId: string },
  archetype: string,
  criteria: string | undefined
): Promise<DerivedQuery[]> {
  try {
    const raw = (archetypeConfig.config ?? {}) as Record<string, unknown>;
    // Fall back to env vars — source_config rows don't always bake in the CP URL.
    const relayUrl =
      (raw.relayUrl as string | undefined) ??
      process.env.CP_URL ??
      process.env.CONTROL_PLANE_URL;
    const relayKeyRef =
      (raw.relayKey as string | undefined) ??
      process.env.CP_RELAY_KEY ??
      process.env.SOURCE_RELAY_KEY;
    if (!relayUrl || !relayKeyRef) return [];

    const resolved = await resolveVaultReferences(
      { relayKey: relayKeyRef },
      archetypeConfig.userId
    );
    const relayKey = resolved.relayKey;
    if (!relayKey) return [];

    const res = await fetch(
      `${relayUrl.replace(/\/$/, "")}/api/sources/plan-queries`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${relayKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ archetype, criteria }),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      logger.warn(
        { archetype, status: res.status },
        "plan-queries returned non-OK — skipping derived queries"
      );
      return [];
    }

    const json = (await res.json()) as unknown;
    if (
      !json ||
      typeof json !== "object" ||
      !Array.isArray((json as { queries?: unknown }).queries)
    ) {
      return [];
    }
    return (json as { queries: DerivedQuery[] }).queries;
  } catch (err) {
    logger.warn(
      { err, archetype },
      "Failed to derive feed queries (non-fatal)"
    );
    return [];
  }
}

export const CHANNEL_TYPE_VALUES = [
  ChannelType.PERSONAL,
  ChannelType.THREAD,
  ChannelType.SUB_THREAD,
  ChannelType.FEED,
  ChannelType.EXTERNAL,
  ChannelType.AGENT_COLLAB,
  ChannelType.GROUP,
  ChannelType.RUN,
] as const;

// ── MCP server list cache ────────────────────────────────────────────────────
// Avoid a DB query on every message send. TTL = 30s (short enough to pick up
// newly provisioned servers quickly; long enough to handle bursts).

export interface McpServerEntry {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

export const MCP_CACHE_TTL_MS = 30_000;
export const mcpServerCache = new Map<
  string,
  { servers: McpServerEntry[]; expiresAt: number }
>();

export const POD_WIDE_MCP_CACHE_KEY = "__pod_wide__";

export function invalidateMcpCache(workspaceId?: string | null): void {
  mcpServerCache.delete(workspaceId ?? POD_WIDE_MCP_CACHE_KEY);
}

/**
 * Resolve an agentId for message sending.
 * If a valid UUID is passed, validate it exists + active in the agents table.
 * Otherwise falls back to the orchestrator agent.
 * Throws if neither is found — a missing orchestrator means agent sync hasn't run.
 */
export async function resolveAgentId(agentId?: string): Promise<string> {
  // Validate the provided UUID format
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (agentId && !UUID_RE.test(agentId)) {
    logger.warn(
      { agentId },
      "Invalid agentId UUID format, falling back to orchestrator"
    );
    agentId = undefined;
  }

  if (agentId) {
    const agentRepo = new AgentRepository(db);
    const agent = await agentRepo.getById(agentId);
    if (agent?.active) return agent.id;
    logger.warn(
      { agentId },
      "Agent not found or inactive, falling back to orchestrator"
    );
  }

  // Fall back to the orchestrator agent
  const [orchestrator] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
    .limit(1);

  if (!orchestrator) {
    throw new Error(
      "Orchestrator agent not found in agents table. Run agent sync (POST /api/hub/agents/sync) to populate."
    );
  }
  return orchestrator.id;
}

export async function getMcpServersForWorkspace(
  workspaceId: string
): Promise<McpServerEntry[]> {
  const cached = mcpServerCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.servers;
  }
  const rows = await db.query.mcpServers.findMany({
    where: and(
      eq(mcpServers.workspaceId, workspaceId),
      eq(mcpServers.approved, true),
      eq(mcpServers.enabled, true)
    ),
  });
  const servers: McpServerEntry[] = rows
    .filter((r) => r.transport === "stdio" || r.transport === "http")
    .map((r) => ({
      id: r.slug,
      name: r.name,
      transport: r.transport as "stdio" | "http",
      command: r.command ?? undefined,
      args: r.args,
      url: r.url ?? undefined,
      env: r.env,
      enabled: r.enabled,
    }));
  mcpServerCache.set(workspaceId, {
    servers,
    expiresAt: Date.now() + MCP_CACHE_TTL_MS,
  });
  return servers;
}

/**
 * Ensure a pod-wide personal AI agent user exists for this human.
 * One agent user is shared across all workspaces — it accumulates memory
 * and identity pod-wide rather than being fragmented per workspace.
 *
 * Flow:
 *   1. Look up by createdByUserId + isPersonalAgent (pod-wide, no workspace filter).
 *   2. If found: ensure membership in the current workspace if absent.
 *   3. If not found: create the agent user, then add membership.
 *
 * Role: "owner" in agent-governed workspaces (governanceMode='agent-owned'),
 *       "editor" in all other workspaces.
 */
export async function ensureAgentUser(
  userId: string,
  workspaceId: string
): Promise<string> {
  // 1. Find existing pod-wide personal agent (no workspace filter)
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        eq(users.createdByUserId, userId),
        eq(users.isPersonalAgent, true)
      )
    )
    .limit(1);

  let resolvedAgentId: string;

  if (!existing) {
    // 2a. Create the pod-wide personal agent user
    const newId = randomUUID();
    const shortId = newId.slice(0, 8);
    try {
      const [agentUser] = await db
        .insert(users)
        .values({
          id: newId,
          email: `agent-orchestrator-${shortId}@synap.agent`,
          userType: "agent",
          kratosIdentityId: null,
          createdByUserId: userId,
          agentType: "orchestrator",
          isPersonalAgent: true,
          createdVia: "system",
          agentMetadata: {
            createdByUserId: userId,
            agentType: "orchestrator",
            isPersonalAgent: true,
          },
        })
        .returning({ id: users.id });
      resolvedAgentId = agentUser.id;
    } catch (err) {
      // DB firewall: a partial unique index on (createdByUserId, agentType) for
      // personal agents rejects a concurrent insert. Reuse the winner; if nothing
      // matches, the error wasn't a dedup race — re-throw.
      const [raced] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.userType, "agent"),
            eq(users.createdByUserId, userId),
            eq(users.isPersonalAgent, true)
          )
        )
        .limit(1);
      if (!raced) throw err;
      resolvedAgentId = raced.id;
    }
  } else {
    resolvedAgentId = existing.id;
  }

  // 2b. Ensure workspace membership (idempotent)
  const [existingMembership] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, resolvedAgentId),
        eq(workspaceMembers.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!existingMembership) {
    // Agent is owner in agent-governed workspaces, editor elsewhere
    const [ws] = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const wsSettings = ws?.settings as { governanceMode?: string } | undefined;
    const role =
      wsSettings?.governanceMode === "agent-owned" ? "owner" : "editor";

    await db.insert(workspaceMembers).values({
      id: randomUUID(),
      workspaceId,
      userId: resolvedAgentId,
      role,
    });
  }

  return resolvedAgentId;
}

/**
 * Relay the Synap AI's response to an external platform (Telegram, WhatsApp, etc.)
 * via the registered OpenClaw intelligence service.
 *
 * Uses the `channels` capability to find the service that handles external messaging.
 * If no such service is registered (no OpenClaw), this is a silent no-op.
 *
 * OpenClaw expects an OpenAI-compatible POST to `/v1/chat/completions` with an
 * `x-openclaw-session-key` header containing the platform's native channel ID.
 * It routes the content to the correct platform + contact automatically.
 */
export async function relayToExternalChannel(opts: {
  workspaceId: string | undefined;
  userId: string;
  externalSource: string;
  externalChannelId: string;
  content: string;
}): Promise<void> {
  const { workspaceId, userId, externalSource, externalChannelId, content } =
    opts;

  let service: Awaited<ReturnType<typeof resolveIntelligenceService>>;
  try {
    service = await resolveIntelligenceService({
      userId,
      workspaceId,
      capability: "channels", // routes to OpenClaw/ZeroClaw which have "channels" capability
    });
  } catch {
    return; // no service registered for channels capability — silent no-op
  }

  // Only relay if the resolved service is NOT the default Intelligence Hub
  // (which can't receive external relay calls)
  if (service.serviceId === "default" || !service.endpoint) return;

  // SSRF guard: validate the service endpoint before fetching
  const urlCheck = validateExternalUrl(service.endpoint);
  if (!urlCheck.valid) {
    console.warn(
      "[channels] Blocked relay to potentially unsafe endpoint:",
      service.endpoint,
      urlCheck.reason
    );
    return;
  }

  await safeExternalFetch(`${service.endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openclaw-session-key": externalChannelId,
      "x-openclaw-platform": externalSource,
    },
    body: JSON.stringify({
      model: "synap-relay",
      messages: [{ role: "assistant", content }],
      stream: false,
    }),
    signal: AbortSignal.timeout(15000),
  });
}

/**
 * Node shape for the workspace branch tree response.
 * Defined at module scope so tsc can include it in declaration output.
 */
export type BranchNodeResult = {
  channel: Channel;
  children: BranchNodeResult[];
  messageCount: number;
  lastActivity: Date;
  depth: number;
};

/**
 * Channels Router
 *
 * Registered under the `chat` tRPC key for frontend compatibility.
 */
export async function listChannelsWithFlags(params: {
  userId: string;
  workspaceId?: string;
  /** Project lens (cross-cutting): filter channels tagged to this project. */
  projectId?: string;
  channelType?: (typeof CHANNEL_TYPE_VALUES)[number];
  feedScope?: FeedScope;
  contextObjectId?: string;
  contextObjectType?: (typeof CONTEXT_OBJECT_TYPE_VALUES)[number];
  assignedAgentId?: string;
  /** Agent INSTANCE (users.id) — channels where this agent-user is an ai_agent member. */
  agentMemberId?: string;
  /**
   * Include channels whose status is `archived` / `merged`. Default FALSE.
   *
   * Archiving is what the sidebar's "Delete" action does (it sets
   * `status: ARCHIVED`), but this query historically applied NO status filter —
   * so archived channels kept rendering forever and "Delete" appeared to do
   * nothing. Callers that genuinely want the full set (an archive browser,
   * restore flows) opt in explicitly.
   */
  includeArchived?: boolean;
  /**
   * Free-text narrow over the channel's own visible labels (`title`, and
   * `branch_purpose` — which is what an untitled branch renders as). ANDed into
   * the SAME condition list as every other filter, so BROWSE (no `search`) and
   * SEARCH are one code path with one access floor; there is no second loader
   * that could drift from this one.
   *
   * Server-side by design: a picker that filters "page 1 of everything" in the
   * client cannot tell an absent result from a not-yet-loaded one.
   */
  search?: string;
  limit: number;
  offset?: number;
}): Promise<
  Array<
    Channel & {
      hasAssistantMessage: boolean;
      origin: string;
      unreadCount: number;
      /**
       * For `personal` (DM) channels: the OTHER human member's userId (the human
       * counterpart of this DM, excluding the caller). null for non-DM channels
       * or a DM that has no distinct human counterpart (e.g. agent-only DM).
       * Lets the sidebar wire a LIVE presence dot keyed by this id.
       */
      counterpartUserId?: string | null;
    }
  >
> {
  // Canonical channel visibility — see utils/channel-visibility.ts.
  const accessPredicate = channelVisibilityWhere(params.userId);
  const conditions: any[] = [accessPredicate];

  // Live channels only, unless the caller explicitly asks for the archive.
  // Without this, `archiveChannel` (status → ARCHIVED) had no visible effect:
  // the channel stayed in every list forever.
  if (!params.includeArchived) {
    conditions.push(eq(channels.status, ChannelStatus.ACTIVE));
  }

  if (params.workspaceId !== undefined) {
    // Include workspace channels + pod-wide channels (personal-style thread + feed)
    conditions.push(
      or(
        eq(channels.workspaceId, params.workspaceId),
        inArray(channels.channelType, [
          ChannelType.THREAD,
          ChannelType.PERSONAL,
        ]),
        eq(channels.channelType, ChannelType.FEED)
      )!
    );
  }

  if (params.projectId) {
    conditions.push(eq(channels.projectId, params.projectId));
  }

  if (params.channelType) {
    conditions.push(eq(channels.channelType, params.channelType));
  }

  if (params.feedScope) {
    conditions.push(eq(channels.feedScope, params.feedScope));
  }

  if (params.contextObjectId !== undefined) {
    conditions.push(eq(channels.contextObjectId, params.contextObjectId));
  }

  if (params.contextObjectType !== undefined) {
    conditions.push(eq(channels.contextObjectType, params.contextObjectType));
  }

  if (params.assignedAgentId) {
    conditions.push(eq(channels.assignedAgentId, params.assignedAgentId));
  }

  // Free-text narrow — same shape as `entities.adminList` (routers/entities/
  // admin.ts): trim, bail on empty, ILIKE the display columns, AND it into the
  // shared `conditions`. Empty/absent query ⇒ no condition ⇒ plain browse.
  const searchTerm = params.search?.trim();
  if (searchTerm) {
    const pattern = `%${searchTerm}%`;
    conditions.push(
      or(
        drizzleSql`${channels.title} ILIKE ${pattern}`,
        drizzleSql`${channels.branchPurpose} ILIKE ${pattern}`
      )!
    );
  }

  // Per-instance link: channels where this agent-user is the ai_agent member.
  if (params.agentMemberId) {
    conditions.push(
      exists(
        db
          .select({ one: drizzleSql`1` })
          .from(channelMembers)
          .where(
            and(
              eq(channelMembers.channelId, channels.id),
              eq(channelMembers.memberId, params.agentMemberId),
              eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
            )
          )
      )!
    );
  }

  const rows = await db.query.channels.findMany({
    where: and(...conditions),
    orderBy: [desc(channels.updatedAt)],
    limit: params.limit,
    offset: params.offset,
  });

  if (rows.length === 0) {
    return [];
  }

  const channelIds = rows.map((c) => c.id);
  const rowsWithAssistant = await db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(
      and(
        inArray(messages.channelId, channelIds),
        eq(messages.role, MessageRole.ASSISTANT),
        // Ephemeral replies vanish on reload — they don't mark a channel as
        // "has an assistant reply".
        eq(messages.ephemeral, false)
      )
    );
  const channelIdsWithAssistant = new Set(
    rowsWithAssistant.map((r) => r.channelId)
  );

  // Compute unread counts: messages newer than the caller's last_read_at per channel.
  // Single LEFT JOIN query — non-members (owners with no channel_members row) get 0.
  const unreadRows =
    channelIds.length === 0
      ? []
      : await db
          .select({
            channelId: messages.channelId,
            cnt: drizzleSql<number>`COUNT(*)::int`,
          })
          .from(messages)
          .leftJoin(
            channelMembers,
            and(
              eq(channelMembers.channelId, messages.channelId),
              eq(channelMembers.memberId, params.userId)
            )
          )
          .where(
            and(
              inArray(messages.channelId, channelIds),
              isNull(messages.deletedAt),
              // Ephemeral messages disappear on reload — they must not drive an
              // unread badge that would then point at nothing.
              eq(messages.ephemeral, false),
              // Unread = no read marker OR message is newer than the marker.
              drizzleSql`(${channelMembers.lastReadAt} IS NULL OR ${messages.timestamp} > ${channelMembers.lastReadAt})`
            )
          )
          .groupBy(messages.channelId);
  const unreadByChannel = new Map(
    unreadRows.map((r) => [r.channelId, r.cnt ?? 0])
  );

  // DM counterpart resolution: for each `personal` channel, the OTHER human
  // member (memberKind=human, memberId != caller). One query across all personal
  // channels (mirrors the assistant/unread aggregate pattern above — no N+1).
  const personalChannelIds = rows
    .filter((c) => c.channelType === ChannelType.PERSONAL)
    .map((c) => c.id);
  const counterpartByChannel = new Map<string, string>();
  if (personalChannelIds.length > 0) {
    const counterpartRows = await db
      .select({
        channelId: channelMembers.channelId,
        memberId: channelMembers.memberId,
      })
      .from(channelMembers)
      .where(
        and(
          inArray(channelMembers.channelId, personalChannelIds),
          eq(channelMembers.memberKind, ChannelMemberKind.HUMAN),
          ne(channelMembers.memberId, params.userId)
        )
      );
    for (const r of counterpartRows) {
      // First human counterpart wins (DMs are 1:1; defensive for group edge cases).
      if (!counterpartByChannel.has(r.channelId)) {
        counterpartByChannel.set(r.channelId, r.memberId);
      }
    }
  }

  return rows.map((c) => ({
    ...c,
    hasAssistantMessage: channelIdsWithAssistant.has(c.id),
    unreadCount: unreadByChannel.get(c.id) ?? 0,
    origin: (c.metadata as { origin?: string } | null)?.origin ?? "chat",
    counterpartUserId:
      c.channelType === ChannelType.PERSONAL
        ? (counterpartByChannel.get(c.id) ?? null)
        : null,
  }));
}

/**
 * Authorize a channel-membership mutation/read.
 *
 * The caller must be the channel owner OR a recorded channel member; and when
 * the channel is workspace-scoped, a member of that workspace (no cross-tenant
 * access). Returns the channel row so callers reuse it. Throws TRPCError
 * (NOT_FOUND / FORBIDDEN) otherwise. Mirrors the access predicate used by
 * listChannelsWithFlags and the workspace membership checks in sendMessage.
 */
export async function assertChannelMembershipAccess(
  channelId: string,
  userId: string
): Promise<Channel> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
  });
  if (!channel) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
  }

  if (channel.userId === userId) return channel;

  // Channel member?
  const member = await db.query.channelMembers.findFirst({
    where: and(
      eq(channelMembers.channelId, channelId),
      eq(channelMembers.memberId, userId)
    ),
    columns: { id: true },
  });
  if (member) {
    // Workspace scoping: a channel member must still be in the channel's
    // workspace (defence-in-depth against a stale cross-tenant member row).
    if (channel.workspaceId) {
      const wsMembership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, channel.workspaceId),
          eq(workspaceMembers.userId, userId)
        ),
        columns: { id: true },
      });
      if (!wsMembership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this channel",
        });
      }
    }
    return channel;
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: "You do not have access to this channel",
  });
}

/** Recursive node returned by getBranchTree — mirrors the frontend BranchNode shape */
export type BranchTreeNode = {
  channel: Channel;
  children: BranchTreeNode[];
};

/**
 * Helper: build branch tree structure
 */
export function buildBranchTree(
  channels: Channel[],
  rootId: string
): BranchTreeNode | null {
  const root = channels.find((c) => c.id === rootId);
  if (!root) return null;

  const children = channels
    .filter((c) => c.parentChannelId === rootId)
    .map((child) => buildBranchTree(channels, child.id))
    .filter((n): n is BranchTreeNode => n !== null);

  return { channel: root, children };
}

/**
 * Batch-resolve `objectId -> name` for channel context items, grouped by
 * objectType. `channel_context_items` is polymorphic with no FK (see the
 * schema comment), so resolution is app-layer: one query per object type
 * over the id set, never a SQL join. Types without a known name source
 * (view/proposal/inbox_item) resolve to `null` — left honestly unresolved
 * rather than guessed at.
 *
 * Floored by the caller's `AccessContext` via `scopedDb` (the `entities` /
 * `documents` VisibilityRule — the same floor `entities.get` / `documents`
 * reads use) — the upstream channel-authz check above is NOT relied on as
 * the floor for referenced objects, since a context item can point at an
 * object outside the channel's own workspace. An id the caller can't see
 * simply never appears in the resolved rows, so it resolves to `null`
 * (honest — not the title) exactly like the other unresolved kinds.
 */
export async function resolveContextItemNames(
  items: (typeof channelContextItems.$inferSelect)[],
  access: AccessContext
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();

  const entityIds = [
    ...new Set(
      items.filter((i) => i.objectType === "entity").map((i) => i.objectId)
    ),
  ];
  const documentIds = [
    ...new Set(
      items.filter((i) => i.objectType === "document").map((i) => i.objectId)
    ),
  ];

  if (entityIds.length) {
    const rows = await scopedDb(access).findMany<{
      id: string;
      title: string | null;
    }>(entitiesTable, {
      where: inArray(entitiesTable.id, entityIds),
      columns: { id: true, title: true },
    });
    for (const row of rows) names.set(row.id, row.title ?? null);
  }

  if (documentIds.length) {
    const rows = await scopedDb(access).findMany<{
      id: string;
      title: string | null;
    }>(documentsTable, {
      where: inArray(documentsTable.id, documentIds),
      columns: { id: true, title: true },
    });
    for (const row of rows) names.set(row.id, row.title ?? null);
  }

  // view / proposal / inbox_item: no name source wired up yet — honestly null.
  // An out-of-visibility entity/document id also lands here (no row matched
  // above), so it resolves to null rather than leaking its title.
  for (const item of items) {
    if (!names.has(item.objectId)) names.set(item.objectId, null);
  }

  return names;
}
