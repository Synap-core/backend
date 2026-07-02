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
  skills,
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
    "First-party in-process Synap operations (Tier-0 builtin verbs), governed and run on the pod. Most need no Intelligence-Service hop; AI-backed verbs (e.g. ai.triage) call the IS internally but still execute in-process, not as an IS-routed skill.",
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
    {
      name: "ai.triage",
      kind: "builtin",
      scope: "pod",
      description:
        "Batch-classify emails (relevance + category + summary) via the IS mail_triage tool. AI-backed builtin used by the mail-feed automation.",
      parameters: {
        type: "object",
        required: ["emails"],
        properties: {
          emails: { type: "array" },
          mutedCategories: { type: "array" },
        },
      },
    },
    {
      name: "output.generate",
      kind: "builtin",
      scope: "pod",
      description:
        "Generate output: place a multi-slide artboard deck (carousel/deck) onto a whiteboard. Emits the same board:place placement the generate_carousel/generate_deck path produces.",
      parameters: {
        type: "object",
        required: ["boardId", "preset", "slides"],
        properties: {
          boardId: { type: "string", format: "uuid" },
          preset: { type: "string" },
          title: { type: "string" },
          slides: {
            type: "array",
            items: {
              type: "object",
              required: ["html"],
              properties: {
                html: { type: "string" },
                title: { type: "string" },
              },
            },
          },
        },
      },
    },
  ],
};

/** The builtin verb NAMES this seeder registers — used by the convergence guard. */
const SYNAP_CORE_SKILL_NAMES = SYNAP_CORE_DEFINITION.skills.map((s) => s.name);

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
    // Convergence guard: skip ONLY when the pod-wide "Synap Core" capability
    // exists AND every builtin verb the current definition declares is already
    // seeded as a pod-wide skill. A pod that predates a newly-added verb (e.g.
    // `output.generate`) is MISSING a skill → fall through and re-run the
    // idempotent applier, which adds only the absent skills (existing ones are a
    // no-op reuse). This lets the seeder converge existing pods, not just fresh ones.
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
      const seededSkills = await db
        .select({ name: skills.name })
        .from(skills)
        .where(
          and(
            isNull(skills.workspaceId),
            inArray(skills.name, SYNAP_CORE_SKILL_NAMES)
          )
        );
      const seededNames = new Set(seededSkills.map((s) => s.name));
      const allPresent = SYNAP_CORE_SKILL_NAMES.every((n) =>
        seededNames.has(n)
      );
      if (allPresent) {
        logger.debug(
          "synap-core capability + all builtin verbs already present — skipping seed"
        );
        return;
      }
      logger.info(
        {
          missing: SYNAP_CORE_SKILL_NAMES.filter((n) => !seededNames.has(n)),
        },
        "synap-core present but missing builtin verb(s) — converging"
      );
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

    // First-party system verbs are trusted by construction (pod-owner seeded) —
    // born approved so the built-in capability is usable without a manual approve
    // step. (Non-instruction skills otherwise default to approved=false.)
    const seededSkillIds = result.created.skills
      .map((s) => s.skillId)
      .filter((id): id is string => Boolean(id));
    if (seededSkillIds.length > 0) {
      await db
        .update(skills)
        .set({ approved: true })
        .where(inArray(skills.id, seededSkillIds));
    }

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
