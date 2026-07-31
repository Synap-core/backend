/**
 * Capabilities Router
 *
 * Discovers what features and intelligence services are available.
 * Frontend SDK calls this to dynamically adapt UI.
 *
 * Health model:
 *   - `list` returns cached lastHealthCheck from DB (fast, always available)
 *   - `checkHealth` pings a specific service and updates DB (called async by UI)
 *   - `serviceUsageStats` aggregates message counts by serviceId from messages JSONB
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import {
  db,
  getDb,
  intelligenceServices,
  automations,
  playbooks,
  playbookAutomations,
  skills,
  entities,
  capabilities as capabilitiesTable,
  notifications,
  NotificationStatus,
  openRunSession,
  closeRunSession,
  resolveIdentity,
  signalsFromExplicit,
  normalizeIdentitySignal,
  eq,
  and,
  or,
  isNull,
  inArray,
  drizzleSql,
} from "@synap/database";
import type { FlowDefinition } from "@synap/database";
import { MessageAuthorType } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { AccessContext, scopedDb } from "../access/index.js";
import { getDefaultActiveService } from "../utils/intelligence-routing.js";
import { requireUserId } from "../utils/user-scoped.js";
import { getWorkspaceRole, requirePodAdmin } from "../utils/workspace-role.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { entitiesRouter } from "./entities.js";
import {
  normalizeVerbResult,
  runEnrichmentVerb,
  fileEnrichmentProposal,
  EnrichmentProposalDeniedError,
} from "../services/capabilities/enrich-shared.js";
import { capabilityContainersRouter } from "./capability-containers.js";
import { buildCapabilityCatalog } from "../services/capabilities/capability-catalog.js";
import { buildAutomationCatalog } from "../services/capabilities/automation-catalog.js";
import {
  createCapabilityFromDefinition,
  loadCapabilityTemplate,
} from "../services/capabilities/create-from-definition.js";
import { executeCapability } from "../services/capabilities/execute-capability.js";
import { uninstallCapability } from "../services/capabilities/uninstall-capability.js";
import { reconcileCapabilitiesToTemplates } from "../services/capabilities/reconcile-capabilities-to-templates.js";
import { CAPABILITY_UPDATE_GROUP_KEY } from "../services/capabilities/notify-capability-updates.js";
import {
  addConnection,
  listConnections,
  removeConnection,
  updateConnection,
} from "../services/capabilities/capability-connections.js";

const logger = createLogger({ module: "capabilities" });

/** Default (proprietary) Synap Intelligence service — always available when no custom service is configured. */
const DEFAULT_INTELLIGENCE_SERVICE = {
  id: "default",
  serviceId: "default",
  name: "Synap Intelligence",
  capabilities: [
    "chat",
    "analysis",
    "commands",
    "proposals",
    "threads",
  ] as string[],
  pricing: "free" as const,
  version: "1.0",
  webhookUrl: null as string | null,
  lastHealthCheck: null as Date | null,
};

// ─── Health check helper ──────────────────────────────────────────────────────

