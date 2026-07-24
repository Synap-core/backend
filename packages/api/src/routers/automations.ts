/**
 * Automations Router
 *
 * CRUD for workflow automations + run history.
 * Automations are created as drafts (typically by AI), then activated by the user.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { AccessContext, scopedDb } from "../access/index.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { stableStringify } from "../utils/stable-stringify.js";
import { normalizeEventSource } from "../lib/event-helpers.js";
import { getDefaultActiveService } from "../utils/intelligence-routing.js";
// Import from events/unified sub-path because tsup's code-splitting drops
// validateEventPattern from the main index.js and events/index.js bundles.
import { validateEventPattern } from "@synap-core/types/events/unified";
import {
  getDb,
  eq,
  and,
  or,
  isNull,
  inArray,
  desc,
  drizzleSql,
  automations,
  automationRuns,
  automationStepRuns,
  channels,
  ChannelRepository,
} from "@synap/database";
import type { AutomationTriggerConfig, FlowDefinition } from "@synap/database";
// Shared with the runtime run-narration resolver (post-run-summary.ts): the ONE
// SSOT for `metadata.resultRouting`. Imported (not re-copied) — the static
// feedTargets resolver must classify routing identically to `resolveRunChannel`.
import {
  resolveResultRouting,
  selectRunChannelBranch,
} from "@synap/jobs/utils/post-run-summary.js";
import { subjectEntityIdFromPayload } from "@synap/jobs/utils/run-subject.js";
import { TRPCError } from "@trpc/server";

/**
 * Compute next cron run time by forward-scanning from a base date.
 * Supports standard 5-field cron (minute hour dayOfMonth month dayOfWeek).
 */
