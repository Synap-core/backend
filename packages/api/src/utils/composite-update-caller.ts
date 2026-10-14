/**
 * composite-update-caller — the ONE `updateCaller` for the composite `update_*`
 * ops (a Library rebuild changing the Tools / Templates / Rules / Lists and the
 * group container an earlier bundle made).
 *
 * Every kind routes to its object's EXISTING update door, re-run as the
 * principal the governance decision was already made for (the approver, or
 * the importing person on a direct write) — no `agentUserId`, so a re-entrant
 * gate grants instead of filing a second proposal:
 *
 *   update_skill      → `skills.update`            (name / description / body)
 *   update_rule       → `updateRuleGoverned`       (intent, scope kept)
 *   update_automation → `automations.update`       (name / description)
 *   update_playbook   → `playbooks.update`         (name / description / goal)
 *   update_view       → `views.update`             (name / description / config,
 *                                                   config MERGED over stored)
 *   update_entity     → `entities.update`          (title / description / props)
 *
 * Around each write it reads the patched columns BEFORE and AFTER, which is
 * what the record stamps and what revert restores (`row_patch` targets in
 * `safe-revert.ts`; entity diffs through the existing property/field targets).
 * The column names it reads are exactly the ones `safe-revert` may restore
 * (`ROW_PATCH_COLUMNS`) — a field added to a patch must be added to both, or
 * the undo would refuse it as `not_owned`.
 */

import { TRPCError } from "@trpc/server";
import {
  automations,
  entities,
  eq,
  getWorkspaceMembership,
  playbooks,
  skills,
  views,
} from "@synap/database";
import type { CompositeUpdateOperation } from "@synap-core/types/proposals";
import type { CompositeUpdateCaller } from "./materialize-composite.js";
import type { RuleLoopCallerContext } from "./rule-loop-callers.js";

type Database = RuleLoopCallerContext["database"];

/** A door that answered "proposed" did NOT write — never counted as applied. */
function assertWritten(result: unknown, what: string): void {
  const status = (result as { status?: unknown } | null | undefined)?.status;
  if (status === "proposed") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `${what} was routed to a proposal instead of being applied; it was NOT changed.`,
    });
  }
  if (status === "not_found" || status === "denied") {
    const reason = (result as { reason?: unknown }).reason;
    throw new TRPCError({
      code: status === "not_found" ? "NOT_FOUND" : "FORBIDDEN",
      message: `${what} did not apply (${status}${typeof reason === "string" ? `: ${reason}` : ""})`,
    });
  }
}

/** The patched columns of one row, read as stored. */
async function readColumns(
  database: Database,
  table: typeof skills | typeof automations | typeof playbooks | typeof views,
  id: string,
  columns: readonly string[]
): Promise<Record<string, unknown>> {
  const all = table as unknown as Record<string, unknown>;
  const [row] = await database
    .select(
      Object.fromEntries(columns.map((c) => [c, all[c]])) as Record<
        string,
        typeof skills.id
      >
    )
    .from(table as typeof skills)
    .where(eq((table as typeof skills).id, id))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: `row ${id} not found` });
  }
  return row as Record<string, unknown>;
}

/** The keys of a patch that carry a value (an `undefined` field is no edit). */
function patchedKeys(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => patch[k] !== undefined);
}

