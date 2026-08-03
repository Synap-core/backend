/**
 * Capture agent bootstrap — seed the FIRST first-party substrate AGENT.
 *
 * "Capture" (text/photo → governed structured entity) is a fundamental pod
 * capability, used by Discord, the app, the extension, and MCP alike. The agent
 * that PERFORMS those capture writes must therefore be substrate — SEEDED +
 * reconciled at boot like `ensureSystemProfiles` / `ensureSynapCoreCapability` —
 * not stapled to any one surface.
 *
 * LEAST-PRIVILEGE BY CONSTRUCTION: this agent auto-approves ONLY capture verbs
 * (`entity.*`, `relation.create`, `document.create`, `focus_session.*`). It has
 * no capability to email, post externally, grant capabilities, or touch config —
 * that narrow capability boundary is exactly what makes auto-approving its
 * writes safe. An agent = a `users` row with `user_type = 'agent'`; this module
 * only ensures that row (+ its agent_metadata) exists and stays converged.
 *
 * WIRING: call once at pod startup, AFTER `ensureSynapCoreCapability()` (a pod
 * owner must already exist so we can attribute the human-owned agent to it).
 * NON-FATAL: a fresh, pre-bootstrap pod (no owner yet) is skipped with a log
 * line and retried on a later boot, exactly like the other startup seeders.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  users,
  workspaces,
  workspaceMembers,
  governanceRules,
  type AgentMetadata,
} from "@synap/database";
import { sql as drizzleSql } from "drizzle-orm";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "ensure-capture-agent" });

/**
 * Declarative definition of the seeded capture agent. The `autoApproveFor` list
 * IS the capability boundary: only these capture verbs execute without a
 * proposal; everything else falls through to the normal governance rungs.
 * Adding a new capture verb here converges existing pods on the next boot
 * (drift-heal below re-projects it onto the seeded agent's agent_metadata).
 */
export const CAPTURE_AGENT_DEF = {
  agentType: "capture",
  name: "Capture",
  description:
    "Fundamental capture agent — performs governed structured writes from captured input (text/photo). Least-privilege: capture verbs only.",
  writesRequireProposal: false,
  autoApproveFor: [
    "entity.create",
    "entity.update",
    "relation.create",
    "document.create",
    "focus_session.create",
    "focus_session.update",
    "focus_session.stage_changed",
  ],
} as const;

/**
 * Module-level cache of the seeded capture agent's userId — populated on the
 * first successful lookup (seed or resolve). `getCaptureAgentUserId` reads it so
 * repeat callers avoid a DB round-trip. Reset only by a process restart.
 */
let cachedCaptureAgentUserId: string | null = null;

/**
 * Resolve the pod-owner user id — the owner/admin member of the pod-admin system
 * workspace. Returns null on a pre-bootstrap pod (no pod-admin workspace / owner),
 * so the caller can skip seeding without failing startup. Mirrors the resolver
 * in `ensure-synap-core.ts`.
 */
async function resolvePodOwnerUserId(): Promise<string | null> {
  const podAdminWs = await db.query.workspaces.findFirst({
    where: drizzleSql`${workspaces.settings}->>'systemSlug' = 'pod-admin'`,
    columns: { id: true },
  });
  if (!podAdminWs) return null;

  const owner = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminWs.id),
      inArray(workspaceMembers.role, ["owner", "admin"])
    ),
    columns: { userId: true },
  });
  return owner?.userId ?? null;
}

/**
 * Find the pod-level capture agent — a pod-wide `users` row (userType='agent',
 * agentType='capture') created by the pod owner. Pod-wide substrate agents carry
 * no workspace membership; they belong to the whole pod. Returns the row's id +
 * current agentMetadata so the caller can drift-heal, or null if not yet seeded.
 */
async function findCaptureAgent(
  ownerUserId: string
): Promise<{ id: string; agentMetadata: AgentMetadata | null } | null> {
  const [row] = await db
    .select({ id: users.id, agentMetadata: users.agentMetadata })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        eq(users.agentType, CAPTURE_AGENT_DEF.agentType),
        eq(users.createdByUserId, ownerUserId)
      )
    )
    .limit(1);
  return row ?? null;
}

/** True when the stored metadata already matches CAPTURE_AGENT_DEF (no heal needed). */
function metadataInSync(meta: AgentMetadata | null): boolean {
  if (!meta) return false;
  if (meta.writesRequireProposal !== CAPTURE_AGENT_DEF.writesRequireProposal) {
    return false;
  }
  const current = [...(meta.autoApproveFor ?? [])].sort();
  const desired = [...CAPTURE_AGENT_DEF.autoApproveFor].sort();
  if (current.length !== desired.length) return false;
  return current.every((v, i) => v === desired[i]);
}

const GOVERNANCE_RULES_CREATED_BY = "system:ensure-capture-agent";

/**
 * Mirror CAPTURE_AGENT_DEF.autoApproveFor into `governance_rules` (Governance
 * Convergence Plan, Phase B one-store) — agent-scoped, pod-wide rows, one per
 * verb. Idempotent: only inserts patterns not already covered by an ACTIVE
 * rule for this agent, so this is safe to call on every boot regardless of
 * whether the agent row itself was just created, drift-healed, or already in
 * sync — a pod upgrading onto this wave may have agent_metadata already
 * correct but no rules seeded yet.
 */