function computeNextCronRunAt(cronExpr: string, fromDate: Date): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;
  const dayNames: Record<string, number> = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
  };

  function matches(field: string, value: number): boolean {
    if (field === "*") return true;
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && value % step === 0;
    }
    for (const v of field.split(",")) {
      if (v.includes("-")) {
        const [s, e] = v.split("-").map(Number);
        if (value >= s && value <= e) return true;
        continue;
      }
      const resolved = dayNames[v.toUpperCase()] ?? parseInt(v, 10);
      if (resolved === value) return true;
    }
    return false;
  }

  const candidate = new Date(fromDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      matches(minExpr, candidate.getMinutes()) &&
      matches(hourExpr, candidate.getHours()) &&
      matches(domExpr, candidate.getDate()) &&
      matches(monthExpr, candidate.getMonth() + 1) &&
      matches(dowExpr, candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/**
 * One-line human summary of an entity-create trigger for a UI card. When the
 * trigger carries a `filters.profileSlug` it names that profile; an absent
 * filter means the automation fires on ANY entity creation.
 */
function summarizeEntityCreateTrigger(config: AutomationTriggerConfig): string {
  const slug = config.filters?.profileSlug as string | undefined;
  return slug ? `On ${slug} created` : "On any entity created";
}

export const automationsRouter = router({
  // ── List automations ────────────────────────────────────────────────────────

  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().nullable().optional(),
          status: z.enum(["draft", "active", "paused", "error"]).optional(),
          triggerType: z
            .enum(["event", "cron", "webhook", "manual"])
            .optional(),
          limit: z.number().min(1).max(100).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      // Membership guard from the centralized access layer — without it a
      // caller-supplied workspaceId leaks every workspace's automations.
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );
      const rows = await database
        .select()
        .from(automations)
        .where(
          and(
            visibility,
            // Pod-wide floor (`visibility`); a specific workspace only NARROWS,
            // and still includes pod-wide (NULL) rows. No workspace → no narrow.
            input?.workspaceId
              ? or(
                  isNull(automations.workspaceId),
                  eq(automations.workspaceId, input.workspaceId)
                )
              : undefined,
            input?.status ? eq(automations.status, input.status) : undefined,
            input?.triggerType
              ? eq(automations.triggerType, input.triggerType)
              : undefined
          )
        )
        .orderBy(desc(automations.updatedAt))
        .limit(input?.limit ?? 50);

      return { automations: rows };
    }),

  // ── Feed targets — the static "automation → where its runs land" resolver ────

  /**
   * Backend-accurate answer to "which channel (or subject KIND) does each
   * automation's runs feed into?" — the static counterpart of the runtime
   * `resolveRunChannel` (jobs/utils/post-run-summary.ts). The Atlas "loops" map
   * consumes this instead of the old broad client-side channel approximation.
   *
   * BRANCH ORDER mirrors `resolveRunChannel` EXACTLY:
   *   1. `per_entity` routing + a subject KIND (`triggerConfig.filters.profileSlug`,
   *      the SAME canonical field the trigger-matcher matches on) → the subject
   *      kind, `fansOut:true`. Each run lands in ITS entity's channel at runtime,
   *      so statically we can only name the fan-out KIND. Slug absent ⇒ fall
   *      through (a per_entity automation with no subject filter routes per-type).
   *   2. `triggerConfig.channelId` set → that channel (priority over per_type for
   *      ALL non-per_entity routings, exactly as `resolveRunChannel`).
   *   3. else `per_type` → the automation's durable run channel, resolved
   *      READ-ONLY via `findAutomationRunChannel` (NEVER creates — a read path must
   *      not spawn a channel; `undefined` on a miss just yields no channelId).
   *
   * SCOPING — automations loaded through the SAME scoped predicate + workspace
   * narrow as `list`. Channel TITLES are resolved through the channels
   * VisibilityRule (`scopedDb(...).predicate(channels)`), so a channelId the
   * caller can't see returns its id but no title — never a cross-user title leak.
   */
  feedTargets: protectedProcedure
    .input(
      z
        .object({ workspaceId: z.string().uuid().nullable().optional() })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );
      const rows = await database
        .select()
        .from(automations)
        .where(
          and(
            visibility,
            input?.workspaceId
              ? or(
                  isNull(automations.workspaceId),
                  eq(automations.workspaceId, input.workspaceId)
                )
              : undefined
          )
        )
        .orderBy(desc(automations.updatedAt));

      const channelRepo = new ChannelRepository(database);

      // Anonymous (structural) type — a named local interface would leak as a
      // private name into the exported router's inferred type (TS4025).
      const targets: Array<{
        automationId: string;
        mode: "per_type" | "per_entity" | "trigger";
        channelId?: string;
        channelTitle?: string;
        subjectProfileSlug?: string;
        fansOut?: boolean;
      }> = [];
      for (const a of rows) {
        const mode = resolveResultRouting(a.metadata);
        const trigger = a.triggerConfig as AutomationTriggerConfig | null;

        // The branch order is NOT re-derived here — it comes from the same pure
        // door `resolveRunChannel` uses, so this preview cannot drift from where
        // runs actually land. This is a PREDICTION over an automation with no
        // run, so the run-level "does this run have a subject?" question becomes
        // "does this automation have a subject KIND to fan out over?".
        const slug = trigger?.filters?.profileSlug as string | undefined;
        const decision = selectRunChannelBranch({
          routing: mode,
          hasSubject: Boolean(slug),
          triggerChannelId: trigger?.channelId as string | undefined,
        });

        // per_entity + subject KIND → fan out over that kind (no single channel).
        if (decision.branch === "subject_entity") {
          targets.push({
            automationId: a.id,
            mode,
            subjectProfileSlug: slug,
            fansOut: true,
          });
          continue;
        }

        if (decision.branch === "trigger_channel") {
          targets.push({
            automationId: a.id,
            mode,
            channelId: decision.channelId,
          });
          continue;
        }

        // per_type durable run channel — READ-ONLY, never created.
        const runChannel = await channelRepo.findAutomationRunChannel(a.id);
        if (runChannel) {
          targets.push({ automationId: a.id, mode, channelId: runChannel.id });
        } else {
          targets.push({ automationId: a.id, mode });
        }
      }

      // Batch-resolve titles for every collected channelId in ONE scoped IN(...)
      // select. Unseen (unauthorized) channels simply don't appear → no title.
      const channelIds = [
        ...new Set(
          targets
            .map((t) => t.channelId)
            .filter((id): id is string => typeof id === "string")
        ),
      ];
      if (channelIds.length > 0) {
        const chanVisibility = scopedDb(AccessContext.from(ctx)).predicate(
          channels
        );
        const titleRows = await database
          .select({ id: channels.id, title: channels.title })
          .from(channels)
          .where(and(chanVisibility, inArray(channels.id, channelIds)));
        const titleById = new Map(
          titleRows.map((r) => [r.id, r.title] as const)
        );
        for (const t of targets) {
          if (!t.channelId) continue;
          const title = titleById.get(t.channelId);
          if (title) t.channelTitle = title;
        }
      }

      return { targets };
    }),

  // ── Match automations that would fire on creating an entity profile ─────────

  /**
   * Match active automations whose event-trigger would fire on the creation of
   * a given entity profile — the Capture→Automation matcher, mirror of
   * `playbooks.matchForEntity`. Given a captured/created entity's `profileSlug`,
   * answer "is there an automation that reacts to creating this kind of thing?"
   * so the capture done-state can surface + offer to run it.
   *
   * PREDICATE — an automation "would fire on entity.create of profileSlug X"
   * when (source of truth: packages/jobs/src/workers/automation-trigger-matcher.ts):
   *   • status='active' AND triggerType='event'                (matcher :306-310)
   *   • triggerConfig.eventPattern matches the fixed operational event
   *     `entity.create.completed` (events event-types.ts ENTITY_CREATED).
   *     `matchPattern` (:59) accepts it exactly OR via trailing wildcard, so the
   *     matching stored patterns are exactly:
   *       `entity.create.completed` | `entity.create.*` | `entity.*`
   *   • the profileSlug filter passes. Entity events have NO
   *     `matchTriggerSpecificFilters` branch (:112) — profileSlug is a GENERIC
   *     filter (event-types.ts filterKeys:["profileSlug"]) stored at
   *     `triggerConfig.filters.profileSlug` and matched by exact equality
   *     (`matchFilters` :78, applied at :419). An absent filter matches EVERY
   *     profileSlug.
   *
   * SCOPING — `scopedDb(AccessContext.from(ctx)).predicate(automations)` yields
   * the access-layer user floor (never leaks cross-user), narrowed with
   * `or(isNull(workspaceId), eq(workspaceId, input.workspaceId))` EXACTLY like
   * `list`/`get` above: pod-wide (NULL-workspace) globals are KEPT, the target
   * workspace is included, other workspaces (which can never fire for this
   * entity) are excluded. Returns the lean card shape; [] when none.
   */
  matchForEntity: protectedProcedure
    .input(
      z.object({
        profileSlug: z.string().min(1),
        // Round-tripped by the caller into `trigger`/a run as the subject;
        // matching is by profile, so it does not narrow this query.
        entityId: z.string().uuid().optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );

      const rows = await database
        .select()
        .from(automations)
        .where(
          and(
            visibility,
            // Same narrow as `list`: keep pod-wide (NULL) globals + the target
            // workspace; exclude other workspaces.
            or(
              isNull(automations.workspaceId),
              eq(automations.workspaceId, input.workspaceId)
            ),
            eq(automations.status, "active"),
            eq(automations.triggerType, "event"),
            // eventPattern ∈ the set matchPattern accepts for the fixed
            // `entity.create.completed` event.
            drizzleSql`${automations.triggerConfig}->>'eventPattern' = ANY(ARRAY['entity.create.completed','entity.create.*','entity.*'])`,
            // filters.profileSlug absent (fires for any) OR equals the request.
            drizzleSql`(${automations.triggerConfig}->'filters'->>'profileSlug' IS NULL OR ${automations.triggerConfig}->'filters'->>'profileSlug' = ${input.profileSlug})`
          )
        )
        .orderBy(desc(automations.updatedAt));

      return rows.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description ?? undefined,
        triggerSummary: summarizeEntityCreateTrigger(a.triggerConfig),
      }));
    }),

  // ── Get single automation ───────────────────────────────────────────────────

  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // scopedDb auto-ANDs the visibility predicate, so a foreign workspaceId
      // simply finds nothing instead of leaking the row.
      const row = await scopedDb(AccessContext.from(ctx)).findFirst<
        typeof automations.$inferSelect
      >(automations, {
        where: and(
          eq(automations.id, input.id),
          input.workspaceId
            ? or(
                isNull(automations.workspaceId),
                eq(automations.workspaceId, input.workspaceId)
              )
            : undefined
        ),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      return row;
    }),

  // ── Create automation ───────────────────────────────────────────────────────

  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().nullable().optional(),
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        triggerType: z.enum(["event", "cron", "webhook", "manual"]),
        triggerConfig: z.record(z.string(), z.unknown()).default({}),
        flowDefinition: z.object({
          nodes: z.array(z.record(z.string(), z.unknown())),
          edges: z.array(z.record(z.string(), z.unknown())),
        }),
        status: z.enum(["draft", "active", "paused", "error"]).default("draft"),
        metadata: z.record(z.string(), z.unknown()).optional(),
        /** Per-automation persistent config/state — resolves {{automation.state.*}}. */
        state: z.record(z.string(), z.unknown()).optional(),
        /** Explicit agent user ID for AI-created automations */
        agentUserId: z.string().uuid().optional(),
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent"])
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const createdBy = input.agentUserId ?? ctx.userId!;

      // Validate event pattern at API boundary so bad patterns are caught early
      // rather than silently never matching at runtime.
      if (
        input.triggerType === "event" &&
        typeof input.triggerConfig?.eventPattern === "string"
      ) {
        try {
          validateEventPattern(input.triggerConfig.eventPattern);
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: (err as Error).message,
          });
        }
      }

      // Governance membrane. AI agents (agentUserId set) route through
      // checkPermissionOrPropose; on "proposed" no row is written and the
      // proposal id is surfaced. Operator-initiated creates (no agentUserId) are
      // DIRECT writes: an automation is operator configuration (a template /
      // workflow), not AI-authored content. Hub-protocol calls are all branded
      // source:"intelligence", so without this split an operator's own CLI
      // install would be gated as AI and routed to a proposal — which the approve
      // flow can't even materialize for automations. RBAC is still enforced on
      // the operator path; we just never propose.
      if (input.agentUserId) {
        const perm = await checkPermissionOrPropose({
          userId: ctx.userId,
          agentUserId: input.agentUserId,
          workspaceId: input.workspaceId ?? null,
          subjectType: "automation",
          action: "create",
          // input.source accepts "user"/"ai"/"agent" (business-provenance values
          // for the `createdVia` metadata below) but those are not valid
          // EventSources — normalize via the canonical guard before this reaches
          // the top-level event source.
          source: normalizeEventSource(input.source),
          // Widened (object-proposal manifest W1): carry the FULL create input so
          // an approved proposal materializes a real automation via
          // automationsRouter.create — not just a labelled shell. This branch is
          // the AI/agent-only governance path (guarded by `if (input.agentUserId)`
          // above), and only the PROPOSED (pending) row's stored data changes; the
          // operator direct-create insert below is byte-untouched.
          data: {
            name: input.name,
            description: input.description,
            triggerType: input.triggerType,
            triggerConfig: input.triggerConfig,
            flowDefinition: input.flowDefinition,
            status: input.status,
            metadata: input.metadata,
            state: input.state,
          },
        });
        if ("denied" in perm && perm.denied) {
          throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
        }
        if ("proposalId" in perm) {
          return {
            status: "proposed" as const,
            id: null as string | null,
            message: "Automation creation proposed for review",
            proposalId: perm.proposalId,
          };
        }
      } else if (input.workspaceId) {
        // Operator direct write — enforce workspace RBAC (deny if not permitted),
        // but never propose. Pod-wide (no workspaceId) is owner-implicit.
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
      }

      // A cron automation born `active` (direct operator create, OR an
      // agent-proposed create materialized at approval time — the approve-executor
      // re-runs THIS proc) must carry `nextRunAt`, or the cron scheduler's
      // `status='active' AND nextRunAt <= now` filter (automation-cron-scheduler.ts)
      // never selects it and it silently never fires. `activate` computes this for
      // the activate-later path; compute it here for the born-active path too,
      // reading `triggerConfig.expression` exactly like `activate` does. Only cron
      // needs it — event/webhook/manual are dispatched by other paths.
      let createNextRunAt: Date | null = null;
      if (input.status === "active" && input.triggerType === "cron") {
        const cronExpression = (input.triggerConfig as Record<string, unknown>)
          ?.expression as string | undefined;
        if (cronExpression) {
          createNextRunAt = computeNextCronRunAt(cronExpression, new Date());
        }
      }

      const [row] = await database
        .insert(automations)
        .values({
          workspaceId: input.workspaceId ?? null,
          createdBy,
          name: input.name,
          description: input.description,
          triggerType: input.triggerType,
          triggerConfig: input.triggerConfig,
          flowDefinition: input.flowDefinition as unknown as FlowDefinition,
          status: input.status,
          ...(createNextRunAt ? { nextRunAt: createNextRunAt } : {}),
          state: input.state ?? {},
          metadata: {
            ...(input.metadata ?? {}),
            createdVia:
              input.source === "agent" || input.source === "ai"
                ? ("ai" as const)
                : ("manual" as const),
          },
        })
        .returning();

      return {
        status: "created" as const,
        id: row.id as string | null,
        message: `Automation "${input.name}" created as ${input.status}`,
        proposalId: null as string | null,
      };
    }),

  // ── Update automation ───────────────────────────────────────────────────────

  update: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().nullable().optional(),
        id: z.string().uuid(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
        triggerType: z.enum(["event", "cron", "webhook", "manual"]).optional(),
        triggerConfig: z.record(z.string(), z.unknown()).optional(),
        flowDefinition: z
          .object({
            nodes: z.array(z.record(z.string(), z.unknown())),
            edges: z.array(z.record(z.string(), z.unknown())),
            precondition: z.string().optional(),
          })
          .optional(),
        status: z.enum(["draft", "active", "paused", "error"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        state: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      // Load by id ALONE, then gate on the row's real workspace — never the
      // request-supplied workspaceId (that gates nothing).
      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
        columns: {
          id: true,
          workspaceId: true,
          createdBy: true,
          version: true,
          flowDefinition: true,
          triggerType: true,
          triggerConfig: true,
        },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });

      // Validate event pattern on update too
      if (
        input.triggerConfig !== undefined &&
        typeof (input.triggerConfig as Record<string, unknown>)
          ?.eventPattern === "string"
      ) {
        try {
          validateEventPattern(
            (input.triggerConfig as Record<string, unknown>)
              .eventPattern as string
          );
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: (err as Error).message,
          });
        }
      }

      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined)
        updates.description = input.description;
      if (input.triggerType !== undefined)
        updates.triggerType = input.triggerType;
      if (input.triggerConfig !== undefined)
        updates.triggerConfig = input.triggerConfig;
      if (input.flowDefinition !== undefined)
        updates.flowDefinition = input.flowDefinition;
      if (input.status !== undefined) updates.status = input.status;
      if (input.metadata !== undefined) updates.metadata = input.metadata;
      if (input.state !== undefined) updates.state = input.state;

      // Bump the monotonic definition version when a definition-affecting
      // field actually changes (compared against the loaded row, so a rename or
      // status toggle doesn't inflate it). Stamped into each run's
      // definitionSnapshot so "what ran" can be diffed against "today".
      const definitionChanged =
        (updates.flowDefinition !== undefined &&
          stableStringify(updates.flowDefinition) !==
            stableStringify(existing.flowDefinition)) ||
        (updates.triggerType !== undefined &&
          updates.triggerType !== existing.triggerType) ||
        (updates.triggerConfig !== undefined &&
          stableStringify(updates.triggerConfig) !==
            stableStringify(existing.triggerConfig));
      if (definitionChanged) updates.version = (existing.version ?? 1) + 1;

      await database
        .update(automations)
        .set(updates)
        .where(eq(automations.id, input.id));

      return {
        status: "updated",
        message: `Automation updated`,
      };
    }),

  // ── Delete automation ───────────────────────────────────────────────────────

  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
        columns: { id: true, workspaceId: true, createdBy: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });

      await database.delete(automations).where(eq(automations.id, input.id));

      return { status: "deleted" };
    }),

  // ── Activate / Pause ───────────────────────────────────────────────────────

  activate: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });
      if (existing.status === "active") {
        return { status: "already_active" };
      }

      // For cron triggers, compute the next run time
      let nextRunAt: Date | null = null;
      if (existing.triggerType === "cron") {
        const triggerConfig = existing.triggerConfig as Record<string, unknown>;
        const cronExpression = triggerConfig?.expression as string | undefined;
        if (cronExpression) {
          nextRunAt = computeNextCronRunAt(cronExpression, new Date());
        }
      }

      await database
        .update(automations)
        .set({
          status: "active",
          updatedAt: new Date(),
          errorMessage: null,
          ...(nextRunAt ? { nextRunAt } : {}),
        })
        .where(eq(automations.id, input.id));

      return { status: "activated", nextRunAt: nextRunAt?.toISOString() };
    }),

  pause: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
        columns: {
          id: true,
          status: true,
          workspaceId: true,
          createdBy: true,
        },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });

      await database
        .update(automations)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(automations.id, input.id));

      return { status: "paused" };
    }),

  // ── Runs: list ──────────────────────────────────────────────────────────────

  listRuns: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().nullable().optional(),
        automationId: z.string().uuid(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();

      // Verify the automation is visible to this caller (membership-gated via
      // the access layer) BEFORE returning its run history.
      const automation = await scopedDb(AccessContext.from(ctx)).findFirst<{
        id: string;
      }>(automations, {
        where: and(
          eq(automations.id, input.automationId),
          input.workspaceId
            ? or(
                isNull(automations.workspaceId),
                eq(automations.workspaceId, input.workspaceId)
              )
            : undefined
        ),
        columns: { id: true },
      });
      if (!automation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }

      const rows = await database
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, input.automationId))
        .orderBy(desc(automationRuns.startedAt))
        .limit(input.limit ?? 20);

      return { runs: rows };
    }),

  // ── Runs: get with step runs ────────────────────────────────────────────────

  getRun: protectedProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();

      const run = await scopedDb(AccessContext.from(ctx)).findFirst<
        typeof automationRuns.$inferSelect
      >(automationRuns, {
        where: and(
          eq(automationRuns.id, input.runId),
          input.workspaceId
            ? or(
                isNull(automationRuns.workspaceId),
                eq(automationRuns.workspaceId, input.workspaceId)
              )
            : undefined
        ),
      });
      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Run not found",
        });
      }

      const steps = await database
        .select()
        .from(automationStepRuns)
        .where(eq(automationStepRuns.runId, run.id));

      return { run, steps };
    }),

  // ── AI: Diagnose run ────────────────────────────────────────────────────────

  diagnoseRun: protectedProcedure
    .input(
      z.object({
        automationName: z.string(),
        flowDefinition: z.record(z.string(), z.unknown()),
        run: z.object({
          id: z.string(),
          status: z.string(),
          startedAt: z.string(),
          finishedAt: z.string().optional(),
          errorMessage: z.string().optional(),
        }),
        steps: z.array(
          z.object({
            nodeId: z.string(),
            nodeType: z.string(),
            status: z.string(),
            resolvedInputs: z.record(z.string(), z.unknown()).optional(),
            output: z.record(z.string(), z.unknown()).optional(),
            errorMessage: z.string().optional(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Canonical IS credential resolution (decrypted DB key), not stale env.
      const { endpoint: isUrl, apiKey: isApiKey } =
        await getDefaultActiveService();

      const response = await fetch(`${isUrl}/api/automations/diagnose-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
        },
        body: JSON.stringify({
          workspaceId: ctx.workspaceId ?? null,
          userId: ctx.userId,
          ...input,
        }),
      });

      if (!response.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "IS call failed",
        });
      }

      return response.json() as Promise<{
        explanation: string;
        suggestions: string[];
      }>;
    }),

  // ── AI: Generate flow ───────────────────────────────────────────────────────

  generateFlow: protectedProcedure
    .input(
      z.object({
        prompt: z.string().min(1).max(2000),
        existingFlow: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Canonical IS credential resolution (decrypted DB key), not stale env.
      const { endpoint: isUrl, apiKey: isApiKey } =
        await getDefaultActiveService();

      const response = await fetch(`${isUrl}/api/automations/generate-flow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
        },
        body: JSON.stringify({
          workspaceId: ctx.workspaceId ?? null,
          userId: ctx.userId,
          ...input,
        }),
      });

      if (!response.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "IS call failed",
        });
      }

      return response.json() as Promise<{
        flowDefinition: { nodes: unknown[]; edges: unknown[] };
        name: string;
        explanation: string;
      }>;
    }),

  // ── Manual trigger ──────────────────────────────────────────────────────────

  trigger: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
        /** Durable entity lens for this run (separate from arbitrary payload). */
        subjectEntityId: z.string().uuid().optional(),
        /** Optional payload to inject as trigger.payload in the execution context */
        payload: z.record(z.string(), z.unknown()).optional(),
        /** Explicit agent user ID when an AI agent asks for the run (governed). */
        agentUserId: z.string().uuid().optional(),
        /** AI reasoning surfaced on the proposal card. */
        reasoning: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const { getBoss } = await import("@synap/jobs");

      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      if (input.workspaceId && input.workspaceId !== existing.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "workspaceId does not match the automation workspace.",
        });
      }
      // Gate on the row's real workspace — triggering is cross-workspace
      // CODE EXECUTION, so this guard is critical.
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });
      // An explicit manual trigger bypasses the normal trigger config, so a
      // DRAFT is test-runnable on demand (e.g. run a draft cron once before
      // activating it). Only paused/error block a non-manual-type automation —
      // those states signal "do not run".
      const runnableStatus =
        existing.status === "active" || existing.status === "draft";
      if (!runnableStatus && existing.triggerType !== "manual") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot trigger automation with status="${existing.status}". Activate it, or use a manual trigger type.`,
        });
      }
      // Governance membrane for the AGENT caller. Triggering runs the whole
      // flow — including `webhook` and `command` nodes — so this is CODE
      // EXECUTION, strictly wider than `run_command`, which IS gated
      // (hub-protocol/rest/commands.ts `POST /commands/execute`). `automation`
      // + `execute` mirrors that door's `{command, execute}` pair and reuses an
      // already-inventoried verb (`requiredPermissionFor("execute") = "write"`).
      // `automation.execute` is NOT in DEFAULT_AUTO_APPROVE, so an agent run
      // routes to a proposal.
      //
      // Operator-initiated triggers are DIRECT, exactly like the create door:
      // gate only `if (agentUserId)`. Hub-protocol calls are all branded
      // source:"intelligence", so gating on source would send an operator's own
      // UI/CLI "run now" to a proposal. RBAC for the operator path is unchanged
      // (assertWorkspaceWrite above); the agent path additionally runs the gate,
      // which owns the agent's own RBAC + propose/execute decision.
      const agentUserId = input.agentUserId ?? ctx.agentUserId ?? undefined;
      if (agentUserId) {
        const perm = await checkPermissionOrPropose({
          userId: ctx.userId!,
          agentUserId,
          workspaceId: existing.workspaceId ?? null,
          subjectType: "automation",
          action: "execute",
          source: "intelligence",
          data: {
            automationId: existing.id,
            name: existing.name,
            triggerType: existing.triggerType,
            payload: input.payload,
            subjectEntityId: input.subjectEntityId,
          },
          reasoning: input.reasoning,
        });
        if ("denied" in perm && perm.denied) {
          throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
        }
        if ("proposalId" in perm) {
          return {
            status: "proposed" as const,
            runId: null as string | null,
            proposalId: perm.proposalId as string | null,
            message: `Running "${existing.name}" proposed for review`,
          };
        }
      }

      // Older generic action renderers send the entity in payload. Accept that
      // compatibility shape via the shared subject door (which enforces the
      // UUID-only rule every run-creating path shares); callers can use the
      // explicit input for new integrations.
      const subjectEntityId =
        input.subjectEntityId ?? subjectEntityIdFromPayload(input.payload);

      const [run] = await database
        .insert(automationRuns)
        .values({
          automationId: existing.id,
          workspaceId: existing.workspaceId,
          subjectEntityId,
          triggeredBy: ctx.userId!,
          triggerPayload: {
            type: "manual",
            triggeredBy: ctx.userId!,
            timestamp: new Date().toISOString(),
            ...(input.payload ?? {}),
          },
          status: "running",
        })
        .returning({ id: automationRuns.id });

      const boss = getBoss();
      await boss.send("automation-execute", {
        runId: run.id,
        automationId: existing.id,
        workspaceId: existing.workspaceId,
        automationContext: {
          automationRunId: run.id,
          automationId: existing.id,
          chainDepth: 0,
          rootRunId: run.id,
          chainAutomationIds: [existing.id],
        },
      });

      return {
        status: "triggered" as const,
        runId: run.id as string | null,
        proposalId: null as string | null,
      };
    }),
});
