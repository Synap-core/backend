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
} from "./materialize-composite.js";
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
} {
  const { database, userId, workspaceId, auditSource } = ctx;

  return {
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
            // CONTRACT GAP (reported, not papered over): the pinned
            // `create_automation` op carries no `triggerConfig`. We read one
            // off the flowDefinition when the producer embedded it, otherwise
            // an event automation lands with an empty trigger config and cannot
            // match — visible, not silent, because the automation is DRAFT
            // either way.
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
  };
}
