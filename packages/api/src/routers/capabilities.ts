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
  tools as toolsTable,
  vaultGrants,
  entityExternalLinks,
  entities,
  capabilities as capabilitiesTable,
  notifications,
  NotificationStatus,
  openRunSession,
  closeRunSession,
  resolveIdentity,
  signalsFromExplicit,
  normalizeIdentitySignal,
  ownedWorkspaceIds,
  eq,
  and,
  or,
  isNull,
  inArray,
  drizzleSql,
} from "@synap/database";
import type { FlowDefinition } from "@synap/database";
import { MessageAuthorType, links } from "@synap/database/schema";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { AccessContext, scopedDb } from "../access/index.js";
import { getDefaultActiveService } from "../utils/intelligence-routing.js";
import { requireUserId } from "../utils/user-scoped.js";
import { getWorkspaceRole, requirePodAdmin } from "../utils/workspace-role.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { entitiesRouter } from "./entities.js";
import { skillsRouter } from "./skills.js";
import {
  CreateVerbInput,
  validateCreateVerbInput,
} from "./mcp/validate-create-verb.js";
import {
  listCapabilities,
  sectionCapabilities,
  DEFAULT_QUERY_LIMIT,
} from "../services/capabilities/capability-registry.js";
import {
  buildProviderVerbSpec,
  parentToolMissingMessage,
  parentToolWhere,
  upsertVerbCatalogEntry,
} from "../services/capabilities/create-declarative-verb.js";
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
  deriveVerbKind,
  loadCapabilityTemplate,
  GRANT_DEFAULT_EXEC_MODE,
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

// ─── Capability registry (the BRICK catalogue) ────────────────────────────────

/** The `CapabilityKind` discriminator, as a tRPC-facing enum. */
const CAPABILITY_KINDS = [
  "tool",
  "skill",
  "command",
  "source-provider",
  "builtin-tool",
  "teaching-doc",
] as const;

/**
 * Resolve the workspace LENS for a pod-altitude registry read.
 *
 * A caller-supplied `workspaceId` is untrusted input, so access is verified here
 * BEFORE it reaches the registry's `eq(workspaceId, …)` predicates — the
 * `workspaceProcedure` middleware that normally does this is deliberately not in
 * play (the catalogue must work with no workspace selected). Returns `null` for
 * pod altitude, which the registry narrows to pod-wide rows only.
 *
 * Access = MEMBERSHIP **or** OWNERSHIP. `workspaces.owner_id` is a first-class
 * column, SEPARATE from `workspace_members` (see `ownedWorkspaceIds`): a
 * sovereign/single-user pod's owner may have no member row at all, so a
 * membership-only gate would hard-FORBID them from their own catalogue.
 */
async function resolveRegistryLens(
  userId: string,
  requested: string | null | undefined
): Promise<string | null> {
  if (!requested) return null;
  const role = await getWorkspaceRole(userId, requested);
  if (!role) {
    const owned = await ownedWorkspaceIds(userId);
    if (!owned.some((w) => w.id === requested)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied to workspace",
      });
    }
  }
  return requested;
}

