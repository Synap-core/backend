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
  isNull,
  sql,
  apiKeys,
  EventRepository,
  ApiKeyRepository,
  type ApiKeyScope,
} from "@synap/database";
import { agents, users } from "@synap/database/schema";
import type { AgentMetadata } from "@synap/database/schema";
import { randomUUID } from "crypto";
import {
  createAndVerifyHubInboundKey,
  type RegistrationResult,
} from "./external-registration.js";
import {
  AGENT_KEY_TTL_DAYS,
  AGENT_KEY_ROTATION_LEAD_DAYS,
  SETUP_AGENT_HUB_SCOPES,
  revokeActiveHubInboundKeysForUser,
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
 * WORKSPACE-PLACEMENT-AGENT-FOCUS-PLAN.md, Layer 2 (advisory slice).
 *
 * Read the agent-user's live runtime workspace focus (`agentMetadata.focusWorkspaceId`).
 * LIVE, not cached — the whole point of the design is that
 * `synap_set_workspace_focus` can flip it between calls with no key/provisioning
 * round-trip. Returns null when the agent has no user row, no agentMetadata, or
 * no focus set — every caller treats null as "no advisory default", never an error.
 */
export async function getAgentFocusWorkspaceId(
  agentUserId: string
): Promise<string | null> {
  const [row] = await db
    .select({ agentMetadata: users.agentMetadata })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  const meta = row?.agentMetadata as AgentMetadata | null | undefined;
  return meta?.focusWorkspaceId ?? null;
}

/**
 * Set or clear the agent-user's runtime workspace focus. `workspaceId: null`
 * clears it (the tool's "use no workspace until further notice" path).
 * Dual-write-safe: merges into whatever `agentMetadata` JSONB already holds
 * (autoApproveFor, writesRequireProposal, …) rather than overwriting the column.
 * `.set()` on a JSONB column MUST use `drizzleSql` per repo convention, but this
 * is a plain object literal (no `sql` tag needed) since we read-modify-write the
 * whole JS object through drizzle's `$type<AgentMetadata | null>()`.
 */
export async function setAgentFocusWorkspace(
  agentUserId: string,
  workspaceId: string | null
): Promise<void> {
  const [row] = await db
    .select({ agentMetadata: users.agentMetadata })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  const current = (row?.agentMetadata as AgentMetadata | null | undefined) ?? {
    agentType: "unknown",
    createdByUserId: agentUserId,
  };
  const next: AgentMetadata = { ...current };
  if (workspaceId) {
    next.focusWorkspaceId = workspaceId;
    next.focusMode = "advisory";
  } else {
    delete next.focusWorkspaceId;
    delete next.focusMode;
  }
  await db
    .update(users)
    .set({ agentMetadata: next })
    .where(eq(users.id, agentUserId));
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
export async function ensureLocalAdjunctRegistryRow(opts: {
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
    // Set explicitly: the live `agents.capabilities` column is NOT NULL, but the
    // drizzle schema declares it `.array().default([])` (nullable-with-default) —
    // a drift, so omitting it emits DEFAULT → NULL → not-null violation (500 on
    // every /setup/agent surface provision). An explicit [] is drift-proof.
    capabilities: [],
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
      createdVia: "cli",
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

/** Minimal logging surface so callers can thread their own logger through. */
interface ProvisionLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface ProvisionSurfaceAgentKeyOpts {
  /** Agent kind — pod-wide-singleton key. A row is reused across calls. */
  agentType: string;
  /** Human the agent user is attributed to (createdByUserId on the user row). */
  createdByUserId: string | null;
  /** Human the KEY acts for (key.linkedUserId → auth-middleware agent remap). */
  linkedUserId: string | null;
  /** Per-runtime instance label; scopes the sibling-revoke + idempotency check. */
  instanceId?: string | null;
  /** Hub scopes to grant (default: SETUP_AGENT_HUB_SCOPES). */
  scopes?: readonly ApiKeyScope[];
  /** Display name for the agent user + key (default: capitalized agentType). */
  agentLabel?: string;
  /** Optional integration hub id for the key (issuer-managed flows). */
  hubId?: string;
  /** Key TTL in days (default: AGENT_KEY_TTL_DAYS). */
  ttlDays?: number;
  /** Rotation lead in days before expiry (default: AGENT_KEY_ROTATION_LEAD_DAYS). */
  rotationLeadDays?: number;
  /** Also provision an `agents` registry row (local CLI adjunct). Default false. */
  ensureRegistryRow?: boolean;
  /** agentMetadata.description on the agent user row. */
  agentDescription?: string;
  /** description column on the minted key. */
  keyDescription?: string;
  /** Key display name (default: `${agentLabel} Hub Key`). */
  keyName?: string;
  /**
   * Idempotency: when true, if a live (non-revoked) hub_inbound key already exists
   * for this agent-user (scoped to instanceId when set), skip revoke+mint and
   * return `{ alreadyValid: true }`.
   */
  idempotent?: boolean;
  /**
   * Hook invoked once the agent-user is resolved/created and (optionally) its
   * registry row ensured, BEFORE the idempotency check and revoke+mint. The
   * setup/agent endpoint uses it to grant workspace membership at the exact point
   * it did inline.
   */
  onAgentUserResolved?: (agentUserId: string) => Promise<void>;
  logger?: ProvisionLogger;
}

export type ProvisionSurfaceAgentKeyResult =
  | { agentUserId: string; alreadyValid: true; registration?: undefined }
  | {
      agentUserId: string;
      alreadyValid?: false;
      registration: RegistrationResult;
      apiKey: RegistrationResult["apiKey"];
      plainKey: string;
      keyId: string;
    };

/**
 * Provision a SURFACE AGENT Hub key — the ONE door for minting an agent-user-owned
 * `hub_inbound` key that is a pod-wide singleton per `agentType`, whose
 * `linkedUserId` is the human it acts for.
 *
 * Extracted verbatim (in effect) from the inline body of POST /api/hub/setup/agent
 * so other flows (e.g. the CP-MCP pod-accept gate) mint the SAME way. Sequence:
 *   1. find-or-create the agent user — deterministic OLDEST-wins dedup, with the
 *      provisioning-race catch on the `0037_users_agent_singleton_unique` index
 *      (a concurrent insert is caught and the existing row reused, never thrown).
 *   2. optionally ensure the `agents` registry row (local CLI adjunct).
 *   3. `onAgentUserResolved` hook (caller-specific side effects — e.g. workspace
 *      membership) BEFORE the idempotency check and revoke+mint.
 *   4. idempotent short-circuit (when opts.idempotent) — a live key exists → return.
 *   5. instance-aware sibling revoke, then mint+verify via the canonical primitive.
 */
export async function provisionSurfaceAgentKey(
  opts: ProvisionSurfaceAgentKeyOpts
): Promise<ProvisionSurfaceAgentKeyResult> {
  const {
    agentType,
    createdByUserId,
    linkedUserId,
    instanceId,
    onAgentUserResolved,
    logger,
  } = opts;
  const agentLabel =
    opts.agentLabel ?? agentType.charAt(0).toUpperCase() + agentType.slice(1);
  const scopes = opts.scopes ?? SETUP_AGENT_HUB_SCOPES;
  const ttlDays = opts.ttlDays ?? AGENT_KEY_TTL_DAYS;
  const rotationLeadDays =
    opts.rotationLeadDays ?? AGENT_KEY_ROTATION_LEAD_DAYS;

  // ── 1. Find or create the agent user (pod-wide singleton per agentType) ─
  // Deterministic: if a provisioning race ever produced more than one row for
  // this agentType, always reuse the OLDEST so the singleton is stable and the
  // dedup never flip-flops between rows across calls.
  const existingAgent = await db.query.users.findFirst({
    where: and(eq(users.userType, "agent"), eq(users.agentType, agentType)),
    orderBy: (u, { asc }) => [asc(u.createdAt)],
    columns: { id: true },
  });

  let agentUserId: string;

  if (existingAgent) {
    agentUserId = existingAgent.id;
    logger?.info(
      { agentUserId, agentType },
      "provisionSurfaceAgentKey: reusing existing agent user"
    );
  } else {
    agentUserId = randomUUID();
    const shortId = agentUserId.slice(0, 8);
    try {
      await db.insert(users).values({
        id: agentUserId,
        email: `agent-${agentType}-${shortId}@synap.agent`,
        name: agentLabel,
        emailVerified: true,
        userType: "agent",
        kratosIdentityId: null,
        agentType,
        isPersonalAgent: false,
        createdByUserId: createdByUserId ?? null,
        createdVia: "cli",
        agentMetadata: {
          agentType,
          description:
            opts.agentDescription ?? `${agentLabel} — external agent`,
          createdByUserId: createdByUserId ?? agentUserId,
          isPersonalAgent: false,
          writesRequireProposal: true,
          capabilities: [],
        },
        timezone: "UTC",
        locale: "en",
      });
      logger?.info(
        { agentUserId, agentType },
        "provisionSurfaceAgentKey: created agent user"
      );
    } catch (err) {
      // DB firewall: a partial unique index on (agentType) for service agents
      // rejects a concurrent insert. Re-resolve the winning singleton and reuse
      // it. If nothing matches, the error wasn't a dedup race — re-throw.
      const raced = await db.query.users.findFirst({
        where: and(eq(users.userType, "agent"), eq(users.agentType, agentType)),
        orderBy: (u, { asc }) => [asc(u.createdAt)],
        columns: { id: true },
      });
      if (!raced) throw err;
      agentUserId = raced.id;
      logger?.info(
        { agentUserId, agentType },
        "provisionSurfaceAgentKey: lost provision race — reusing existing agent user"
      );
    }
  }

  // ── 2. Managed registry row for LOCAL surface agents (observability) ────
  if (opts.ensureRegistryRow) {
    await ensureLocalAdjunctRegistryRow({
      agentUserId,
      name: agentLabel,
      agentType,
    });
  }

  // ── 3. Caller-specific side effects at the same point they ran inline ───
  if (onAgentUserResolved) {
    await onAgentUserResolved(agentUserId);
  }

  // ── 4. Idempotent short-circuit ─────────────────────────────────────────
  // When requested, skip revoke+mint if a valid (non-revoked) key already
  // exists — scoped to THIS instance when instanceId is set.
  if (opts.idempotent === true) {
    const existingKey = await db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.userId, agentUserId),
        eq(apiKeys.keyType, "hub_inbound"),
        isNull(apiKeys.revokedAt),
        instanceId ? eq(apiKeys.instanceId, instanceId) : undefined
      ),
      columns: { id: true },
    });
    if (existingKey) {
      logger?.info(
        { agentUserId, agentType, keyId: existingKey.id },
        "provisionSurfaceAgentKey: idempotent — valid key exists, skipping revoke+mint"
      );
      return { agentUserId, alreadyValid: true };
    }
  }

  // ── 5. Revoke siblings, then mint+verify ────────────────────────────────
  await revokeActiveHubInboundKeysForUser(db, {
    userId: agentUserId,
    revokedBy: agentUserId,
    revokedReason: "Re-provisioning — replaced by new key via setup/agent",
    // Instance mode rotates only THIS runtime's key; legacy mode (undefined)
    // revokes all siblings so exactly one key stays live.
    instanceId: instanceId ?? undefined,
  });

  // Agent hub keys carry a bounded lifetime; rotationScheduledAt flags the key
  // for the rotation-check cron a fixed lead before it expires. Only NEW mints
  // get an expiry.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const eventRepo = new EventRepository(sql);
  const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
  const registration = await createAndVerifyHubInboundKey(
    apiKeyRepo,
    {
      keyName: opts.keyName ?? `${agentLabel} Hub Key`,
      hubId: opts.hubId,
      scope: [...scopes],
      userId: agentUserId,
      keyType: "hub_inbound",
      description:
        opts.keyDescription ??
        `Hub Protocol auth token for ${agentLabel} agent`,
      linkedUserId: linkedUserId ?? null,
      instanceId: instanceId ?? null,
      expiresAt: new Date(nowMs + ttlDays * DAY_MS),
      rotationScheduledAt: new Date(
        nowMs + (ttlDays - rotationLeadDays) * DAY_MS
      ),
    },
    agentUserId,
    agentUserId
  );

  return {
    agentUserId,
    registration,
    apiKey: registration.apiKey,
    plainKey: registration.plainKey,
    keyId: registration.apiKey.id,
  };
}
