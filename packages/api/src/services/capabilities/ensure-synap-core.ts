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
} from "@synap/database";
import { resolvePodOwnerUserId } from "./pod-owner.js";
import type { CapabilityDefinition } from "@synap/playbooks";

import { createCapabilityFromDefinition } from "./create-from-definition.js";
import { capabilityDefinitionDrift } from "./capability-drift.js";
import type { Context } from "../../context.js";

const logger = createLogger({ module: "ensure-synap-core" });

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
        "READ entities selected by EXACTLY ONE of `profileSlug` (a single kind/role slug) or `roleCategory` (every role tagged that category — dynamic, no enumeration), scoped to the caller's floor. Optional JSONB property-equality filter and workspace lens. Returns { entities[], count }. Read-only: auto-runs, scoped by the access layer.",
      parameters: {
        type: "object",
        properties: {
          profileSlug: {
            type: "string",
            description:
              "A single kind/role slug (e.g. 'task', 'solution-provider'). Mutually exclusive with roleCategory.",
          },
          roleCategory: {
            type: "string",
            description:
              "Match entities wearing ANY role-facet whose profile carries this role_category (e.g. 'provider'). Dynamic set — future roles tagged the category qualify with no query change. Mutually exclusive with profileSlug.",
          },
          filter: {
            type: "object",
            description: "Property equality pairs { key: value } (JSONB ->>).",
          },
          workspaceId: { type: "string", format: "uuid" },
          scope: {
            type: "string",
            enum: ["workspace", "pod"],
            description:
              "'workspace' (default) = explicit workspaceId, else the acting workspace lens, else the full user floor. 'pod' = explicit opt-in to enumerate POD-WIDE entities (workspaceId IS NULL, owner-gated) even under an active workspace lens; an explicit workspaceId is ignored under 'pod'.",
          },
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
      name: "entity.delete",
      kind: "builtin",
      scope: "pod",
      description:
        "Soft-delete an entity via the governed entities.delete path (checkPermissionOrPropose). DESTRUCTIVE — always PROPOSES for a non-owner agent. Returns the deletion result or { status: 'proposed', proposalId }. Never hard-deletes.",
      parameters: {
        type: "object",
        required: ["entityId"],
        properties: {
          entityId: { type: "string", format: "uuid" },
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
    // ── Kind + Facets (roles) — attach/detach/list over the one facet door ──
    {
      name: "entity_facet.attach",
      kind: "builtin",
      scope: "pod",
      description:
        "Attach a ROLE (role-profile) to an entity via the governed entities.attachFacet door (checkPermissionOrPropose). A role — client/partner/investor/… — is a facet, never its own entity. May return a proposal. Returns the facet or { status: 'proposed', proposalId }.",
      parameters: {
        type: "object",
        required: ["entityId", "facetSlug"],
        properties: {
          entityId: { type: "string", format: "uuid" },
          facetSlug: { type: "string" },
          properties: { type: "object" },
          workspaceId: { type: "string", format: "uuid" },
          contextEntityId: { type: "string", format: "uuid" },
        },
      },
    },
    {
      name: "entity_facet.update",
      kind: "builtin",
      scope: "pod",
      description:
        "Update a role-facet's status/properties via the governed entities.updateFacet door (checkPermissionOrPropose). Target the facet by its id OR by (entityId + facetSlug) — the slug resolves to the entity's live facet. May return a proposal. Returns the facet or { status: 'proposed', proposalId }.",
      parameters: {
        type: "object",
        properties: {
          facetId: { type: "string", format: "uuid" },
          entityId: { type: "string", format: "uuid" },
          facetSlug: { type: "string" },
          status: { type: "string" },
          properties: { type: "object" },
          workspaceId: { type: "string", format: "uuid" },
        },
      },
    },
    {
      name: "entity_facet.detach",
      kind: "builtin",
      scope: "pod",
      description:
        "Detach (soft-delete) a role-facet via the governed entities.detachFacet door (checkPermissionOrPropose). Target by its id OR by (entityId + facetSlug) — the slug resolves to the entity's live facet (a no-op when none is live). May return a proposal. Never deletes the entity — only the role-facet.",
      parameters: {
        type: "object",
        properties: {
          facetId: { type: "string", format: "uuid" },
          entityId: { type: "string", format: "uuid" },
          facetSlug: { type: "string" },
        },
      },
    },
    {
      name: "entity_facet.list",
      kind: "builtin",
      scope: "pod",
      description:
        "READ an entity's live facets (roles), scoped to the caller's floor. Returns { facets[], count }. Read-only.",
      parameters: {
        type: "object",
        required: ["entityId"],
        properties: {
          entityId: { type: "string", format: "uuid" },
          workspaceId: { type: "string", format: "uuid" },
        },
      },
    },
    // ── Marketplace (Wave 3b) — search/install over cp_catalog_cache ────────
    {
      name: "market.search",
      kind: "builtin",
      scope: "pod",
      description:
        "Search the Control-Plane marketplace catalog (capabilities, automations, workspace templates, cells, skills, views) — the pod-local cache, never a live CP fetch. Use this AFTER list_capabilities finds nothing installed. Returns { entries[] } with an honest `installed` flag per entry (undefined when not cheaply checkable) or, on zero hits, a message pointing to capturing the gap. Read-only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "capability",
              "automation",
              "template",
              "cell",
              "skill",
              "view",
            ],
          },
          limit: { type: "number", minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: "market.install",
      kind: "builtin",
      scope: "pod",
      description:
        "Install a marketplace entry found via market.search. An agent-initiated install ALWAYS creates a reviewable capability.install proposal (never auto-provisions); an operator call installs directly. Tier-gated (fails early if the pod's plan doesn't cover it). Returns { status: 'installed', result } or { status: 'proposed', proposalId, reviewUrl }.",
      parameters: {
        type: "object",
        required: ["slug", "kind"],
        properties: {
          slug: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "capability",
              "automation",
              "template",
              "cell",
              "skill",
              "view",
            ],
          },
          version: { type: "string" },
          params: { type: "object" },
        },
      },
    },
    {
      name: "connector.health_check",
      kind: "builtin",
      scope: "pod",
      description:
        "Probe a connector for a provider and, if its OAuth connection is dead (refresh token expired / never connected), emit the operator reconnect nudge (in-app + Discord, deduped per cooldown). A healthy connector is a no-op. Lets a config feed nudge instead of going silently dead on an expired token. Read-only w.r.t. graph data (emits only operator notices): auto-runs inside a cron automation. Returns { unhealthy, nudged, error? }.",
      parameters: {
        type: "object",
        required: ["provider", "connectorName", "reconnectHint", "probeVerbId"],
        properties: {
          provider: { type: "string" },
          connectorName: { type: "string" },
          reconnectHint: { type: "string" },
          probeVerbId: { type: "string" },
          probeParameters: { type: "object" },
          connectionId: { type: "string" },
        },
      },
    },
    {
      name: "channel.ingest",
      kind: "builtin",
      scope: "pod",
      description:
        "Record a GENERIC inbound message onto its external channel via the shared inbound sink (resolve-or-create the channel, dedup-insert the message, emit external_message.received). Provider-agnostic — every field is a parameter, so provider ingest can be composed as config/automation from outside the pod. Two exclusive modes: SINGLE (text + idempotencySeed) for one message, or BATCH (messages[] + messageMap) for a whole thread in one call — for automations that cannot loop per-message; messageMap gives the dot-paths into each raw row. WRITE: flows through the full capability gate (an owner-run automation passes straight through). Returns { channelId, contextObjectId, inboundHash, created } (created=false on a duplicate delivery).",
      parameters: {
        type: "object",
        required: ["provider", "externalId"],
        properties: {
          provider: { type: "string" },
          externalId: { type: "string" },
          text: {
            type: "string",
            description:
              "Message body (SINGLE mode). Requires idempotencySeed.",
          },
          idempotencySeed: {
            type: "string",
            description: "Stable per-message idempotency seed (SINGLE mode).",
          },
          messages: {
            type: "array",
            description:
              "Raw message rows (e.g. a thread's messages[] from a list verb) — BATCH mode. Requires messageMap.",
          },
          messageMap: {
            type: "object",
            description:
              "Dot-paths locating each field inside a messages[] row (BATCH mode): { text, id, sentAt?, participant?, participantExternalId?, isOutbound? }. text and id are required.",
          },
          participant: { type: "string" },
          participantExternalId: { type: "string" },
          accountExternalId: { type: "string" },
          title: { type: "string" },
          sentAt: { type: "string" },
          workspaceId: { type: "string", format: "uuid" },
          suppressSideEffects: {
            type: "boolean",
            description:
              "When true, skip the per-message external_message.received event (channel resolve + dedup still run). Use for a historical backfill so replaying a thread doesn't fan out through webhook/automation reactors. Defaults to false.",
          },
        },
      },
    },
    {
      name: "messaging.send",
      kind: "builtin",
      scope: "pod",
      description:
        "Send a governed EXTERNAL message on a bound channel, on ANY provider (email / LinkedIn / Discord / Proton). Routes through the ONE governed send door (sendExternalMessage): an AGENT-initiated send with no approving grant is PROPOSED (never auto-sent), an owner send goes direct, and the client-comms firewall stays enforced. Provider-agnostic — the connector is resolved from the channel's externalSource and owns any reply-header derivation. WRITE: flows through the full capability gate. Returns { success, messageId?, proposed?, proposalId? } (proposed=true when routed to review).",
      parameters: {
        type: "object",
        required: ["channelId", "content"],
        properties: {
          channelId: { type: "string", format: "uuid" },
          content: { type: "string" },
          subject: {
            type: "string",
            description:
              "Optional reply subject. Advisory: the per-provider connector derives its own reply envelope; not threaded into the send today.",
          },
          inReplyTo: {
            type: "string",
            description:
              "Optional parent Message-Id for threading. Advisory: derived by the connector; not threaded into the send today.",
          },
        },
      },
    },
    {
      name: "governance.recommend_tighten",
      kind: "builtin",
      scope: "pod",
      description:
        "Governance calibration: scan recent REJECTED agent proposals, cluster them by shape, and file a pending governance.tighten_lane proposal for any shape the humans reject consistently (conservative floor). The mirror of the trusted-lane widen scanner — approving a tighten proposal pins that agent write-motif to review (a governance_rules row, verdict:'propose'). Takes NO params (scans pod-wide agent behaviour). Read-only w.r.t. graph data (files review items only): auto-runs inside the daily calibration cron. Returns { proposalsFiled, proposalIds }.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ],
};

/** The builtin verb NAMES this seeder registers — used by the convergence guard. */
const SYNAP_CORE_SKILL_NAMES = SYNAP_CORE_DEFINITION.skills.map((s) => s.name);

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
        .select({
          name: skills.name,
          parameters: skills.parameters,
          providerSpec: skills.providerSpec,
          code: skills.code,
          description: skills.description,
        })
        .from(skills)
        .where(
          and(
            isNull(skills.workspaceId),
            inArray(skills.name, SYNAP_CORE_SKILL_NAMES)
          )
        );
      // Definition-drift detection: a seeded verb whose stored `providerSpec` /
      // `parameters` / `code` / `description` differ from the code definition
      // (the catalog "lying" — e.g. a param was added in code but the name-only
      // guard never re-projected it). Falling through re-runs the (now
      // field-refreshing) applier, which self-heals the catalog — no manual
      // backfill migration needed. Shared with the general capability reconcile
      // (`capability-drift.ts`) so both guards stay in lock-step.
      const { missing, drifted } = capabilityDefinitionDrift(
        seededSkills,
        SYNAP_CORE_DEFINITION
      );
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
