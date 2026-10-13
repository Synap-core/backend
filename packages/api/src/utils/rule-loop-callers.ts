/**
 * rule-loop-callers — the ONE place that builds the composite materializer's
 * Rule Loop (NS1) callers: `skillCaller`, `automationCaller`, `ruleCaller`.
 *
 * MEASURED SEVERANCE: `materializeCompositeGraph` responded to a missing caller
 * with `logger.warn` + `continue` — a SILENT SKIP — and only ONE of its five
 * call sites wired the callers (`routers/proposals/apply-approval.ts`). The
 * other four (`routers/capture.ts`, `services/capture-agent/submit-capture-graph.ts`,
 * and BOTH import-orchestrator materialize paths) wired none. So once a producer
 * emits a `create_skill` / `create_automation` / `create_rule` op, the SAME
 * batch would materialize its config ops when the write happened to be GOVERNED
 * (approval path) and silently drop them when it was AUTO-APPROVED (direct-write
 * path): behaviour forking on governance state, reported as success either way.
 *
 * The fix has two halves and needs both:
 *   1. this factory, so every call site wires the same three callers through
 *      the same canonical doors (there is no second implementation to drift);
 *   2. a FAIL-CLOSED preflight in `materializeCompositeGraph` — a batch carrying
 *      a config op with no matching caller now THROWS before anything is
 *      written, instead of dropping the op and reporting success. A future call
 *      site that forgets to wire cannot re-open the fork silently.
 *
 * Each caller routes to its EXISTING canonical door — `insertSkillGoverned`,
 * `materializeApprovedAutomation`, `createRuleGoverned`. They are lazily
 * imported so this module keeps no static edge to the skills / automations
 * routers (both import back into proposals).
 */

import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import type {
  SkillCreateCaller,
  AutomationCreateCaller,
  RuleCreateCaller,
  PlaybookCreateCaller,
  ViewCreateCaller,
  CompositeUpdateCaller,
} from "./materialize-composite.js";
import { buildCompositeUpdateCaller } from "./composite-update-caller.js";
// Type-only: no runtime edge, so the lazy-import cycle guard above still holds.
import type { materializeApprovedAutomation } from "../routers/automations.js";

type AutomationDatabase = Parameters<
  typeof materializeApprovedAutomation
>[0]["database"];

export interface RuleLoopCallerContext {
  database: AutomationDatabase;
  /**
   * The principal the writes are attributed to — the approver on the approval
   * path, the capturing/importing user on a direct-write path. Never an agent:
   * the governance decision has ALREADY been made by the time the materializer
   * runs, so these re-entrant doors are passed `agentUserId: undefined` and
   * auto-grant rather than filing a second proposal.
   */
  userId: string;
  /** Workspace the materialized config belongs to (null = pod-wide). */
  workspaceId: string | null;
  /** Audit provenance, e.g. "rule_loop_approval" / "rule_loop_capture". */
  auditSource: string;
}

