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
  or,
  inArray,
  isNull,
  sql,
  apiKeys,
  proposals,
  EventRepository,
  ApiKeyRepository,
  type ApiKeyScope,
} from "@synap/database";
import { agents, users } from "@synap/database/schema";
import type { AgentMetadata } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
 * Resolve an ACTIVE registry row by its slug — the string the IS calls
 * `agentType` (chat-stream.ts reads a channel's assigned agent and hands its
 * `agents.slug` to the IS as `agentType`; `resolve-or-create-channel.ts`,
 * `personal-channel.ts` and `channels/crud.ts` all do the same slug+active
 * lookup). Returns null for an unknown or deactivated slug so a caller that
 * targets a named agent can FAIL rather than silently dispatch to the default
 * orchestrator.
 */
export async function resolveActiveAgentBySlug(
  slug: string
): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.slug, slug), eq(agents.active, true)))
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
 * Canonical visibility predicate for a caller's OWN user-owned adjunct registry
 * rows. `agents.userId` is the ACTOR (the agent-user), NOT the human owner — so
 * "mine" means the actor was created by me (`users.createdByUserId`), the SAME
 * owner signal the governance scorecards use. Prior code floored on
 * `eq(agents.userId, humanId)`, which never matched for a local adjunct (actor id
 * ≠ human id) → a human could not see their own CLI adjunct. Defined ONCE here so
 * every catalog reader (agents router + object-graph) floors identically. Shared
 * built-ins (ownerType 'system'/'synap'/'provider') are OR'd in by the caller.
 */
export function ownAdjunctFilter(userId: string) {
  return and(
    eq(agents.ownerType, "user"),
    ownAgentUserFilter(agents.userId, userId)
  );
}

/**
 * The AGENT-LINEAGE set: ids of the agent-users a given human created.
 *
 * Split out of `ownAdjunctFilter` for the same reason `memberWorkspaceIds` /
 * `ownedWorkspaceIds` were split out of `userVisibleWhere`
 * (database/src/utils/user-visible-where.ts): the lineage set is needed BOTH as
 * an `agents`-table predicate (the catalog readers) and as a bare id subquery
 * over other tables (`proposals.agentUserId` in the MCP proposal queue and in
 * orient's pending aggregate). One definition, so a floor can never widen on
 * one door and not the other.
 *
 * Both halves matter: `userType = 'agent'` keeps it to agent principals, and
 * `createdByUserId = userId` keeps it to THIS human's agents — it can never
 * admit a teammate's agents, which is the boundary a workspace-membership floor
 * would have crossed.
 */
function ownAgentUserIds(userId: string) {
  return db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.userType, "agent"), eq(users.createdByUserId, userId)));
}

/**
 * The lineage set as a predicate over ANY agent-user column — `agents.userId`
 * for the catalog readers, `proposals.agentUserId` for the MCP proposal queue
 * and orient's pending aggregate. Exported in predicate form (not as the raw
 * subquery) because a `db.select()` builder's inferred type cannot be named
 * outside `@synap/database` (TS2742); the subquery above stays the ONE
 * definition and nothing re-derives it.
 */
export function ownAgentUserFilter(
  agentUserIdColumn: AnyPgColumn,
  userId: string
): SQL {
  return inArray(agentUserIdColumn, ownAgentUserIds(userId));
}

/**
 * "This proposal is MINE" — the authorship floor, as ONE predicate.
 *
 * Three branches, and all three are needed because `proposals.createdBy` is
 * OVERLOADED: it holds the userId **or** the agentUserId that authored the row,
 * depending on which door wrote it.
 *
 *   1. `createdBy = me`                    — I authored it directly.
 *   2. `agentUserId ∈ my agents`           — my agent authored it, attributed.
 *   3. `createdBy ∈ my agents`             — my agent authored it, and the door
 *                                            put the agent id in `createdBy`.
 *
 * This is NOT a workspace widening: there is no membership term, and every
 * branch is floored on THIS user's own lineage, so it can never admit another
 * human's rows (or their agents'). That distinction matters — a
 * workspace-membership branch bolted on here would do exactly that.
 *
 * Extracted because this exact three-branch `or(...)` was already copy-pasted
 * verbatim in `diagnose/global.ts` and `diagnose/index.ts`, and the site that
 * did NOT have it (`diagnose/resolve-object-kind.ts`) was the live bug: the
 * global summary told the user "4 more of yours sit outside your workspace
 * lens", and asking diagnose about one of them answered "no diagnosable
 * object found". One definition, so a lens question and an ownership question
 * can never silently become the same query again.
 */
