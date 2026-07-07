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

/**
 * Deterministic JSON with recursively sorted object keys — for comparing a
 * jsonb-stored value (whose key order Postgres normalizes) against a code object
 * without reporting false drift on key ordering alone.
 */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(sort(value ?? null));
}

/** The inline definition applied through the governed creation door. */
export const SYNAP_CORE_DEFINITION: CapabilityDefinition = {
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
          metadata: { type: "object" },
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
          metadata: { type: "object" },
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
      name: "ai.generate",
      kind: "builtin",
      scope: "pod",
      description:
        "Synchronous single-shot LLM completion via the IS generate tool. Returns the raw text, or (when json:true) the parsed JSON object — stored flat as the automation step's output, so downstream nodes read steps.<id>.output.<field> (one .output, same rule for every node). Read-only (pure compute, no mutation): auto-runs inside an automation without a proposal.",
      parameters: {
        type: "object",
        required: ["prompt"],
        properties: {
          system: {
            type: "string",
            description: "Optional system instruction.",
          },
          prompt: {
            type: "string",
            description:
              "The user prompt (fenced as untrusted content IS-side).",
          },
          json: {
            type: "boolean",
            description:
              "When true, parse the model output as JSON and return the object as `output`.",
          },
          maxTokens: {
            type: "number",
            minimum: 1,
            maximum: 2000,
            description: "Completion token cap (default 800).",
          },
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
          options: { type: "object" },
        },
      },
    },
    // ── Read/resolve half (W6) — GENERIC primitives (no feature/CRM logic) ──────
    {
      name: "entity.query",
      kind: "builtin",
      scope: "pod",
      description:
        "READ entities of a profile, scoped to the caller's floor. Optional JSONB property-equality filter and workspace lens. Returns { entities[], count }. Read-only: auto-runs, scoped by the access layer.",
      parameters: {
        type: "object",
        required: ["profileSlug"],
        properties: {
          profileSlug: { type: "string" },
          filter: {
            type: "object",
            description: "Property equality pairs { key: value } (JSONB ->>).",
          },
          workspaceId: { type: "string", format: "uuid" },
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
      },
    },
    {
      name: "channel.resolve",
      kind: "builtin",
      scope: "pod",
      description:
        "READ the channel(s) bound to a context object, optionally filtered by channelType and/or branchPurpose (both PARAMETERS — no assumption about which is 'the client channel'). Pass branchPurpose:'team' to resolve the firewall-safe team channel. Returns { channelId|null, channels[] }. Read-only. A client-comms result must never be used as a post target (the firewall blocks it).",
      parameters: {
        type: "object",
        required: ["contextObjectType", "contextObjectId"],
        properties: {
          contextObjectType: { type: "string" },
          contextObjectId: { type: "string", format: "uuid" },
          channelType: { type: "string" },
          branchPurpose: { type: "string" },
        },
      },
    },
    {
      name: "channel.ensure",
      kind: "builtin",
      scope: "pod",
      description:
        "Find-or-create a THREAD channel bound to a context object (governed find-or-create; membership-checked). Returns { channelId, created }.",
      parameters: {
        type: "object",
        required: ["contextObjectType", "contextObjectId"],
        properties: {
          contextObjectType: { type: "string" },
          contextObjectId: { type: "string", format: "uuid" },
          title: { type: "string" },
          agentSlug: { type: "string" },
        },
      },
    },
    {
      name: "channel.bind",
      kind: "builtin",
      scope: "pod",
      description:
        "Bind an ALREADY-EXISTING channel to a context object (inbound-first case). Delegates to the governed updateChannel path (ownership + membership checked); passes branchPurpose (firewall role) through. Returns { bound, channelId }. Sets a binding only — never posts.",
      parameters: {
        type: "object",
        required: ["channelId", "contextObjectType", "contextObjectId"],
        properties: {
          channelId: { type: "string", format: "uuid" },
          contextObjectType: { type: "string" },
          contextObjectId: { type: "string", format: "uuid" },
          branchPurpose: { type: "string" },
        },
      },
    },
    {
      name: "graph.relations",
      kind: "builtin",
      scope: "pod",
      description:
        "READ typed relation edges touching an entity (direction outbound|inbound|both, optional relationType filter), scoped to the caller's floor. Returns { relations[] }. Read-only.",
      parameters: {
        type: "object",
        required: ["entityId"],
        properties: {
          entityId: { type: "string", format: "uuid" },
          direction: { type: "string", enum: ["outbound", "inbound", "both"] },
          relationType: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 200 },
        },
      },
    },
    {
      name: "graph.link",
      kind: "builtin",
      scope: "pod",
      description:
        "Create a typed relation between two entities via the governed relations.create path (checkPermissionOrPropose). May return a proposal. Returns { linked }.",
      parameters: {
        type: "object",
        required: ["fromEntityId", "toEntityId", "relationType"],
        properties: {
          fromEntityId: { type: "string", format: "uuid" },
          toEntityId: { type: "string", format: "uuid" },
          relationType: { type: "string" },
        },
      },
    },
    {
      name: "feed.read",
      kind: "builtin",
      scope: "pod",
      description:
        "READ a channel's messages (chronological). Resolve by explicit channelId or by subjectEntityId (most-recent bound channel). Channel visibility enforced through the access layer before any read. Returns { messages[], channelId }. Read-only.",
      parameters: {
        type: "object",
        properties: {
          channelId: { type: "string", format: "uuid" },
          subjectEntityId: { type: "string", format: "uuid" },
          limit: { type: "number", minimum: 1, maximum: 200 },
        },
      },
    },
    // ── Entity/document write + read half (Spine-2) ─────────────────────────
    {
      name: "entity.create",
      kind: "builtin",
      scope: "pod",
      description:
        "Create an entity via the governed entities.create path (checkPermissionOrPropose). May return a proposal. Returns the created entity or { status: 'proposed', proposalId }.",
      parameters: {
        type: "object",
        required: ["profileSlug", "title"],
        properties: {
          profileSlug: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          properties: { type: "object" },
          workspaceId: { type: "string", format: "uuid" },
        },
      },
    },
    {
      name: "entity.update",
      kind: "builtin",
      scope: "pod",
      description:
        "Update an entity via the governed entities.update path (checkPermissionOrPropose). May return a proposal. Returns the updated entity or { status: 'proposed', proposalId }.",
      parameters: {
        type: "object",
        required: ["entityId"],
        properties: {
          entityId: { type: "string", format: "uuid" },
          title: { type: "string" },
          description: { type: "string" },
          properties: { type: "object" },
        },
      },
    },
    {
      name: "document.create",
      kind: "builtin",
      scope: "pod",
      description:
        "Create a document in the acting workspace via the governed documents.create path.",
      parameters: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          content: { type: "string" },
        },
      },
    },
    {
      name: "document.update",
      kind: "builtin",
      scope: "pod",
      description:
        "Update a document via the governed documents.update path (owner-gated).",
      parameters: {
        type: "object",
        required: ["documentId"],
        properties: {
          documentId: { type: "string" },
          content: { type: "string" },
          title: { type: "string" },
        },
      },
    },
    {
      name: "document.read",
      kind: "builtin",
      scope: "pod",
      description:
        "READ a document's metadata by id, scoped to the caller's floor. Returns { document }. Read-only.",
      parameters: {
        type: "object",
        required: ["documentId"],
        properties: {
          documentId: { type: "string" },
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
        .select({ name: skills.name, parameters: skills.parameters })
        .from(skills)
        .where(
          and(
            isNull(skills.workspaceId),
            inArray(skills.name, SYNAP_CORE_SKILL_NAMES)
          )
        );
      const seededByName = new Map(seededSkills.map((s) => [s.name, s]));
      const missing = SYNAP_CORE_SKILL_NAMES.filter(
        (n) => !seededByName.has(n)
      );
      // Definition-drift detection: a seeded verb whose stored `parameters`
      // differ from the code definition (the catalog "lying" — e.g. a param was
      // added in code but the name-only guard never re-projected it). Falling
      // through re-runs the (now field-refreshing) applier, which self-heals the
      // catalog — no manual backfill migration needed.
      const drifted = SYNAP_CORE_DEFINITION.skills
        .filter((codeSkill) => {
          const seeded = seededByName.get(codeSkill.name);
          if (!seeded) return false; // absence handled by `missing`
          // Canonical (key-sorted) compare: jsonb does NOT preserve insertion
          // order, so a plain JSON.stringify would report false drift on key
          // order alone → re-applying every boot. Sorting keys makes it
          // order-insensitive so we only re-project on a REAL param change.
          // Normalize absent params to {} on BOTH sides — the create path
          // stores `{}` for a param-less verb, so a bare `?? null` here would
          // report false drift and re-apply every boot.
          return (
            canonicalJson(seeded.parameters ?? {}) !==
            canonicalJson(codeSkill.parameters ?? {})
          );
        })
        .map((s) => s.name);
      if (missing.length === 0 && drifted.length === 0) {
        logger.debug(
          "synap-core capability + all builtin verbs present and in sync — skipping seed"
        );
        return;
      }
      logger.info(
        { missing, drifted },
        "synap-core needs convergence (missing verb(s) and/or definition drift) — re-projecting"
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