const capabilityRegistryRouter = router({
  /**
   * The sectioned brick catalogue: integrations (with their verbs nested),
   * standalone skills, and commands — server-side searchable.
   *
   * This is `sectionCapabilities` lifted to tRPC. Until now its ONLY call site
   * was the MCP adapter, so the agent could see the deduped "what can I DO" view
   * and no human surface could. Same projection, same `ListCapabilitiesOptions`
   * (query/kind/limit) that were previously unreachable from tRPC.
   *
   * HONEST DEGRADATION, not empty results: with no workspace the catalogue
   * returns pod-wide tools/commands + the caller's pod/user skills, and says so
   * via `lens`. Grants and connections are resolved the same way at either
   * altitude (they hang off the tool + the caller, not the lens), so a pod-level
   * catalogue is genuinely useful — it just cannot show workspace-scoped bricks.
   *
   * Built-ins come back as REAL ROWS in their own `builtins` section (a UI
   * renders it collapsed), each carrying `runnableHere` — so a browser can
   * inspect a built-in brick while a flow-node picker still refuses to offer a
   * catalog-only one as a step. `excluded` is passed through verbatim and now
   * counts teaching docs only: a catalogue must be able to say "M teaching docs
   * are not shown here" rather than silently hiding them, and counting built-ins
   * there would be a lie now that they ARE shown.
   */
  sections: protectedProcedure
    .input(
      z
        .object({
          /** Workspace lens; omit/null for pod altitude. Membership is verified. */
          workspaceId: z.string().uuid().nullish(),
          /** Ranked tokenized substring match over name + verb labels + description. */
          query: z.string().optional(),
          kind: z.enum(CAPABILITY_KINDS).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = await resolveRegistryLens(userId, input?.workspaceId);

      // `limit: null` — never slice the RAW flat list here. This door hands its
      // result straight to `sectionCapabilities`, which dedupes (a provider
      // installed twice, N backing-skill copies of one verb); slicing before
      // that fold could push a genuine match out of the window behind
      // duplicate rows of something else, so the picker could render "no
      // match" while a match exists. Cap AFTER dedup instead, below.
      const caps = await listCapabilities(
        { workspaceId, userId },
        {
          ...(input?.query ? { query: input.query } : {}),
          ...(input?.kind ? { kind: input.kind } : {}),
          limit: null,
        }
      );

      const sections = sectionCapabilities(caps, {
        // Same default as the flat door's own query-path cap
        // (`DEFAULT_QUERY_LIMIT`), just applied over distinct rows now. No cap
        // at all without a query — an unsearched catalogue must not be
        // silently short.
        limit: input?.limit ?? (input?.query ? DEFAULT_QUERY_LIMIT : undefined),
      });
      return {
        ...sections,
        /**
         * What this catalogue could see. `podOnly` is the honest signal a UI
         * needs to say "select a workspace to also see its capabilities"
         * instead of rendering an unexplained short list.
         */
        lens: { workspaceId, podOnly: workspaceId === null },
      };
    }),

  /**
   * Create a declarative provider verb — a new brick — on an ALREADY-installed
   * tool. The human/UI counterpart of the `synap_create_verb` MCP tool.
   *
   * Same steps, same helpers, no new business logic:
   *   1. `validateCreateVerbInput` (declarative-only, never accepts `code`);
   *   2. `parentToolWhere` — the parent tool must exist and be caller-visible;
   *   3. `skillsRouter.create` — the ONE governed door. `checkPermissionOrPropose`
   *      runs INSIDE it; no bypass flag, no direct insert here;
   *   4. WIRING — `skills.create` writes a bare skill row and nothing else, so
   *      without this step the verb is born ORPHANED: invisible to every read
   *      path that surfaces it. See the step-4 comment for the three edges.
   *
   * `agentUserId` is deliberately NOT threaded: this door is the HUMAN caller,
   * so governance evaluates the operator's own rights. An agent creating a verb
   * goes through MCP, which attributes its agent identity.
   *
   * A `status:"proposed"` outcome is a SUCCESS (the write is queued for review),
   * passed through verbatim — never converted into an error.
   */
  createVerb: protectedProcedure
    .input(CreateVerbInput)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = await resolveRegistryLens(userId, input.workspaceId);

      // Step 1 — the SAME pure validator the MCP door uses. Redundant against
      // the zod input above by construction (a strict object cannot carry
      // `kind`/`code` through), and kept anyway so there is exactly ONE place
      // that decides what a createable verb is.
      const validated = validateCreateVerbInput(input);
      if (!validated.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: validated.error });
      }

      // Step 2 — parent-tool precondition. This door only ADDS a verb to an
      // existing tool; it never creates a tool or a connection as a side effect.
      const database = await getDb();
      const [parentTool] = await database
        .select({ id: toolsTable.id, name: toolsTable.name })
        .from(toolsTable)
        .where(
          parentToolWhere({ userId, toolName: input.toolName, workspaceId })
        )
        .limit(1);
      if (!parentTool) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: parentToolMissingMessage(input.toolName, workspaceId),
        });
      }

      // Step 3 — the governed create door, called exactly as MCP calls it.
      const skillsCaller = skillsRouter.createCaller({
        ...ctx,
        workspaceId,
      } as unknown as Parameters<typeof skillsRouter.createCaller>[0]);
      const result = await skillsCaller.create({
        ...(workspaceId ? { workspaceId } : {}),
        kind: "declarative",
        scope: workspaceId ? "workspace" : "pod",
        name: input.verbName,
        description: input.description,
        providerSpec: buildProviderVerbSpec(
          validated.data
        ) as unknown as Record<string, unknown>,
        parameters: input.parameters,
        executionMode: "sync",
        timeoutSeconds: 30,
      });

      // Step 4 — WIRING. `skills.create` inserts a bare skill row and writes no
      // links, so a verb created here used to be unreachable from EVERY read
      // path that surfaces it:
      //   · `tools.capabilities` — the jsonb catalogue the Bricks registry reads
      //     (`capability-registry.buildVerbStates`) ⇒ the verb never appeared
      //     under its tool;
      //   · `skill --requires--> tool` — the parent edge;
      //   · `skill --member_of--> capability` — how a capability CARD folds its
      //     verbs in (`capability-catalog`).
      // Each edge is written through its EXISTING door, never hand-inserted.
      //
      // Only on the `created` branch. A `proposed` result is a SUCCESS, but the
      // skill row does NOT exist yet (the insert is queued behind review), so
      // there is nothing to link to — `setRequiredTools`/`addPart` would both
      // 404 on a lookup of it. The wiring for an approved proposal has to happen
      // where the proposal MATERIALIZES the skill (`insertSkillGoverned`), which
      // is outside this door; until then a verb created via the proposed branch
      // stays orphaned. `wiring` reports that honestly rather than implying it.
      //
      // Wiring failures are reported, not thrown: the skill row already exists
      // and `skills.create` is not idempotent, so raising here would push a UI
      // into re-creating a duplicate verb.
      const wiring = {
        requires: false,
        catalogued: false,
        capabilityIds: [] as string[],
      };

      if (result.status === "created") {
        try {
          await skillsCaller.setRequiredTools({
            skillId: result.id,
            toolIds: [parentTool.id],
          });
          wiring.requires = true;
        } catch (err) {
          logger.error(
            { skillId: result.id, toolId: parentTool.id, err },
            "createVerb: failed to write the requires edge"
          );
        }

        // The parent tool's capability container(s), if it belongs to any. A
        // tool with no container is normal (a bare connect) — then there is no
        // card to join and nothing to do.
        try {
          const containerLinks = await database
            .select({ capabilityId: links.toId })
            .from(links)
            .where(
              and(
                eq(links.fromType, "tool"),
                eq(links.fromId, parentTool.id),
                eq(links.toType, "capability"),
                eq(links.linkType, "member_of")
              )
            );
          const containersCaller = capabilityContainersRouter.createCaller(
            ctx as never
          );
          for (const capabilityId of new Set(
            containerLinks.map((l) => l.capabilityId)
          )) {
            try {
              await containersCaller.addPart({
                capabilityId,
                partType: "skill",
                partId: result.id,
              });
              wiring.capabilityIds.push(capabilityId);
            } catch (err) {
              // `addPart` refuses when the caller may SEE the container but not
              // write it — a pod-wide container the caller does not own, or a
              // workspace they are not a member of. The verb is still created;
              // it just doesn't join that card.
              logger.warn(
                { capabilityId, skillId: result.id, err },
                "createVerb: could not attach verb to capability"
              );
            }
          }
        } catch (err) {
          logger.error(
            { toolId: parentTool.id, err },
            "createVerb: capability-container lookup failed"
          );
        }

        // Append to the parent tool's verb catalogue, in the SAME shape
        // `deriveToolVerbs` produces (id = the backing skill's name, kind from
        // the shared `deriveVerbKind`, govDefault aligned to the seeded grant
        // exec-mode). Idempotent by verb id — re-creating never duplicates.
        try {
          // Read-modify-write on a jsonb ARRAY, so it MUST be serialized: two
          // concurrent createVerb calls on the same parent tool would otherwise
          // both read the pre-state and the second would overwrite the first's
          // entry — silently, since `wiring.catalogued` reports true for both.
          // The row lock makes the append at-most-once-per-verb and last-writer-
          // additive instead of last-writer-wins.
          await database.transaction(async (tx) => {
            const [toolRow] = await tx
              .select({ capabilities: toolsTable.capabilities })
              .from(toolsTable)
              .where(eq(toolsTable.id, parentTool.id))
              .for("update")
              .limit(1);
            const entry: ToolVerbCatalogEntry = {
              id: input.verbName,
              label: input.verbName,
              kind: deriveVerbKind({
                name: input.verbName,
                ...(input.description
                  ? { description: input.description }
                  : {}),
              }),
              ...(input.parameters && typeof input.parameters === "object"
                ? { argsSchema: input.parameters }
                : {}),
              govDefault: GRANT_DEFAULT_EXEC_MODE,
            };
            await tx
              .update(toolsTable)
              .set({
                capabilities: upsertVerbCatalogEntry(
                  toolRow?.capabilities ?? [],
                  entry
                ),
                updatedAt: new Date(),
              })
              .where(eq(toolsTable.id, parentTool.id));
          });
          wiring.catalogued = true;
        } catch (err) {
          logger.error(
            { toolId: parentTool.id, verbName: input.verbName, err },
            "createVerb: failed to append the verb catalogue entry"
          );
        }
      }

      // Identity of the thing just created, so a UI can select it inline
      // (create-then-configure, never a wizard) — plus the brick's parent so the
      // caller knows where it landed. `status` is `"created" | "proposed"`,
      // verbatim from the governed door; `wiring` says which read paths the verb
      // actually reached.
      return {
        ...result,
        verbName: input.verbName,
        toolId: parentTool.id,
        toolName: parentTool.name,
        wiring,
      };
    }),
});