export function buildCompositeUpdateCaller(
  ctx: RuleLoopCallerContext
): CompositeUpdateCaller {
  const { database, userId, workspaceId, auditSource } = ctx;

  /** Workspace role for a router caller, membership-floored like the create doors. */
  const roleIn = async (wsId: string | null): Promise<string> => {
    if (!wsId) return "owner";
    const membership = await getWorkspaceMembership(
      database as Parameters<typeof getWorkspaceMembership>[0],
      wsId,
      userId
    );
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No workspace access",
      });
    }
    return membership.role;
  };

  const callerCtx = async (wsId: string | null) => ({
    db: database,
    authenticated: true as const,
    userId,
    workspaceId: wsId,
    workspaceRole: await roleIn(wsId),
  });

  return {
    apply: async (op: CompositeUpdateOperation) => {
      switch (op.op) {
        case "update_skill": {
          const columns = patchedKeys(op.patch);
          const before = await readColumns(
            database,
            skills,
            op.skillId,
            columns
          );
          const { skillsRouter } = await import("../routers/skills.js");
          const caller = skillsRouter.createCaller(
            (await callerCtx(workspaceId)) as unknown as Parameters<
              typeof skillsRouter.createCaller
            >[0]
          );
          assertWritten(
            await caller.update({ id: op.skillId, ...op.patch }),
            "update_skill"
          );
          const after = await readColumns(
            database,
            skills,
            op.skillId,
            columns
          );
          return { before, after };
        }

        case "update_rule": {
          // A rule is a `skills` row; its text lives in name / description /
          // body AND `metadata.rule` — the whole bag is snapshotted so revert
          // puts back the rule the person approved, not half of it.
          const columns = ["name", "description", "body", "metadata"];
          const before = await readColumns(
            database,
            skills,
            op.ruleId,
            columns
          );
          const { readRuleMetadata } =
            await import("../services/rules/index.js");
          const existing = readRuleMetadata(
            before.metadata as Record<string, unknown> | null
          );
          if (!existing) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `update_rule: ${op.ruleId} is not a rule`,
            });
          }
          const { updateRuleGoverned } =
            await import("../services/rules/update.js");
          const result = await updateRuleGoverned({
            userId,
            agentUserId: undefined,
            ruleId: op.ruleId,
            workspaceId,
            intent: op.patch.intent,
            // Only the words change: scope, review date, the fact half and the
            // draft state are carried as stored.
            scope: existing.scope,
            ...(existing.factSkillId
              ? { factSkillId: existing.factSkillId }
              : {}),
            ...(existing.draft === true ? { draft: true } : {}),
            auditSource,
          });
          assertWritten(result, "update_rule");
          const after = await readColumns(database, skills, op.ruleId, columns);
          return { before, after };
        }

        case "update_automation": {
          const columns = patchedKeys(op.patch);
          const before = await readColumns(
            database,
            automations,
            op.automationId,
            columns
          );
          const { automationsRouter } =
            await import("../routers/automations.js");
          const caller = automationsRouter.createCaller(
            (await callerCtx(workspaceId)) as unknown as Parameters<
              typeof automationsRouter.createCaller
            >[0]
          );
          assertWritten(
            await caller.update({ id: op.automationId, ...op.patch }),
            "update_automation"
          );
          const after = await readColumns(
            database,
            automations,
            op.automationId,
            columns
          );
          return { before, after };
        }

        case "update_playbook": {
          const columns = patchedKeys(op.patch);
          const before = await readColumns(
            database,
            playbooks,
            op.playbookId,
            columns
          );
          const [row] = await database
            .select({ workspaceId: playbooks.workspaceId })
            .from(playbooks)
            .where(eq(playbooks.id, op.playbookId))
            .limit(1);
          const { playbooksRouter } = await import("../routers/playbooks.js");
          const caller = playbooksRouter.createCaller(
            (await callerCtx(
              row?.workspaceId ?? workspaceId
            )) as unknown as Parameters<typeof playbooksRouter.createCaller>[0]
          );
          assertWritten(
            await caller.update({ id: op.playbookId, ...op.patch }),
            "update_playbook"
          );
          const after = await readColumns(
            database,
            playbooks,
            op.playbookId,
            columns
          );
          return { before, after };
        }

        case "update_view": {
          const columns = patchedKeys(op.patch);
          const before = await readColumns(database, views, op.viewId, columns);
          const [row] = await database
            .select({ workspaceId: views.workspaceId, config: views.config })
            .from(views)
            .where(eq(views.id, op.viewId))
            .limit(1);
          const { viewsRouter } = await import("../routers/views.js");
          const caller = viewsRouter.createCaller(
            (await callerCtx(
              row?.workspaceId ?? null
            )) as unknown as Parameters<typeof viewsRouter.createCaller>[0]
          );
          // The door REPLACES config; the op MERGES — a List's `membersOf`
          // (what keeps it live) must survive a rename.
          const config = op.patch.config
            ? {
                ...((row?.config as Record<string, unknown> | null) ?? {}),
                ...op.patch.config,
              }
            : undefined;
          assertWritten(
            await caller.update({
              id: op.viewId,
              ...(op.patch.name !== undefined ? { name: op.patch.name } : {}),
              ...(op.patch.description !== undefined
                ? { description: op.patch.description }
                : {}),
              ...(config ? { config } : {}),
            }),
            "update_view"
          );
          const after = await readColumns(database, views, op.viewId, columns);
          return { before, after };
        }

        case "update_entity": {
          // Lazy: stamp-materialized reaches the proposals routers.
          const { readEntityUndoSnapshot } =
            await import("../services/proposals/stamp-materialized.js");
          const before = await readEntityUndoSnapshot(database, op.entityId);
          if (!before) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `update_entity: entity ${op.entityId} not found`,
            });
          }
          // An empty patch only registers the ref (a reused container).
          if (patchedKeys(op.patch).length === 0) {
            return {
              before: before as unknown as Record<string, unknown>,
              after: before as unknown as Record<string, unknown>,
            };
          }
          const { entitiesRouter } = await import("../routers/entities.js");
          const [row] = await database
            .select({ workspaceId: entities.workspaceId })
            .from(entities)
            .where(eq(entities.id, op.entityId))
            .limit(1);
          const caller = entitiesRouter.createCaller(
            (await callerCtx(
              row?.workspaceId ?? null
            )) as unknown as Parameters<typeof entitiesRouter.createCaller>[0]
          );
          const result = await caller.update({
            id: op.entityId,
            ...(op.patch.title !== undefined ? { title: op.patch.title } : {}),
            ...(op.patch.description !== undefined
              ? { description: op.patch.description }
              : {}),
            ...(op.patch.properties ? { properties: op.patch.properties } : {}),
            source: "system",
          });
          assertWritten(result, "update_entity");
          const written =
            (result as { written?: Record<string, unknown> }).written ??
            ((await readEntityUndoSnapshot(
              database,
              op.entityId
            )) as unknown as Record<string, unknown> | null);
          if (!written) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `update_entity: entity ${op.entityId} vanished`,
            });
          }
          return {
            before: before as unknown as Record<string, unknown>,
            after: written,
          };
        }
      }
    },
  };
}
