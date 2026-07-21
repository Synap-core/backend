/**
 * Agent Identity Service
 *
 * Contracts the two agent representations: the `agents` REGISTRY row (capabilities,
 * routing) and the optional `users` (userType='agent') row (authorship, permissions),
 * linked 1:1 via `agents.userId`. The user row is optional — autonomous agents
 * (e.g. cron workers) need only the registry row, so resolveAgentUser returns null
 * gracefully when no user row is linked.
 *
 * Authorship: 'delegated' when a human triggered the action, else 'autonomous'.
 */

import {
  db,
  eq,
  and,
  sql,
  EventRepository,
  ApiKeyRepository,
} from "@synap/database";
import { agents, users } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createAndVerifyHubInboundKey } from "./external-registration.js";
import {
  AGENT_KEY_TTL_DAYS,
  AGENT_KEY_ROTATION_LEAD_DAYS,
} from "./hub-integration-registration.js";

type AgentRow = typeof agents.$inferSelect;
type UserRow = typeof users.$inferSelect;

export type AuthorshipMode = "autonomous" | "delegated";

/** Fetch a registry row by id (or null). */
export async function getAgentById(agentId: string): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the agent's linked user row (authorship/permission identity), or null
 * when the agent has no user identity (autonomous-only registry agent).
 */
export async function resolveAgentUser(
  agentId: string
): Promise<UserRow | null> {
  const agent = await getAgentById(agentId);
  if (!agent?.userId) return null;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, agent.userId))
    .limit(1);
  return user ?? null;
}

/** Whether a registry agent has a paired user identity. */
export async function hasUserIdentity(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  return Boolean(agent?.userId);
}

/**
 * Populate the 1:1 registry↔user link (agents.userId). Intended to be called
 * from the agent / agent-user creation flows; not yet wired there.
 */
export async function linkAgentToUser(
  agentId: string,
  userId: string
): Promise<void> {
  await db
    .update(agents)
    .set({ userId, updatedAt: new Date() })
    .where(eq(agents.id, agentId));
}

/**
 * Derive the authorship mode for a mutation/proposal.
 * - null      → no agent involved (a human acted directly)
 * - delegated → an agent acted because a (different) human triggered it
 * - autonomous→ an agent acted on its own
 */
export function deriveAuthorshipMode(
  callingUserId: string | undefined,
  agentUserId: string | undefined
): AuthorshipMode | null {
  if (!agentUserId) return null;
  if (callingUserId && callingUserId !== agentUserId) return "delegated";
  return "autonomous";
}

/**
 * Ensure a managed `agents` registry row exists for a local/CLI adjunct,
 * linked 1:1 to its agent-user via `agents.userId`.
 *
 * Idempotent by `agents.userId`: if a row already exists for this agent-user we
 * leave it alone (only backfilling `userId` is not needed — we look it up by it).
 * The row is `ownerType:'user'`, `metadata.kind:'local'`, and carries the CLI
 * command (`metadata.agentCommand`) so the renderer can route a selected/mentioned
 * adjunct to its terminal-cell. The slug is keyed on the agent-user id so it is
 * stable and never collides with another user's same-typed adjunct under the
 * `(intelligenceServiceId, slug)` unique index (intelligenceServiceId is null here).
 */
async function ensureLocalAdjunctRegistryRow(opts: {
  agentUserId: string;
  name: string;
  agentType: string;
}): Promise<void> {
  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.userId, opts.agentUserId))
    .limit(1);
  if (existing.length > 0) return;

  // The CLI command is the first token of the agentType (e.g. "claude" from a
  // "claude" agentType); falls back to the agentType itself.
  const agentCommand = opts.agentType.split(/\s/)[0] || opts.agentType;
  const slug = `local:${opts.agentUserId.slice(0, 8)}`;

  await db.insert(agents).values({
    id: randomUUID(),
    name: opts.name,
    slug,
    description: `Local agent adjunct (${agentCommand})`,
    ownerType: "user",
    userId: opts.agentUserId,
    active: true,
    metadata: {
      kind: "local",
      agentCommand,
      agentType: opts.agentType,
    },
  });
}

export interface CreateNamedAgentResult {
  agentUserId: string;
  email: string;
  /** Plaintext Hub Protocol API key — shown once, never retrievable. */
  apiKey: string;
}