async function pingServiceHealth(webhookUrl: string): Promise<boolean> {
  try {
    const healthUrl = `${webhookUrl.replace(/\/+$/, "")}/health`;
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(5000),
      method: "GET",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Readable fallback title for a LinkedIn contact when the scrape returned no
 * `scrapedName` — derived from the profile URL slug (`/in/john-doe-2a4f91` →
 * "John Doe"), stripping a trailing LinkedIn id hash. Never the raw URL.
 */
function titleFromLinkedinUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const slug = path.split("/").filter(Boolean).pop() ?? "";
    const cleaned = decodeURIComponent(slug)
      .replace(/-[a-z0-9]{6,}$/i, "") // trailing linkedin id hash
      .replace(/[-_]+/g, " ")
      .trim();
    if (!cleaned) return "LinkedIn contact";
    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "LinkedIn contact";
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const capabilitiesRouter = router({
  /** Capability CONTAINERS (the named bundles) — CRUD + part attach/detach. */
  containers: capabilityContainersRouter,

  /**
   * Capability CONNECTIONS (Wave 4) — CRUD over a capability's connections
   * (vault rows carrying `capability_id`). tRPC mirror of the Hub REST
   * `/capabilities/:capabilityId/connections` doors so the browser can drive the
   * SAME owner-gated `capability-connections` service (acting as the authenticated
   * operator via `ctx.userId`). NEVER returns a secret value.
   */
  connections: router({
    list: protectedProcedure
      .input(z.object({ capabilityId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const userId = requireUserId(ctx.userId);
        return listConnections(input.capabilityId, userId);
      }),

    add: protectedProcedure
      .input(
        z.object({
          capabilityId: z.string().uuid(),
          label: z.string().min(1).max(255),
          value: z.string().optional(),
          contextType: z.string().nullable().optional(),
          contextId: z.string().nullable().optional(),
          accountHint: z.string().nullable().optional(),
          isDefault: z.boolean().optional(),
          isPodWide: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const userId = requireUserId(ctx.userId);
        return addConnection({ ...input, actorUserId: userId });
      }),

    update: protectedProcedure
      .input(
        z.object({
          capabilityId: z.string().uuid(),
          connectionId: z.string().uuid(),
          label: z.string().min(1).max(255).optional(),
          value: z.string().optional(),
          contextType: z.string().nullable().optional(),
          contextId: z.string().nullable().optional(),
          accountHint: z.string().nullable().optional(),
          isDefault: z.boolean().optional(),
          isPodWide: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const userId = requireUserId(ctx.userId);
        return updateConnection({ ...input, actorUserId: userId });
      }),

    remove: protectedProcedure
      .input(
        z.object({
          capabilityId: z.string().uuid(),
          connectionId: z.string().uuid(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const userId = requireUserId(ctx.userId);
        return removeConnection({ ...input, actorUserId: userId });
      }),
  }),

  /**
   * List all available capabilities.
   *
   * Returns core features, plugins, and intelligence services with cached
   * health status (lastHealthCheck). Does NOT ping services — use checkHealth
   * for that so this query stays fast.
   */
  list: publicProcedure.query(async () => {
    logger.debug("Listing capabilities");

    const plugins: Array<{ name: string; version: string; enabled: boolean }> =
      [];

    // Include health-check columns
    const dbServices = await db.query.intelligenceServices.findMany({
      where: eq(intelligenceServices.status, "active"),
      columns: {
        id: true,
        serviceId: true,
        name: true,
        capabilities: true,
        pricing: true,
        version: true,
        webhookUrl: true,
        lastHealthCheck: true,
        lastHealthStatus: true,
      },
    });

    const hasDefault = dbServices.some((s) => s.serviceId === "default");
    const services = hasDefault
      ? dbServices
      : [DEFAULT_INTELLIGENCE_SERVICE, ...dbServices];

    return {
      core: {
        version: "1.0.0",
        features: [
          "notes",
          "tasks",
          "chat",
          "entities",
          "events",
          "files",
          "inbox",
        ],
      },
      plugins,
      intelligenceServices: services.map((s) => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        capabilities: s.capabilities,
        pricing: s.pricing || "free",
        version: s.version,
        webhookUrl: s.webhookUrl ?? null,
        lastHealthCheck: s.lastHealthCheck ?? null,
        lastHealthStatus:
          ("lastHealthStatus" in s ? s.lastHealthStatus : null) ?? null,
      })),
    };
  }),

  /**
   * Pack-grouped, status-computed capability CATALOG for a workspace.
   *
   * tRPC mirror of the Hub REST `GET /capabilities/catalog` door. Delegates to
   * the SAME `buildCapabilityCatalog` service: deriving the acting userId from
   * the authenticated ctx and the workspace from input. Returns one
   * `CapabilityCard` per pack (installed containers + available templates).
   */
  catalog: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return buildCapabilityCatalog({
        workspaceId: input.workspaceId,
        userId: ctx.userId,
      });
    }),

  /**
   * Automation CATALOG for a workspace — the automation SIBLING of `catalog`.
   *
   * Automations are a SEPARATE marketplace kind (they USE capabilities, they are
   * not merged INTO the "capability" kind), so this is an additive, distinct door
   * rather than a change to `catalog`'s return shape. Delegates to
   * `buildAutomationCatalog` (installed workspace automations + available
   * automation packages from the catalog cache).
   */
  automationCatalog: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return buildAutomationCatalog({
        workspaceId: input.workspaceId,
        userId: ctx.userId,
      });
    }),

  /**
   * Enable / disable (approve) a single capability verb (its backing skill) —
   * the capability-scoped counterpart to `skills.setApproved`. Gated on the
   * CONTAINER the skill belongs to: a pod-scoped (null-workspace) skill requires
   * pod-admin (the pod owner/operator); a workspace-scoped skill requires the
   * workspace owner. Leaves `skills.setApproved` intact — this is the
   * capability-surface enable path so the legitimate operator can flip a verb on
   * without the (intentionally separate) skills-router gate.
   */
  setToolEnabled: protectedProcedure
    .input(z.object({ skillId: z.string().uuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await db.query.skills.findFirst({
        where: eq(skills.id, input.skillId),
      });
      if (!skill) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
      }
      if (skill.workspaceId) {
        const role = await getWorkspaceRole(userId, skill.workspaceId);
        if (role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can enable capability verbs.",
          });
        }
      } else {
        // Pod-scoped (null-workspace) verb — visible in every workspace, so
        // flipping it is a pod-level privileged action.
        await requirePodAdmin(userId);
      }

      await db
        .update(skills)
        .set({ approved: input.enabled, updatedAt: new Date() })
        .where(eq(skills.id, input.skillId));

      return { success: true };
    }),

  /**
   * Apply a capability template — instantiate {vault · tools · skills · playbooks}
   * from an inline `definition` or a seed `templateKey`.
   *
   * tRPC mirror of the Hub REST `POST /capabilities/apply` door. Resolves the
   * definition the same way (inline body wins, else load the seed template) then
   * delegates to the GOVERNED `createCapabilityFromDefinition` service, scoping it
   * to `input.workspaceId` via the ctx.
   */
  install: protectedProcedure
    .input(
      z.object({
        templateKey: z.string().optional(),
        definition: z.any().optional(),
        /**
         * Install-time params — the credential(s)/config the template declares.
         * Threaded into the applier so a template with a REQUIRED credential param
         * installs WITH its key in one governed call (creating the vault secret),
         * instead of throwing. Mirrors the Hub REST `apply` door (rest/capabilities).
         */
        params: z.record(z.string(), z.unknown()).optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const definition =
        input.definition ??
        (await loadCapabilityTemplate(input.templateKey!, {
          workspaceId: input.workspaceId,
        }));

      return createCapabilityFromDefinition(definition, input.params ?? {}, {
        ...ctx,
        workspaceId: input.workspaceId,
      });
    }),

  /**
   * Uninstall a capability container and its orphaned members (tools + skills).
   *
   * Auth: pod-scoped container (workspaceId=null) → pod admin; workspace-scoped
   * container → workspace owner. Members shared with another container are kept;
   * only orphaned members (linked to NO other container) are deleted. All steps
   * run in a single transaction.
   */
  uninstall: protectedProcedure
    .input(z.object({ capabilityId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Load the container to determine scope — never trust caller-supplied scope.
      const [container] = await db
        .select({
          id: capabilitiesTable.id,
          workspaceId: capabilitiesTable.workspaceId,
        })
        .from(capabilitiesTable)
        .where(eq(capabilitiesTable.id, input.capabilityId))
        .limit(1);

      if (!container) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Capability not found",
        });
      }

      if (container.workspaceId !== null) {
        const role = await getWorkspaceRole(userId, container.workspaceId);
        if (role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Only workspace owners can uninstall workspace capabilities.",
          });
        }
      } else {
        await requirePodAdmin(userId);
      }

      return uninstallCapability(input.capabilityId, ctx);
    }),

  /**
   * Operator "Apply updates" door — converge installed capability CONTAINERS to
   * their drifted Control-Plane templates (the WRITE half of the boot reconcile).
   *
   * Runs the SAME engine as the boot hook + Hub `POST /capabilities/reconcile`,
   * but in-process with `dryRun:false`. This is `protectedProcedure`, so tRPC's
   * Kratos-cookie transport gates it to the operator — agent keys can NEVER reach
   * tRPC. That is the governance floor: NO re-implemented `agentUserId` block
   * (that guard belongs only to the Hub/agent-key REST transport). Optional
   * `containerIds` scopes the apply to just those containers.
   */
  applyUpdates: protectedProcedure
    .input(
      z
        .object({ containerIds: z.array(z.string().uuid()).optional() })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const report = await reconcileCapabilitiesToTemplates({
        dryRun: false,
        containerIds: input?.containerIds,
        // The operator clicking "Apply" IS the consent notify-policy defers to.
        applyNotifyPolicy: true,
      });

      // Clear the "updates available" bell item ONLY when nothing is left to
      // apply — `report.updatesAvailable` is what STILL needs a human after this
      // pass (e.g. param-requiring templates the reconcile can't apply, or a
      // subset apply that left other drift). Dismissing unconditionally would
      // hide remaining updates until the next redeploy (pods restart rarely).
      if (report.updatesAvailable.length === 0) {
        await db
          .update(notifications)
          .set({ status: NotificationStatus.DISMISSED })
          .where(
            and(
              eq(notifications.userId, userId),
              eq(notifications.groupKey, CAPABILITY_UPDATE_GROUP_KEY),
              eq(notifications.status, NotificationStatus.UNREAD)
            )
          );
      }

      return report;
    }),

  /**
   * "Check for updates now" — explicit operator button (NOT polled). Dry-run
   * convergence; returns only the drifted `updatePolicy:"notify"` capabilities
   * awaiting a human. `protectedProcedure` → operator-gated by the transport.
   */
  checkUpdates: protectedProcedure.query(async () => {
    const report = await reconcileCapabilitiesToTemplates({ dryRun: true });
    return { updatesAvailable: report.updatesAvailable };
  }),

  /**
   * Execute a registered capability — resolve a verb (= backing skill name) and
   * run it through the SAME governance gate every capability path uses.
   *
   * tRPC mirror of the Hub REST `POST /capabilities/execute` door. Delegates to
   * the shared `executeCapability` core (acting as the authenticated operator) and
   * returns its discriminated result verbatim (run / proposed / deny / not_found).
   */
  execute: protectedProcedure
    .input(
      z.object({
        verbId: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        workspaceId: z.string().uuid(),
        connectionSelector: z
          .object({
            connectionId: z.string().optional(),
            contextObjectId: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return executeCapability({
        verbId: input.verbId,
        parameters: input.parameters,
        workspaceId: input.workspaceId,
        userId: ctx.userId,
        connectionSelector: input.connectionSelector,
      });
    }),

  /**
   * "Enrich this record" — the ONE light-launch door that makes an enrichment
   * run VISIBLE.
   *
   * Today the CRM does this client-side in two disconnected calls
   * (`capabilities.execute` then `entities.update`), so the run leaves no
   * receipt and its proposal is an orphan card. This door wraps the SAME verb
   * run in a `focus_session` and stamps that `sessionId` onto the resulting
   * proposal, so the write groups under one reviewable run in the proposal board
   * AND the run shows up in the RunsHome feed. It reinvents nothing: the verb
   * goes through `executeCapability` (the shared governed core) and the write
   * goes through `checkPermissionOrPropose` (the ONE governance door), with
   * `forcePropose` — machine-sourced data is always reviewed, never silently
   * written.
   *
   * The session opens only AFTER the verb actually ran: a `not_found` (capability
   * not installed) must not litter the feed with an empty receipt.
   */
  enrichEntity: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        verbId: z.string(),
        parameters: z.record(z.string(), z.unknown()).default({}),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // 1. Load the target by id ALONE, then gate on the LOADED row's workspace
      //    (never `input.workspaceId` — that is the cross-workspace write-leak
      //    class). A pod-wide (NULL-workspace) entity is gated on its owner.
      const entity = await db.query.entities.findFirst({
        where: and(eq(entities.id, input.entityId), isNull(entities.deletedAt)),
        columns: { id: true, title: true, workspaceId: true, userId: true },
      });
      if (!entity) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Entity not found: ${input.entityId}`,
        });
      }
      await assertWorkspaceWrite(db, userId, {
        workspaceId: entity.workspaceId,
        ownerId: entity.userId,
      });

      // The ENTITY'S OWN workspace is authoritative for where the run + proposal
      // land — never the caller-supplied `input.workspaceId`. A pod-wide entity
      // (NULL) → a pod-wide run governed by the pod-wide queue; using
      // `input.workspaceId` here would file the enriched data into an arbitrary
      // workspace the caller named. Verb RESOLUTION still tolerates the active
      // workspace (a pod-scoped enrichment verb is visible from either).
      const runWorkspaceId = entity.workspaceId;

      // 2. Run the verb through the shared governed core. Nothing ran → no
      //    session, no receipt: `setup_required` is the "capability isn't
      //    installed/connected here" signal the UI routes to Settings; `failed`
      //    is a run that reached its handler and failed (the failure text never
      //    leaks in as a proposed `error` property); `verb_proposed` is the
      //    verb's OWN run being governance-queued (non-owner running a pod-wide
      //    verb) — surface it in the SAME `proposed` shape (fieldCount 0 ⇒
      //    "queued for review", not "N changes") so the client's single branch
      //    renders it.
      const verb = await runEnrichmentVerb({
        verbId: input.verbId,
        parameters: input.parameters,
        workspaceId: runWorkspaceId ?? input.workspaceId,
        userId,
      });
      if (verb.status === "setup_required") {
        return { status: "setup_required" as const, message: verb.message };
      }
      if (verb.status === "denied") {
        return { status: "denied" as const, message: verb.message };
      }
      if (verb.status === "failed") {
        return { status: "failed" as const, message: verb.message };
      }
      if (verb.status === "verb_proposed") {
        return {
          status: "proposed" as const,
          sessionId: null,
          proposalId: verb.proposalId,
          reviewUrl: verb.reviewUrl,
          fieldCount: 0,
        };
      }

      // 3. Strip any run-metadata → the properties we intend to write.
      const mapped = normalizeVerbResult(verb.result);

      // 4. The receipt: one session per enrichment run. Channel-less by design —
      //    a single-tier run needs a receipt, not a live room. It is CLOSED on
      //    every terminal path (the `finally`): a synchronous run is done when we
      //    return, and nothing reaps a channel-less enrichment session otherwise.
      const { sessionId } = await openRunSession({
        userId,
        goal: `Enrich ${entity.title ?? "record"}`,
        workspaceId: runWorkspaceId,
        subjectEntityId: input.entityId,
        source: "enrichment",
      });
      try {
        // 5. The governed write — `forcePropose`, sessionId-stamped (shared door).
        const filed = await fileEnrichmentProposal({
          entityId: input.entityId,
          mapped,
          sessionId,
          workspaceId: runWorkspaceId,
          userId,
        });
        return { ...filed, sessionId };
      } catch (err) {
        if (err instanceof EnrichmentProposalDeniedError) {
          throw new TRPCError({ code: "FORBIDDEN", message: err.message });
        }
        throw err;
      } finally {
        await closeRunSession(sessionId);
      }
    }),

  /**
   * "Import from a LinkedIn URL" — the server-side, canonical-dedup import door.
   *
   * Shares its spine with `enrichEntity` (the `enrich-shared` helpers): it runs
   * an enrichment VERB, then files the scraped fields as a governed proposal
   * under a run session. What it adds is IDENTITY-FIRST creation:
   *   1. Resolve the person by the `linkedin_url` STRONG signal via the canonical
   *      `IdentityResolutionService` (never a client-side list-scan).
   *   2. Existing (visible) match → enrich it in place (`mode:"existing"`).
   *   3. No match → run the verb, title a NEW person with the scraped name via the
   *      CANONICAL `entities.create` door (dedup + events + identity-signal
   *      registration all handled there — never a raw insert), then enrich it
   *      (`mode:"created"`).
   *
   * The verb ALWAYS runs exactly once; a run that yields no writable data touches
   * nothing (no create, no session), matching enrichEntity's "no empty receipt".
   */
  importContact: protectedProcedure
    .input(
      z.object({
        url: z.string(),
        // The catalog-discovered LinkedIn scrape verb — never hardcoded here.
        verbId: z.string(),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // 1. Normalize the URL through the SAME door the `linkedin_url` strong-signal
      //    atom uses, so this lookup and any later write agree byte-for-byte
      //    (lowercase + strip trailing slash).
      const normalizedUrl = normalizeIdentitySignal("linkedin_url", input.url);

      // 2. Canonical dedup: resolve the person by the linkedin_url strong signal.
      //    `signalsFromExplicit` classifies the bare URL linkedin-vs-website via
      //    the same domain-anchored check used everywhere.
      const identity = await resolveIdentity(db, {
        userId,
        kindSlug: "person",
        signals: signalsFromExplicit({ url: normalizedUrl }),
        userScope: userVisibleWhere(entities.workspaceId, userId),
        limit: 5,
      });

      // The strong identity index is GLOBAL (one subject per url pod-wide), so a
      // match may belong to a row the caller cannot see. Gate on the caller's
      // visibility floor; an invisible match falls through to CREATE (mirrors
      // entities.create's resolve-then-merge security gate) — never enrich or
      // return a row the caller can't see.
      const matched =
        identity.match === "strong" && identity.entity
          ? await db.query.entities.findFirst({
              where: and(
                eq(entities.id, identity.entity.id),
                isNull(entities.deletedAt),
                userVisibleWhere(entities.workspaceId, userId)
              ),
              columns: { id: true, title: true, workspaceId: true },
            })
          : undefined;

      // 3. Run the enrichment verb ONCE through the shared governed core.
      const verb = await runEnrichmentVerb({
        verbId: input.verbId,
        parameters: { url: normalizedUrl },
        workspaceId: input.workspaceId,
        userId,
      });

      // A verb that produced no writable data touches nothing — no create, no
      // session. `mode` reflects the RESOLUTION (an existing contact is named so
      // the caller knows it's already there; a would-be create has no id yet).
      let mode: "existing" | "created" = matched ? "existing" : "created";
      if (verb.status === "setup_required") {
        return {
          mode,
          entityId: matched?.id ?? null,
          status: "setup_required" as const,
          message: verb.message,
        };
      }
      if (verb.status === "denied") {
        return {
          mode,
          entityId: matched?.id ?? null,
          status: "denied" as const,
          message: verb.message,
        };
      }
      if (verb.status === "failed") {
        return {
          mode,
          entityId: matched?.id ?? null,
          status: "failed" as const,
          message: verb.message,
        };
      }
      if (verb.status === "verb_proposed") {
        return {
          mode,
          entityId: matched?.id ?? null,
          status: "proposed" as const,
          sessionId: null,
          proposalId: verb.proposalId,
          reviewUrl: verb.reviewUrl,
          fieldCount: 0,
        };
      }

      // 4. Resolve the target entity: enrich the existing match, or create a
      //    titled person through the CANONICAL create door.
      let entityId: string;
      let runWorkspaceId: string | null;
      let goalTitle: string;
      if (matched) {
        entityId = matched.id;
        runWorkspaceId = matched.workspaceId;
        goalTitle = matched.title ?? "contact";
      } else {
        // scrapedName is the TITLE — read from the RAW verb result, BEFORE
        // normalize strips it as a meta key.
        const rawResult =
          verb.result &&
          typeof verb.result === "object" &&
          !Array.isArray(verb.result)
            ? (verb.result as Record<string, unknown>)
            : {};
        const scrapedName = rawResult.scrapedName;
        const title =
          (typeof scrapedName === "string" && scrapedName.trim()) ||
          titleFromLinkedinUrl(normalizedUrl);

        // Canonical create door — runs under the caller's workspace lens. Person
        // is pod-default (entityScope 'pod') → not workspace-scoped, so it joins
        // the un-fragmented global contact graph. The door registers the
        // linkedin_url signal + emits create events; it re-checks dedup, so a
        // race between our resolve and this create merges rather than duplicates.
        const created = await entitiesRouter
          .createCaller({
            ...ctx,
            workspaceId: input.workspaceId,
          } as unknown as Parameters<typeof entitiesRouter.createCaller>[0])
          .create({
            profileSlug: "person",
            title,
            properties: { linkedinUrl: normalizedUrl, source: "linkedin" },
            source: "user",
          });

        // A restricted member's create could be proposal-gated (no id yet) —
        // surface that instead of filing an enrichment against a phantom id.
        if (created.status === "proposed" || !("id" in created)) {
          return {
            mode: "created" as const,
            entityId: null,
            status: "proposed" as const,
            sessionId: null,
            proposalId: (created as { proposalId: string }).proposalId,
            reviewUrl: (created as { reviewUrl: string }).reviewUrl,
            fieldCount: 0,
          };
        }

        entityId = created.id;
        // The canonical door may have DEDUPED onto an existing row (resolve↔create
        // race, or a visible-elsewhere match) — report it as existing, not created.
        if ((created as { deduplicated?: boolean }).deduplicated) {
          mode = "existing";
        }
        // A person is pod-default (workspaceId null) — read the created row's own
        // workspace so the run + proposal land where the entity actually lives.
        const createdRow = await db.query.entities.findFirst({
          where: eq(entities.id, entityId),
          columns: { workspaceId: true, title: true },
        });
        runWorkspaceId = createdRow?.workspaceId ?? null;
        goalTitle = createdRow?.title ?? title;
      }

      // 5. One run session for the whole import, closed in `finally`. Opened only
      //    now (after a real run + a resolved entity) so a failed verb never
      //    litters the feed with an empty receipt.
      const { sessionId } = await openRunSession({
        userId,
        goal: `Import ${goalTitle}`,
        workspaceId: runWorkspaceId,
        subjectEntityId: entityId,
        source: "import",
      });
      try {
        // The governed write — the SAME shared door enrichEntity uses.
        const filed = await fileEnrichmentProposal({
          entityId,
          mapped: normalizeVerbResult(verb.result),
          sessionId,
          workspaceId: runWorkspaceId,
          userId,
          reasoning: "LinkedIn import enrichment",
        });
        return { mode, entityId, ...filed, sessionId };
      } catch (err) {
        if (err instanceof EnrichmentProposalDeniedError) {
          throw new TRPCError({ code: "FORBIDDEN", message: err.message });
        }
        throw err;
      } finally {
        await closeRunSession(sessionId);
      }
    }),

  /**
   * Dry-run a capability verb — preview the intended effects WITHOUT committing.
   *
   * Resolves the verb's backing skill exactly like `execute` (verb NAME scoped
   * pod-wide OR this workspace OR owned by the actor), then proxies to the IS
   * dry-run executor (`POST {IS}/api/skills/:id/dry-run`) — the SAME contract the
   * Hub REST `/skills/:id/dry-run` door uses (external writes stubbed, reads real).
   *
   * Declarative verbs (`kind:"declarative"`) are in-process executors with
   * no isolate sandbox, so there is no dry-run path — we return a clear
   * "not available" result rather than executing them.
   */
  dryRun: protectedProcedure
    .input(
      z.object({
        verbId: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [skillRow] = await db
        .select({ id: skills.id, kind: skills.kind })
        .from(skills)
        .where(
          and(
            eq(skills.name, input.verbId),
            or(
              isNull(skills.workspaceId),
              eq(skills.workspaceId, input.workspaceId),
              eq(skills.userId, ctx.userId)
            )
          )
        )
        .limit(1);

      if (!skillRow) {
        return {
          kind: "not_found" as const,
          message: `Verb "${input.verbId}" not found in this workspace.`,
        };
      }

      // Declarative and builtin verbs run in-process — no isolate dry-run sandbox.
      if (skillRow.kind === "declarative" || skillRow.kind === "builtin") {
        return {
          kind: "dry-run-unavailable" as const,
          skillId: skillRow.id,
          message: `Dry-run not available for ${skillRow.kind} verbs (they run in-process, not in the IS sandbox).`,
        };
      }

      const { endpoint: isUrl, apiKey: isApiKey } =
        await getDefaultActiveService();
      const res = await fetch(`${isUrl}/api/skills/${skillRow.id}/dry-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
        },
        body: JSON.stringify({
          userId: ctx.userId,
          parameters: input.parameters ?? {},
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Skill dry-run failed (${res.status}) ${body}`.trim(),
        });
      }

      const data = (await res.json().catch(() => null)) as {
        result?: unknown;
        dryRunEffects?: unknown[];
      } | null;

      return {
        kind: "dry-run" as const,
        skillId: skillRow.id,
        result: data?.result ?? null,
        dryRunEffects: data?.dryRunEffects ?? [],
      };
    }),

  /**
   * "Use in an automation" — scaffold a DRAFT automation from a single capability
   * verb. Builds a minimal FlowDefinition (trigger → ONE capability node) and
   * inserts it via the SAME path `automations.create` uses for an operator-direct
   * write: operator identity (no agentUserId), RBAC-gated, never proposed.
   */
  createFromVerbCapability: protectedProcedure
    .input(
      z.object({
        verbId: z.string(),
        capabilityId: z.string().optional(),
        capabilityName: z.string(),
        verbLabel: z.string(),
        verbKind: z.enum(["read", "write", "action"]).optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      // Operator direct write — enforce workspace RBAC (deny if not permitted),
      // but never propose. Mirrors the operator branch of automations.create.
      const { verifyPermission } = await import("@synap/database");
      const { requiredPermissionFor } =
        await import("@synap/governance-policy");
      const result = await verifyPermission({
        db: database,
        userId: ctx.userId!,
        workspace: { id: input.workspaceId },
        requiredPermission: requiredPermissionFor("create"),
      });
      if (!result.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: result.reason || "Permission denied",
        });
      }

      const flowDefinition = {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            position: { x: 0, y: 0 },
            data: {},
          },
          {
            id: "step-1",
            type: "capability",
            position: { x: 0, y: 140 },
            data: {
              capabilityId: input.capabilityId,
              capabilityName: input.capabilityName,
              verbId: input.verbId,
              verbLabel: input.verbLabel,
              verbKind: input.verbKind,
              inputMapping: {},
              label: `${input.capabilityName} · ${input.verbLabel}`,
            },
          },
        ],
        edges: [{ id: "e1", source: "trigger", target: "step-1" }],
      } as unknown as FlowDefinition;

      const [row] = await database
        .insert(automations)
        .values({
          workspaceId: input.workspaceId,
          createdBy: ctx.userId!,
          name: `New automation: ${input.verbLabel}`,
          triggerType: "manual",
          triggerConfig: {},
          flowDefinition,
          status: "draft",
          metadata: { createdVia: "manual" as const },
        })
        .returning({ id: automations.id });

      return { automationId: row.id };
    }),

  /**
   * "Used in processes" — backlinks from a capability verb to the automations
   * that reference it. Matches any automation whose flow_definition has a
   * `type:"capability"` node with `data.verbId == verbId`, via a JSONB
   * containment query on the nodes array. Membership-scoped via the access layer
   * (mirrors automations.list) so a foreign workspaceId leaks nothing.
   *
   * ALSO surfaces playbooks that use the verb — TRANSITIVELY, via the
   * automation(s) they're composed with. A playbook has no `flowDefinition`
   * of its own (see `packages/database/src/schema/playbooks.ts`): its only
   * link to a capability-verb node is through the automation it drives
   * (`flowAutomationId`, the legacy single-automation link) or the automations
   * it composes (`playbook_automations`, the first-class join table). So "a
   * playbook uses this capability" means "a matching automation from above is
   * that playbook's `flowAutomationId` OR is joined via `playbook_automations`" —
   * never a direct verbId on the playbook row (there isn't one; a false direct
   * backlink would be worse than this correct transitive one).
   *
   * Output-shape change: the array is now a discriminated union
   * (`kind: "automation" | "playbook"`) instead of always
   * `{ automationId, name, status }`. Existing consumers
   * (`browser/.../CapabilityDetail.tsx`, `.../ToolDetailPage.tsx`) dedupe by
   * `p.automationId` and only know how to open an automation surface — they
   * need updating to branch on `kind` before playbook rows show up correctly.
   */
  usedInProcesses: protectedProcedure
    .input(
      z.object({
        verbId: z.string(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const automationVisibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );

      const containment = drizzleSql`${automations.flowDefinition} -> 'nodes' @> ${JSON.stringify(
        [{ type: "capability", data: { verbId: input.verbId } }]
      )}::jsonb`;

      const automationRows = await database
        .select({
          automationId: automations.id,
          name: automations.name,
          status: automations.status,
        })
        .from(automations)
        .where(
          and(
            automationVisibility,
            // A specific workspace only NARROWS and still includes pod-wide
            // (NULL) automations; no workspace → no narrow (the user floor).
            input.workspaceId
              ? or(
                  isNull(automations.workspaceId),
                  eq(automations.workspaceId, input.workspaceId)
                )
              : undefined,
            containment
          )
        )
        .orderBy(automations.name);

      const matchedAutomationIds = automationRows.map((r) => r.automationId);

      let playbookRows: Array<{
        playbookId: string;
        name: string;
        status: string;
      }> = [];
      if (matchedAutomationIds.length > 0) {
        const playbookVisibility = scopedDb(AccessContext.from(ctx)).predicate(
          playbooks
        );

        // Two soft links can carry the match: the legacy single `flowAutomationId`
        // and the first-class `playbook_automations` join table — hence the
        // `leftJoin` + `or(...)` rather than a subquery. `inArray` (the drizzle
        // helper, not a raw `sql` array bind) is required here: this pod's
        // postgres.js driver faults on a JS array interpolated straight into a
        // `sql` template (the same class of gotcha as `sql.json()` — see
        // `matchForEntity` above and the driver notes in @synap/database).
        playbookRows = await database
          .selectDistinct({
            playbookId: playbooks.id,
            name: playbooks.name,
            status: playbooks.status,
          })
          .from(playbooks)
          .leftJoin(
            playbookAutomations,
            eq(playbookAutomations.playbookId, playbooks.id)
          )
          .where(
            and(
              playbookVisibility,
              input.workspaceId
                ? or(
                    isNull(playbooks.workspaceId),
                    eq(playbooks.workspaceId, input.workspaceId)
                  )
                : undefined,
              or(
                inArray(playbooks.flowAutomationId, matchedAutomationIds),
                inArray(playbookAutomations.automationId, matchedAutomationIds)
              )
            )
          )
          .orderBy(playbooks.name);
      }

      return [
        ...automationRows.map((r) => ({
          kind: "automation" as const,
          automationId: r.automationId,
          name: r.name,
          status: r.status,
        })),
        ...playbookRows.map((r) => ({
          kind: "playbook" as const,
          playbookId: r.playbookId,
          name: r.name,
          status: r.status,
        })),
      ];
    }),

  /**
   * Ping a specific intelligence service's /health endpoint.
   * Updates lastHealthCheck in DB and returns the health result.
   * Call this asynchronously from the UI — do NOT await on first paint.
   */
  checkHealth: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ input }) => {
      // Built-in default service: cannot be pinged (same process)
      if (input.serviceId === "default") {
        return { serviceId: "default", isHealthy: true, checkedAt: new Date() };
      }

      const svc = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, input.serviceId),
        columns: { id: true, webhookUrl: true },
      });

      if (!svc) {
        return {
          serviceId: input.serviceId,
          isHealthy: false,
          checkedAt: new Date(),
        };
      }

      const isHealthy = await pingServiceHealth(svc.webhookUrl);
      const checkedAt = new Date();

      await db
        .update(intelligenceServices)
        .set({
          lastHealthCheck: checkedAt,
          lastHealthStatus: isHealthy ? "healthy" : "unhealthy",
          updatedAt: checkedAt,
        })
        .where(eq(intelligenceServices.id, svc.id));

      logger.debug(
        { serviceId: input.serviceId, isHealthy },
        "Health check complete"
      );
      return { serviceId: input.serviceId, isHealthy, checkedAt };
    }),

  /**
   * Usage statistics per intelligence service.
   * Aggregates message counts + token usage from the messages table JSONB.
   *
   * Returns per-service stats for the given period (default: last 30 days).
   */
  serviceUsageStats: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        days: z.number().min(1).max(365).default(30),
      })
    )
    .query(async ({ input }) => {
      const since = new Date();
      since.setDate(since.getDate() - input.days);

      // Query: group by metadata->>'serviceId', count messages and sum tokens
      const rows = await db.execute(
        drizzleSql`
          SELECT
            COALESCE(metadata->>'serviceId', 'default') AS service_id,
            COUNT(*)::int                               AS message_count,
            SUM(COALESCE((metadata->>'tokens')::int, 0))::int AS total_tokens,
            AVG(COALESCE((metadata->>'latency')::float, 0))::float AS avg_latency_ms
          FROM messages
          WHERE author_type = ${MessageAuthorType.AI_AGENT}
            AND timestamp  >= ${since.toISOString()}
            AND deleted_at IS NULL
          GROUP BY service_id
          ORDER BY message_count DESC
        `
      );

      const stats = (
        rows as unknown as Array<{
          service_id: string;
          message_count: number;
          total_tokens: number;
          avg_latency_ms: number;
        }>
      ).map((r) => ({
        serviceId: r.service_id,
        messageCount: Number(r.message_count),
        totalTokens: Number(r.total_tokens),
        avgLatencyMs: Math.round(Number(r.avg_latency_ms)),
      }));

      return { stats, since: since.toISOString(), days: input.days };
    }),

  /**
   * Check if a specific capability is available.
   */
  hasCapability: publicProcedure
    .input(z.object({ capability: z.string() }))
    .query(async ({ input }) => {
      const dbServices = await db.query.intelligenceServices.findMany({
        where: eq(intelligenceServices.status, "active"),
      });

      const hasDefaultCapability =
        DEFAULT_INTELLIGENCE_SERVICE.capabilities.includes(input.capability);
      const hasDbCapability = dbServices.some((s) =>
        (s.capabilities as string[]).includes(input.capability)
      );

      return { available: hasDefaultCapability || hasDbCapability };
    }),
});