export function authoredByUser(userId: string): SQL {
  return or(
    eq(proposals.createdBy, userId),
    ownAgentUserFilter(proposals.agentUserId, userId),
    ownAgentUserFilter(proposals.createdBy, userId)
  ) as SQL;
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

/** Minimal logging surface so callers can thread their own logger through. */
interface ProvisionLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Find-or-create a non-personal (service) agent user for **(creatorId, agentType)**.
 *
 * Shared by `createNamedAgent` and `provisionSurfaceAgentKey` so both doors share
 * one insert shape and the same race recovery against
 * `idx_users_service_agent_creator_type_unique` (migration 0228). Concurrent
 * inserts re-select the winning (oldest) singleton.
 *
 * Non-twin service agents always stamp `writesRequireProposal: true` and
 * `kratosIdentityId: null` (agents authenticate on the Hub-key rail, never Kratos).
 */
export async function findOrCreateServiceAgentUser(opts: {
  creatorId: string;
  agentType: string;
  label: string;
  /** Merged into agentMetadata; identity fields (agentType/creator/isPersonal) are forced. */
  metadata?: Partial<AgentMetadata>;
  /**
   * Provenance for the Agent dashboard (`users.created_via`). Defaults to "cli",
   * which is what both original callers (createNamedAgent /
   * provisionSurfaceAgentKey) meant; the IS agent-roster sync passes
   * "intelligence-service" so a synced agent-user is not mislabelled as a CLI
   * adjunct.
   */
  createdVia?: "cli" | "intelligence-service" | "ui" | "system";
  logger?: ProvisionLogger;
}): Promise<{ agentUserId: string; email: string }> {
  const { creatorId, agentType, label, logger } = opts;

  // Deterministic: if a race produced more than one row for this pair, reuse the
  // OLDEST so the singleton is stable across calls.
  const existing = await db.query.users.findFirst({
    where: and(
      eq(users.userType, "agent"),
      eq(users.agentType, agentType),
      eq(users.createdByUserId, creatorId),
      eq(users.isPersonalAgent, false)
    ),
    orderBy: (u, { asc }) => [asc(u.createdAt)],
    columns: { id: true, email: true },
  });

  if (existing) {
    logger?.info(
      { agentUserId: existing.id, agentType, createdByUserId: creatorId },
      "findOrCreateServiceAgentUser: reusing existing agent user for creator×type"
    );
    return { agentUserId: existing.id, email: existing.email };
  }

  const agentUserId = randomUUID();
  const shortId = agentUserId.slice(0, 8);
  const email = `agent-${agentType}-${shortId}@synap.agent`;
  // Defaults first, caller metadata second, identity invariants last (forced).
  const agentMetadata: AgentMetadata = {
    capabilities: [],
    ...opts.metadata,
    agentType,
    createdByUserId: creatorId,
    isPersonalAgent: false,
    // Non-twin service agents always route writes through proposals.
    writesRequireProposal: true,
  };

  try {
    await db.insert(users).values({
      id: agentUserId,
      email,
      name: label,
      emailVerified: true,
      userType: "agent",
      // INVARIANT: an agent NEVER carries a Kratos identity. `kratosIdentityId IS
      // NULL` is the canonical human↔agent discriminator (agents authenticate on
      // the Hub-key rail, not Kratos). Keep this NULL — the tripwire
      // agent-kratos-identity-invariant.test.ts locks it.
      kratosIdentityId: null,
      agentType,
      isPersonalAgent: false,
      createdByUserId: creatorId,
      createdVia: opts.createdVia ?? "cli",
      agentMetadata,
      timezone: "UTC",
      locale: "en",
    });
    logger?.info(
      { agentUserId, agentType, createdByUserId: creatorId },
      "findOrCreateServiceAgentUser: created agent user for creator×type"
    );
    return { agentUserId, email };
  } catch (err) {
    // DB firewall: unique (created_by_user_id, agent_type) for service agents
    // rejects a concurrent insert. Re-resolve the winning singleton and reuse.
    const raced = await db.query.users.findFirst({
      where: and(
        eq(users.userType, "agent"),
        eq(users.agentType, agentType),
        eq(users.createdByUserId, creatorId),
        eq(users.isPersonalAgent, false)
      ),
      orderBy: (u, { asc }) => [asc(u.createdAt)],
      columns: { id: true, email: true },
    });
    if (!raced) throw err;
    logger?.info(
      { agentUserId: raced.id, agentType, createdByUserId: creatorId },
      "findOrCreateServiceAgentUser: lost provision race — reusing existing agent user"
    );
    return { agentUserId: raced.id, email: raced.email };
  }
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
  const { agentUserId, email } = await findOrCreateServiceAgentUser({
    creatorId: opts.createdByUserId,
    agentType: opts.agentType,
    label: opts.name,
  });

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

export interface ProvisionSurfaceAgentKeyOpts {
  /**
   * Agent kind — singleton key together with `createdByUserId`.
   * One agent user per (human creator, agentType); multi-runtime uses
   * `instanceId` on keys, not a second agent user.
   */
  agentType: string;
  /**
   * Human the agent user is attributed to (createdByUserId on the user row).
   * REQUIRED for surface agents — product invariant: one principal per
   * (creator, agentType). Null is rejected (fail closed).
   */
  createdByUserId: string | null;
  /**
   * Human the KEY acts for (key.linkedUserId → auth-middleware agent remap).
   * Empty/null defaults to `createdByUserId`. Still fails closed with
   * `NO_LINKED_HUMAN` if neither resolves — never mints hub_inbound with null.
   */
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
   * OPT-IN — mint a POD-WIDE agent key (`linkedUserId: null`) bound to the
   * agent-user principal itself, rather than to a human it acts for.
   *
   * DEFAULT (omitted/false): fail-closed. `linkedUserId` defaults to the creator
   * and a null-linked hub_inbound key is NEVER minted (silent governance bypass).
   * An accidental null still errors `NO_LINKED_HUMAN`.
   *
   * When `true`: the key is DELIBERATELY minted with `linkedUserId: null`. The
   * `resolveKeyIdentity` resolver (#1a) then derives `agentUserId` from the key
   * owner's `userType==='agent'`, so the write is still GOVERNED — as the agent's
   * OWN principal (`effectiveUserId = linkedUserId ?? userId` = the agent-user),
   * NOT by impersonating the human creator. Org/workspace access is granted via
   * the `workspace.join` proposal flow, not a linked human. `createdByUserId` is
   * still REQUIRED (the agent-user needs a creator for the (creator × agentType)
   * singleton + attribution) — only the KEY's linked human is dropped.
   */
  podWide?: boolean;
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
 * `hub_inbound` key that is a singleton per **(createdByUserId, agentType)**, whose
 * `linkedUserId` is the human it acts for.
 *
 * Aligns with `createNamedAgent` and product rule: one principal per human per
 * surface type. Multi-machine concurrency uses `instanceId` on keys, not a second
 * agent user. Sequence:
 *   1. find-or-create the agent user for (creator, agentType) — race-safe against
 *      the unique index (migration 0228; replaces pod-wide agentType-only 0037).
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

  // Fail closed: without a human creator we cannot enforce (creator, agentType).
  // Callers (setup/agent) must resolve a human before minting.
  if (!createdByUserId || !createdByUserId.trim()) {
    const err = new Error(
      "provisionSurfaceAgentKey: createdByUserId is required (one agent per human × type)"
    );
    (err as Error & { code?: string }).code = "NO_HUMAN_OWNER";
    throw err;
  }
  const creatorId = createdByUserId.trim();

  // Resolve the human the KEY acts for.
  //
  //  • DEFAULT (podWide !== true) — fail closed: hub_inbound agent keys MUST
  //    carry a linked human. Default to the creator when linked is omitted;
  //    never mint with linkedUserId null (silent governance bypass — agent
  //    writes as the operator with no proposal). An accidental null still errors
  //    NO_LINKED_HUMAN (defense-in-depth; unreachable while a creator is present,
  //    which is enforced above).
  //  • OPT-IN (podWide === true) — DELIBERATELY mint with linkedUserId = null.
  //    The key is governed as its OWN agent-user principal (#1a resolveKeyIdentity
  //    derives agentUserId from userType==='agent'), NOT by impersonating the
  //    creator. This is the ONLY path that opens the null-linked door, so an
  //    accidental omission still fails closed.
  let resolvedLinkedUserId: string | null;
  if (opts.podWide === true) {
    resolvedLinkedUserId = null;
  } else {
    resolvedLinkedUserId = (linkedUserId && linkedUserId.trim()) || creatorId;
    if (!resolvedLinkedUserId) {
      const err = new Error(
        "provisionSurfaceAgentKey: linkedUserId is required (agent keys must act for a human)"
      );
      (err as Error & { code?: string }).code = "NO_LINKED_HUMAN";
      throw err;
    }
  }

  // ── 1. Find or create the agent user (singleton per creator × agentType) ─
  const { agentUserId } = await findOrCreateServiceAgentUser({
    creatorId,
    agentType,
    label: agentLabel,
    metadata: {
      description: opts.agentDescription ?? `${agentLabel} — external agent`,
    },
    logger,
  });

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
      linkedUserId: resolvedLinkedUserId,
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
