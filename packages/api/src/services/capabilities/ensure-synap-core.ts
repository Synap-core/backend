/**
 * synap-core bootstrap (W5) — seed the FIRST first-party built-in capability.
 *
 * `synap-core` is a pod-wide capability whose two skills are Tier-0 `builtin`
 * verbs (`channel.create`, `feed.post`). Seeding it proves a first-party op runs
 * in-process through the SAME governed executeCapability path as an external verb,
 * with no Intelligence-Service hop. The verbs' handlers live in `builtin-verbs.ts`;
 * this module only registers the capability + its skill rows so the verbs are
 * discoverable + runnable.
 *
 * Idempotent: the capability is created through the ONE governed creation door
 * (`createCapabilityFromDefinition`, which is itself idempotent per-skill/container),
 * and this function additionally short-circuits when a pod-wide capability named
 * "Synap Core" already exists — so re-running on every boot is a cheap no-op.
 *
 * WIRING: call once at pod startup (after the pod-admin/user invariants), passing
 * nothing — it resolves the pod-owner identity itself. It is intentionally
 * NON-FATAL: a fresh, pre-bootstrap pod (no owner yet) is skipped with a log line,
 * exactly like the other startup seeders.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  isNull,
  inArray,
  capabilities,
  workspaces,
  workspaceMembers,
} from "@synap/database";
import { sql as drizzleSql } from "drizzle-orm";
import type { CapabilityDefinition } from "@synap/playbooks";

import { createCapabilityFromDefinition } from "./create-from-definition.js";
import type { Context } from "../../context.js";

const logger = createLogger({ module: "ensure-synap-core" });

/** The inline definition applied through the governed creation door. */
const SYNAP_CORE_DEFINITION: CapabilityDefinition = {
  key: "synap-core",
  name: "Synap Core",
  description:
    "First-party in-process Synap operations (Tier-0 builtin verbs). Runs on the pod, governed, with no Intelligence-Service hop.",
  tools: [],
  skills: [
    {
      name: "channel.create",
      kind: "builtin",
      scope: "pod",
      description:
        "Create a channel in the acting workspace (delegates to the governed createChannel path).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          agentSlug: { type: "string" },
          parentChannelId: { type: "string", format: "uuid" },
          branchPurpose: { type: "string" },
        },
      },
    },
    {
      name: "feed.post",
      kind: "builtin",
      scope: "pod",
      description:
        "Post a message into a channel; mirrors to a bound Discord channel if present.",
      parameters: {
        type: "object",
        required: ["channelId", "content"],
        properties: {
          channelId: { type: "string", format: "uuid" },
          content: { type: "string" },
        },
      },
    },
  ],
};

/**
 * Resolve the pod-owner user id — the owner/admin member of the pod-admin system
 * workspace. Returns null on a pre-bootstrap pod (no pod-admin workspace / owner),
 * so the caller can skip seeding without failing startup.
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
 * Ensure the `synap-core` built-in capability exists. Safe to call on every boot.
 * Non-fatal: any failure (or a pre-bootstrap pod) is logged and swallowed.
 */
export async function ensureSynapCoreCapability(): Promise<void> {
  try {
    // Guard: skip if a pod-wide capability named "Synap Core" already exists.
    const [existing] = await db
      .select({ id: capabilities.id })
      .from(capabilities)
      .where(
        and(
          eq(capabilities.name, SYNAP_CORE_DEFINITION.name),
          isNull(capabilities.workspaceId)
        )
      )
      .limit(1);
    if (existing) {
      logger.debug("synap-core capability already present — skipping seed");
      return;
    }

    const ownerUserId = await resolvePodOwnerUserId();
    if (!ownerUserId) {
      logger.info(
        "No pod owner yet (pre-bootstrap) — deferring synap-core seed to a later boot"
      );
      return;
    }

    // Pod-scoped capability (all skills scope=pod) → the applier creates skills +
    // container pod-wide (workspace_id NULL); pass a null-workspace operator ctx.
    const ctx = {
      db,
      authenticated: true as const,
      userId: ownerUserId,
      workspaceId: null,
      workspaceRole: "owner",
    } as unknown as Context;

    const result = await createCapabilityFromDefinition(
      SYNAP_CORE_DEFINITION,
      {},
      ctx
    );
    logger.info(
      {
        container: result.created.container?.id,
        skills: result.created.skills.map((s) => s.name),
      },
      "Seeded synap-core built-in capability"
    );
  } catch (err) {
    logger.warn(
      { err },
      "Failed to seed synap-core capability on startup (non-fatal)"
    );
  }
}