export function buildRuleLoopCallers(ctx: RuleLoopCallerContext): {
  skillCaller: SkillCreateCaller;
  automationCaller: AutomationCreateCaller;
  ruleCaller: RuleCreateCaller;
  playbookCaller: PlaybookCreateCaller;
  viewCaller: ViewCreateCaller;
  updateCaller: CompositeUpdateCaller;
} {
  const { database, userId, workspaceId, auditSource } = ctx;

  return {
    // A Library rebuild's CHANGES (`update_*`), each through its object's
    // existing update door — see `composite-update-caller.ts`.
    updateCaller: buildCompositeUpdateCaller(ctx),
    skillCaller: {
      create: async (skillOp) => {
        const { insertSkillGoverned } = await import("../routers/skills.js");
        // Typed at the call site (NOT `as never` / `as any`): a blanket cast
        // here would silently defeat any future tightening of the skill insert
        // contract — a defect this repo has shipped.
        const created = await insertSkillGoverned({
          userId,
          workspaceId: skillOp.scope === "workspace" ? workspaceId : null,
          kind: "instruction",
          scope: skillOp.scope,
          name: skillOp.name,
          body: skillOp.body,
          agentTypes: skillOp.agentTypes ?? null,
          // The operator is the authority — no agentUserId, so the re-entrant
          // gate auto-grants instead of re-proposing.
          agentUserId: undefined,
          auditSource,
        });
        if (created.status !== "installed") {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `create_skill did not apply (${created.status})`,
          });
        }
        return { id: created.skill.id };
      },
    },

    automationCaller: {
      create: async (automationOp) => {
        const { materializeApprovedAutomation } =
          await import("../routers/automations.js");
        // `materializeApprovedAutomation` runs
        // `prepareAutomationForMaterialization` — the ONE existing flow
        // validator (services/automations/validate-flow.ts). An invalid
        // flowDefinition throws here.
        //
        // It also forces `status: "draft"` unconditionally, which IS the
        // "materialize DISABLED" guarantee: `automations.status` (not an
        // `enabled` column) is what decides whether a trigger can fire.
        const flow = automationOp.flowDefinition as {
          nodes?: unknown;
          edges?: unknown;
          triggerConfig?: Record<string, unknown>;
        } | null;
        const stableId = randomUUID();
        const created = await materializeApprovedAutomation({
          database,
          definition: {
            workspaceId,
            name: automationOp.name,
            ...(automationOp.description
              ? { description: automationOp.description }
              : {}),
            triggerType: automationOp.triggerType,
            // The op carries its trigger config INSIDE the flow
            // (`flowDefinition.triggerConfig`). The preflight
            // (`validatePlanOperations`) refuses an EVENT automation without
            // `triggerConfig.eventPattern`, so `{}` here is only ever a
            // cron / webhook / manual trigger that needs none.
            triggerConfig: flow?.triggerConfig ?? {},
            flowDefinition: automationOp.flowDefinition as {
              nodes: Array<Record<string, unknown>>;
              edges: Array<Record<string, unknown>>;
            },
            status: "draft",
          },
          agentUserId: userId,
          stableId,
        });
        if (!created) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "create_automation did not materialize",
          });
        }
        return { id: created };
      },
    },

    ruleCaller: {
      create: async (ruleOp) => {
        const { createRuleGoverned } =
          await import("../services/rules/create.js");
        const created = await createRuleGoverned({
          userId,
          agentUserId: undefined,
          workspaceId,
          intent: ruleOp.intent,
          scope: ruleOp.scope,
          ...(ruleOp.factSkillId ? { factSkillId: ruleOp.factSkillId } : {}),
          automationIds: ruleOp.automationIds,
          auditSource,
        });
        if (created.status !== "created") {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `create_rule did not apply (${created.status})`,
          });
        }
        return { id: created.ruleId };
      },
    },

    // A DRAFT process (`create_playbook`), through the EXISTING
    // `playbooks.create` door — the same caller shape the playbook approval
    // executor builds (`executors/playbook.ts`), membership-floored. No
    // agentUserId: the governance decision was already made for the graph, so
    // the re-entrant door grants instead of filing a second proposal.
    playbookCaller: {
      create: async (playbookOp) => {
        if (!workspaceId) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "create_playbook needs a workspace: a process lives in a space.",
          });
        }
        const { getWorkspaceMembership } = await import("@synap/database");
        const membership = await getWorkspaceMembership(
          database as Parameters<typeof getWorkspaceMembership>[0],
          workspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const { playbooksRouter } = await import("../routers/playbooks.js");
        const caller = playbooksRouter.createCaller({
          db: database,
          authenticated: true as const,
          userId,
          workspaceId,
          workspaceRole: membership.role,
        } as unknown as Parameters<typeof playbooksRouter.createCaller>[0]);
        const created = await caller.create({
          name: playbookOp.name,
          ...(playbookOp.description
            ? { description: playbookOp.description }
            : {}),
          goalTemplate: playbookOp.goalTemplate,
          subjectProfile: playbookOp.subjectProfile,
          status: "draft",
        });
        if (created.status !== "created" || !created.playbook) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `create_playbook did not apply (${created.status})`,
          });
        }
        return { id: created.playbook.id };
      },
    },

    // A LIST (`create_view`), through the EXISTING `views.create` door — the
    // same caller shape the `view/create` approval executor builds
    // (`executors/view.ts`), membership-floored. No agentUserId: the graph's
    // governance decision is already made.
    //
    // Scoping: the members become the view's FIXED set (`query.entityIds`,
    // honoured by `views.execute`); the group container is recorded on the
    // config as `membersOf`, so a later "members of X" filter can make the
    // list live. Kinds: the op's slugs, else the members' own kinds.
    viewCaller: {
      create: async (viewOp) => {
        const {
          getWorkspaceMembership,
          ProfileResolutionService,
          entities,
          inArray,
        } = await import("@synap/database");
        const viewWorkspaceId = viewOp.workspaceId ?? workspaceId;
        let workspaceRole = "owner";
        if (viewWorkspaceId) {
          const membership = await getWorkspaceMembership(
            database as Parameters<typeof getWorkspaceMembership>[0],
            viewWorkspaceId,
            userId
          );
          if (!membership) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "No workspace access",
            });
          }
          workspaceRole = membership.role;
        }

        const scopeProfileIds = new Set<string>();
        if (viewOp.scopeProfileSlugs?.length) {
          const resolver = new ProfileResolutionService(database);
          for (const slug of viewOp.scopeProfileSlugs) {
            const profile = await resolver.resolveProfile(
              slug,
              userId,
              viewWorkspaceId ?? null
            );
            if (!profile?.id) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `create_view: no kind "${slug}" in this space`,
              });
            }
            scopeProfileIds.add(profile.id);
          }
        } else if (viewOp.entityIds.length > 0) {
          const rows = await database
            .select({ profileId: entities.profileId })
            .from(entities)
            .where(inArray(entities.id, viewOp.entityIds));
          for (const row of rows) {
            if (row.profileId) scopeProfileIds.add(row.profileId);
          }
        }
        if (scopeProfileIds.size === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "create_view: the list names no kind and none of its things has one",
          });
        }

        const { viewsRouter } = await import("../routers/views.js");
        const caller = viewsRouter.createCaller({
          db: database,
          authenticated: true as const,
          userId,
          workspaceId: viewWorkspaceId ?? null,
          workspaceRole,
        } as unknown as Parameters<typeof viewsRouter.createCaller>[0]);
        const created = await caller.create({
          name: viewOp.name,
          type: viewOp.viewType,
          ...(viewWorkspaceId ? { workspaceId: viewWorkspaceId } : {}),
          scopeProfileIds: [...scopeProfileIds],
          ...(viewOp.entityIds.length > 0
            ? { query: { entityIds: viewOp.entityIds } }
            : {}),
          config: {
            ...(viewOp.config ?? {}),
            ...(viewOp.containerEntityId
              ? { membersOf: viewOp.containerEntityId }
              : {}),
          },
        });
        const view = (created as { view?: { id?: string } | null }).view;
        if (created.status !== "created" || !view?.id) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `create_view did not apply (${created.status})`,
          });
        }
        return { id: view.id };
      },
    },
  };
}