/**
 * Creates a named agent user (userType="agent") and issues a Hub Protocol
 * API key for it. Idempotent by (agentType + createdByUserId): if an agent
 * of the same type already exists for this user, a fresh key is issued for
 * the existing agent rather than creating a duplicate.
 *
 * The key's `linkedUserId` is set to `createdByUserId` so the Hub Protocol
 * middleware can auto-inject `agentUserId` for proposal attribution.
 */
export async function createNamedAgent(opts: {
  name: string;
  agentType: string;
  createdByUserId: string;
}): Promise<CreateNamedAgentResult> {
  // Idempotent lookup: reuse existing agent of same type for this user
  const [existing] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.createdByUserId, opts.createdByUserId),
        eq(users.userType, "agent"),
        eq(users.agentType, opts.agentType),
        eq(users.isPersonalAgent, false)
      )
    )
    .limit(1);

  let agentUserId: string;
  let email: string;

  if (existing) {
    agentUserId = existing.id;
    email = existing.email;
  } else {
    agentUserId = randomUUID();
    const shortId = agentUserId.slice(0, 8);
    email = `agent-${opts.agentType}-${shortId}@synap.agent`;

    await db.insert(users).values({
      id: agentUserId,
      email,
      name: opts.name,
      userType: "agent",
      agentType: opts.agentType,
      isPersonalAgent: false,
      createdByUserId: opts.createdByUserId,
      agentMetadata: {
        agentType: opts.agentType,
        createdByUserId: opts.createdByUserId,
        isPersonalAgent: false,
      },
      // INVARIANT: an agent NEVER carries a Kratos identity. `kratosIdentityId IS
      // NULL` is the canonical human↔agent discriminator (agents authenticate on
      // the Hub-key rail, not Kratos). The federated user-sign-in rework keys human
      // identity off a non-null kratosIdentityId, so a sentinel like `agent:${id}`
      // here would mis-classify the agent as a Kratos human. Keep this NULL — the
      // tripwire agent-kratos-identity-invariant.test.ts locks it.
      kratosIdentityId: null,
    });
  }

  // Ensure a managed REGISTRY row exists for this agent-user so it appears as a
  // first-class ADJUNCT in the agent picker / management UI (agents.workspaceList
  // now surfaces ownerType:'user' rows). Local CLI adjuncts (claude/codex/…) are
  // HUB CLIENTS invoked client-side — the registry row links to the agent-user
  // and carries kind:'local' + the CLI command so the UI can route a turn to the
  // terminal-cell (Option A). Idempotent: keyed on (ownerType:'user' + slug), and
  // re-linked if a row already exists for this user but isn't yet linked.
  await ensureLocalAdjunctRegistryRow({
    agentUserId,
    name: opts.name,
    agentType: opts.agentType,
  });

  // Issue a fresh Hub Protocol key via the CANONICAL mint+verify primitive — the
  // same one /api/hub/setup/agent uses (bounded TTL + O(1) keyLookupHash +
  // immediate self-verify). This replaces a prior bcrypt-only insert that had no
  // lookup hash (so it could not be O(1)-verified by the inbound middleware), no
  // TTL, and no post-mint verification. Scope is left unchanged ([read, write]) —
  // this wave hardens the mint, it does not broaden the agent's privileges.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const eventRepo = new EventRepository(sql);
  const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
  const registration = await createAndVerifyHubInboundKey(
    apiKeyRepo,
    {
      keyName: opts.name,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      userId: agentUserId,
      keyType: "hub_inbound",
      description: `Hub Protocol auth token for ${opts.name} (${opts.agentType}) agent`,
      linkedUserId: opts.createdByUserId,
      expiresAt: new Date(nowMs + AGENT_KEY_TTL_DAYS * DAY_MS),
      rotationScheduledAt: new Date(
        nowMs + (AGENT_KEY_TTL_DAYS - AGENT_KEY_ROTATION_LEAD_DAYS) * DAY_MS
      ),
    },
    opts.createdByUserId,
    agentUserId
  );

  if (registration.outcome !== "CONNECTED_VERIFIED") {
    throw new Error(
      `Agent key mint failed verification: ${registration.verificationError ?? registration.outcome}`
    );
  }

  return { agentUserId, email, apiKey: registration.plainKey };
}