// ─── Dependent-process lookup (shared by usedInProcesses + blastRadius) ───────

/**
 * THE one place that answers "which automations/playbooks reference this
 * capability node?". Both `usedInProcesses` (per-VERB backlinks) and
 * `blastRadius` (per-TOOL disconnect pre-flight) call it, so the access
 * predicate can never fork between them.
 *
 * The access construction is load-bearing and is the recurring defect class on
 * this surface: `scopedDb(...).predicate(automations)` is ANDed FIRST as the
 * floor, and the workspace filter is only a NARROWING inside that AND. A bare
 * `isNull(automations.workspaceId)` floor would match only pod-wide automations,
 * hide every workspace-scoped dependent, and make a revoke dialog say "nothing
 * depends on this" immediately before it breaks six live automations.
 *
 * The select is wider than `usedInProcesses` needs (`triggerType`/`nextRunAt`)
 * — those are free on the same scan and let a caller say which dependents are
 * actively scheduled rather than merely enabled.
 */
async function findDependentProcesses(
  ctx: Parameters<typeof AccessContext.from>[0],
  containment: ReturnType<typeof drizzleSql>,
  workspaceId?: string
) {
  const database = await getDb();
  const automationVisibility = scopedDb(AccessContext.from(ctx)).predicate(
    automations
  );

  const automationRows = await database
    .select({
      automationId: automations.id,
      name: automations.name,
      status: automations.status,
      triggerType: automations.triggerType,
      nextRunAt: automations.nextRunAt,
    })
    .from(automations)
    .where(
      and(
        automationVisibility,
        // A specific workspace only NARROWS and still includes pod-wide
        // (NULL) automations; no workspace → no narrow (the user floor).
        workspaceId
          ? or(
              isNull(automations.workspaceId),
              eq(automations.workspaceId, workspaceId)
            )
          : undefined,
        containment
      )
    )
    .orderBy(automations.name);

  const matchedAutomationIds = automationRows.map((r) => r.automationId);

  // Playbooks are TRANSITIVE only — a playbook row carries no capability node of
  // its own, so it can only be reached through a matched automation. Skip the
  // whole query when nothing matched (an empty `inArray` is both wasteful and a
  // driver footgun here).
  let playbookRows: Array<{
    playbookId: string;
    name: string;
    status: string;
  }> = [];
  if (matchedAutomationIds.length > 0) {
    const playbookVisibility = scopedDb(AccessContext.from(ctx)).predicate(
      playbooks
    );

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
          workspaceId
            ? or(
                isNull(playbooks.workspaceId),
                eq(playbooks.workspaceId, workspaceId)
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

  return { automationRows, playbookRows };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const capabilitiesRouter = router({
  /** Capability CONTAINERS (the named bundles) — CRUD + part attach/detach. */
  containers: capabilityContainersRouter,

  /**
   * The capability-BRICK registry: browse the bricks, create a brick.
   *
   * WHY IT LIVES HERE. A capability verb is to a process what an entity is to
   * the pod — a brick. You browse bricks in the brick's own router, exactly as
   * you browse entities in `entities.*`. The pre-existing sectioned door sits at
   * `playbooks.capabilityRegistry.list`, i.e. INSIDE one of the brick's
   * consumers, which inverts the dependency (a catalogue hosted by a consumer
   * can only ever be as wide as that consumer's altitude) — and it is built on
   * `workspaceProcedure`, so it 400s pod-wide. Neither is fixable in place
   * without breaking that door's live callers, so the brick catalogue is a NEW
   * door in the brick's own home. `playbooks.capabilityRegistry.list` stays
   * exactly as it is.
   *
   * ALTITUDE: `protectedProcedure`, workspace OPTIONAL — the Capabilities app is
   * `defaultScope: {type:'pod'}` and a pod-level catalogue must not be gated on
   * a selected workspace. Degradation is honest, not empty (see `sections`).
   */
  registry: capabilityRegistryRouter,

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
    // workspaceId OPTIONAL: capabilities are viewable POD-WIDE without an active
    // workspace lens (pod-global capabilities only). A lens ADDS its own containers.
    .input(z.object({ workspaceId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      return buildCapabilityCatalog({
        workspaceId: input.workspaceId ?? null,
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
      // Two soft links can carry a playbook match: the legacy single
      // `flowAutomationId` and the first-class `playbook_automations` join table.
      // Both, plus the access floor, live in `findDependentProcesses` — the ONE
      // implementation this door and `blastRadius` share.
      const { automationRows, playbookRows } = await findDependentProcesses(
        ctx,
        drizzleSql`${automations.flowDefinition} -> 'nodes' @> ${JSON.stringify(
          [{ type: "capability", data: { verbId: input.verbId } }]
        )}::jsonb`,
        input.workspaceId
      );

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
   * "What breaks if I disconnect this?" — the ONE read door every revoke
   * surface calls before severing a tool or a connection. Today eight UI
   * surfaces sever connections with no warning at all.
   *
   * PER-TOOL vs PER-CONNECTION — the asymmetry that shapes this whole door:
   * `CapabilityNodeDef` (packages/database/src/schema/automations.ts) carries
   * `capabilityId` (the tool row id) and `verbId` and NO connectionId/secretId/
   * account selector — the connection is resolved at RUN time from `secrets`.
   * So a per-CONNECTION automation count is structurally unbackable and is
   * never produced here. `automations`/`playbooks`/`grants` are always
   * per-TOOL; `sourcedEntityCount` is the one honest per-connection number.
   *
   * One JSONB containment scan covers the whole tool, replacing the N parallel
   * per-verb queries the UI does today.
   */
  blastRadius: protectedProcedure
    .input(
      z.object({
        // `tools.id` is a uuid column: a non-uuid here would reach postgres as
        // a 22P02 (500) on a door that already models "not found" as a 404.
        toolId: z.string().uuid(),
        /** Only narrows `sourcedEntityCount` — never the automation counts. */
        connectionId: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const userId = requireUserId(ctx.userId);

      // Subject gate. The dependent-process query is access-scoped on its own,
      // but neither `vault_grants` nor `entity_external_links` is a scoped
      // table — so the caller must first be able to SEE the tool.
      //
      // Visibility is NOT authority, and this is where the earlier version of
      // this door was wrong: `tools` is registered
      // `nullWorkspaceMeans:"podGlobalConfig"` (access/registry.ts), so every
      // pod-wide tool row is visible to every pod member. Seeing a tool
      // therefore cannot be the gate for reading its grants or another
      // member's connection. The two per-principal reads below carry their own
      // floors: grants are narrowed unless the caller OWNS the tool, and the
      // sourced-entity count is bound to the caller's own connection AND
      // joined through the `entities` access predicate.
      const [tool] = await database
        .select({
          id: toolsTable.id,
          createdBy: toolsTable.createdBy,
          credentialRef: toolsTable.credentialRef,
          config: toolsTable.config,
          verbs: toolsTable.capabilities,
        })
        .from(toolsTable)
        .where(
          and(
            scopedDb(AccessContext.from(ctx)).predicate(toolsTable),
            eq(toolsTable.id, input.toolId)
          )
        )
        .limit(1);
      if (!tool) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Tool not found" });
      }

      // A `type:"capability"` node points at this tool in EITHER of two ways:
      // `data.capabilityId` (the tool row id) or `data.verbId` alone —
      // `CapabilityNodeDef.capabilityId` is OPTIONAL (schema/automations.ts)
      // and the shipped first-party report automation emits four verb-only
      // nodes (`ensure-report-automation.ts`). A capabilityId-only containment
      // reports ZERO dependents for the built-in `synap_core` tool — the exact
      // "nothing depends on this" lie this door exists to prevent. So the
      // tool's own verb catalog is ORed in alongside the id match.
      const capabilityNodeMatch = (data: Record<string, string>) =>
        drizzleSql`${automations.flowDefinition} -> 'nodes' @> ${JSON.stringify(
          [{ type: "capability", data }]
        )}::jsonb`;
      const byToolId = capabilityNodeMatch({ capabilityId: input.toolId });
      const verbIds = (tool.verbs ?? [])
        .map((v) => v.id)
        .filter((id): id is string => !!id);

      const { automationRows, playbookRows } = await findDependentProcesses(
        ctx,
        or(
          byToolId,
          ...verbIds.map((v) => capabilityNodeMatch({ verbId: v }))
        ) ?? byToolId,
        input.workspaceId
      );

      // Grants on the tool itself. Indexed by
      // (grantable_type, grantable_id, revoked_at) — the hot-path index.
      //
      // FLOOR, not just a lens: a grant row names a principal (`grantedTo`), a
      // scope and an exec-mode, so it is not public metadata. Unless the caller
      // OWNS the tool, only grants the caller is a party to (issued them, or is
      // the grantee) are returned. A supplied workspace then NARROWS on top —
      // the same `or(isNull, eq)` shape the automation query uses, so pod-wide
      // grants are never dropped by the narrowing alone.
      const callerOwnsTool = tool.createdBy === userId;
      const grantRows = await database
        .select({
          grantId: vaultGrants.id,
          grantedTo: vaultGrants.grantedTo,
          scope: vaultGrants.scope,
          execMode: vaultGrants.execMode,
          expiresAt: vaultGrants.expiresAt,
        })
        .from(vaultGrants)
        .where(
          and(
            eq(vaultGrants.grantableType, "tool"),
            eq(vaultGrants.grantableId, input.toolId),
            isNull(vaultGrants.revokedAt),
            callerOwnsTool
              ? undefined
              : or(
                  eq(vaultGrants.createdBy, userId),
                  eq(vaultGrants.grantedTo, userId)
                ),
            input.workspaceId
              ? or(
                  isNull(vaultGrants.workspaceId),
                  eq(vaultGrants.workspaceId, input.workspaceId)
                )
              : undefined
          )
        )
        .orderBy(vaultGrants.createdAt);

      // The ONE honest per-connection number: literally the rows the detach
      // path flips to "disconnected" (capability-nango-sync.ts). `null` (not 0)
      // when no connectionId was passed — "not asked" must never render as
      // "nothing would be affected".
      //
      // `entity_external_links` carries NO userId and NO workspaceId column and
      // has NO VisibilityRule, so the access layer structurally cannot filter
      // it. Two gates stand in instead:
      //   (1) BINDING + OWNERSHIP — the connectionId must belong to this caller
      //       AND to this tool. Nango connection ids are
      //       `{userId}:{podId}:{provider}` (NangoConnector.buildConnectionId)
      //       and a connectable tool's provider is its `nango://<provider>`
      //       credentialRef / `config.providerConfigKey` (the same derivation as
      //       `providerConfigKeyOf` in capability-nango-sync.ts). Without this,
      //       an arbitrary connectionId enumerates a stranger's link count, and
      //       a stale one returns a confident count for a DIFFERENT connection
      //       inside the one dialog whose job is to be trusted before a revoke.
      //   (2) VISIBILITY — the count joins `entities` under the access
      //       predicate, so it only counts rows the caller can already see.
      let sourcedEntityCount: number | null = null;
      if (input.connectionId) {
        const toolConfig = (tool.config ?? {}) as Record<string, unknown>;
        const toolProvider =
          typeof toolConfig.providerConfigKey === "string"
            ? toolConfig.providerConfigKey
            : tool.credentialRef?.startsWith("nango://")
              ? tool.credentialRef.slice("nango://".length)
              : null;
        const idParts = input.connectionId.split(":");
        const connectionProvider =
          idParts.length >= 3 ? idParts.slice(2).join(":") : null;
        if (
          !toolProvider ||
          !input.connectionId.startsWith(`${userId}:`) ||
          connectionProvider !== toolProvider
        ) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Connection not found for this tool",
          });
        }

        const [row] = await database
          .select({ count: drizzleSql<number>`count(*)::int` })
          .from(entityExternalLinks)
          .innerJoin(entities, eq(entities.id, entityExternalLinks.entityId))
          .where(
            and(
              scopedDb(AccessContext.from(ctx)).predicate(entities),
              eq(entityExternalLinks.nangoConnectionId, input.connectionId),
              eq(entityExternalLinks.status, "active")
            )
          );
        sourcedEntityCount = row?.count ?? 0;
      }

      return {
        automations: automationRows,
        playbooks: playbookRows,
        grants: grantRows,
        sourcedEntityCount,

        /**
         * ALWAYS TRUE — a hardcoded constant, never computed, never `false`.
         *
         * These counts are a FLOOR, never a total. The containment match sees
         * `type:"capability"` nodes only, so it structurally MISSES:
         *   - `skill` nodes — a verb resolves to a backing skill, so a skill
         *     node invokes the very same tool invisibly to this query;
         *   - `sub_automation` nodes — the child's nodes are never scanned;
         *   - `playbook_run` nodes — same, one level down;
         *   - tools an agent chooses at RUN time (unknowable before the run);
         *   - usage in workspaces the caller cannot see (correctly filtered out
         *     by the access floor, but still real breakage for someone else);
         *   - stale node ids pointing at already-deleted tools;
         *   - a verb-only node (`data.verbId`, no `capabilityId`) whose verb is
         *     NOT in this tool's `capabilities` catalog. The catalog is derived
         *     at apply time, so a node written against a verb the tool no longer
         *     advertises — or never did — is invisible to the ORed verb match.
         *
         * `grants` is likewise a FLOOR and not a total: unless the caller owns
         * the tool, grants the caller is not a party to are omitted (see the
         * grant query above). A team-mate's grant on a pod-wide tool still
         * breaks when the tool is revoked.
         * No transitive traversal exists anywhere in this codebase, so none of
         * the above can be closed by widening this query alone.
         *
         * Callers MUST render this as "at least N" / "N or more" — never as an
         * exhaustive total, and never as "nothing depends on this" when N is 0.
         */
        incomplete: true as const,
      };
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