async function syncCaptureAgentGovernanceRules(agentId: string): Promise<void> {
  const existing = await db
    .select({ targetPattern: governanceRules.targetPattern })
    .from(governanceRules)
    .where(
      and(
        isNull(governanceRules.revokedAt),
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.scopeKind, "pod"),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.agentUserId, agentId)
      )
    );
  const existingPatterns = new Set(existing.map((r) => r.targetPattern));
  const toInsert = CAPTURE_AGENT_DEF.autoApproveFor.filter(
    (pattern) => !existingPatterns.has(pattern)
  );
  if (toInsert.length === 0) return;

  await db.insert(governanceRules).values(
    toInsert.map((targetPattern) => ({
      principalKind: "agent" as const,
      scopeKind: "pod" as const,
      agentUserId: agentId,
      targetKind: "action" as const,
      targetPattern,
      verdict: "auto" as const,
      createdBy: GOVERNANCE_RULES_CREATED_BY,
    }))
  );
  logger.info(
    { agentId, inserted: toInsert.length },
    "Seeded capture agent governance_rules (Phase B one-store)"
  );
}

/**
 * Ensure the pod-level capture agent exists. Safe to call on every boot.
 * Idempotent + reconciling (mirrors `ensureSynapCoreCapability`'s convergence
 * style): MISSING → create the human-owned agent row; EXISTS but drifted (a pod
 * that predates a newly-added capture verb) → drift-heal its agent_metadata to
 * CAPTURE_AGENT_DEF. Non-fatal: any failure (or a pre-bootstrap pod) is logged
 * and swallowed.
 */
export async function ensureCaptureAgent(): Promise<void> {
  try {
    const ownerUserId = await resolvePodOwnerUserId();
    if (!ownerUserId) {
      logger.info(
        "No pod owner yet (pre-bootstrap) — deferring capture-agent seed to a later boot"
      );
      return;
    }

    const existing = await findCaptureAgent(ownerUserId);

    if (existing) {
      cachedCaptureAgentUserId = existing.id;

      // Convergence guard: skip when the seeded agent's governance metadata
      // already matches the definition. A pod that predates a newly-added
      // capture verb is out of sync → fall through and re-project the metadata
      // so the auto-approve boundary converges on the current definition.
      if (metadataInSync(existing.agentMetadata)) {
        logger.debug(
          "Capture agent present and metadata in sync — skipping seed"
        );
        // Metadata is converged, but a pod upgrading onto Phase B may not
        // have any governance_rules rows yet — the idempotent sync below
        // no-ops once seeded.
        await syncCaptureAgentGovernanceRules(existing.id);
        return;
      }

      const healed: AgentMetadata = {
        ...(existing.agentMetadata ?? {
          agentType: CAPTURE_AGENT_DEF.agentType,
          createdByUserId: ownerUserId,
        }),
        agentType: CAPTURE_AGENT_DEF.agentType,
        description: CAPTURE_AGENT_DEF.description,
        createdByUserId: ownerUserId,
        isPersonalAgent: false,
        writesRequireProposal: CAPTURE_AGENT_DEF.writesRequireProposal,
        autoApproveFor: [...CAPTURE_AGENT_DEF.autoApproveFor],
      };

      await db
        .update(users)
        .set({ agentMetadata: healed, updatedAt: new Date() })
        .where(eq(users.id, existing.id));

      logger.info(
        { agentId: existing.id },
        "Drift-healed capture agent governance metadata to CAPTURE_AGENT_DEF"
      );
      await syncCaptureAgentGovernanceRules(existing.id);
      return;
    }

    // MISSING → create the pod-wide, human-owned capture agent. Mirrors the
    // canonical agent-user insert in `routers/agent-users.ts` (users row +
    // promoted agent-identity columns + dual-written agent_metadata), minus a
    // workspace membership: substrate agents are pod-wide, not workspace-tied.
    const agentId = randomUUID();
    const shortId = agentId.slice(0, 8);
    const email = `agent-${CAPTURE_AGENT_DEF.agentType}-${shortId}@synap.agent`;

    const agentMetadata: AgentMetadata = {
      agentType: CAPTURE_AGENT_DEF.agentType,
      description: CAPTURE_AGENT_DEF.description,
      createdByUserId: ownerUserId,
      isPersonalAgent: false,
      writesRequireProposal: CAPTURE_AGENT_DEF.writesRequireProposal,
      autoApproveFor: [...CAPTURE_AGENT_DEF.autoApproveFor],
    };

    await db.insert(users).values({
      id: agentId,
      email,
      name: CAPTURE_AGENT_DEF.name,
      emailVerified: true,
      userType: "agent",
      createdVia: "system",
      agentMetadata,
      // Dual-write: mirror agent-identity fields to real columns (migration 0038).
      agentType: CAPTURE_AGENT_DEF.agentType,
      createdByUserId: ownerUserId,
      isPersonalAgent: false,
      timezone: "UTC",
      locale: "en",
    });

    cachedCaptureAgentUserId = agentId;

    await syncCaptureAgentGovernanceRules(agentId);

    logger.info(
      { agentId, autoApproveFor: CAPTURE_AGENT_DEF.autoApproveFor },
      "Seeded capture agent (pod-wide, human-owned, least-privilege)"
    );
  } catch (err) {
    logger.warn({ err }, "Failed to seed capture agent on startup (non-fatal)");
  }
}

/**
 * Resolve the seeded capture agent's userId — the seam a second agent imports to
 * ATTRIBUTE capture writes. Returns the cached id after the first lookup, or
 * queries the pod-level capture agent row; null when not seeded (pre-bootstrap
 * pod, or `ensureCaptureAgent` has not yet run).
 */
export async function getCaptureAgentUserId(): Promise<string | null> {
  if (cachedCaptureAgentUserId) return cachedCaptureAgentUserId;

  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        eq(users.agentType, CAPTURE_AGENT_DEF.agentType)
      )
    )
    .limit(1);

  cachedCaptureAgentUserId = row?.id ?? null;
  return cachedCaptureAgentUserId;
}
