/**
 * Loop-Template Applier — "config descriptor → instantiates an autonomy loop".
 *
 * The proactive/autonomous counterpart to `createCapabilityFromDefinition`
 * (which instantiates {vault · tools · skills}). Given a `LoopDefinition` + a
 * `params` map it:
 *   1. interpolates every `{{paramName}}` placeholder (the SAME shared
 *      `interpolateDeep` the capability applier uses — no copy),
 *   2. creates each playbook via the GOVERNED `playbooksRouter.create` caller —
 *      which, for free, materializes the playbook's inline cron `schedule` into
 *      its backing cron automation (the one shared `cron-automation.ts`
 *      primitive). Captures `playbookIdByRef`,
 *   3. resolves each playbook's `grants` (template-local capability refs) into
 *      `playbook --grants--> {tool|skill|command}` link edges — reusing the SAME
 *      `createLinks` service the workspace materializer uses,
 *   4. creates each trigger via the GOVERNED `automationsRouter.create` caller —
 *      a trigger → single `playbook_run` flow node built by the SAME
 *      `buildPlaybookRunFlowDefinition` primitive the playbook-schedule sugar
 *      emits. The trigger's `playbookRef` resolves to the playbook id created
 *      in step 2.
 *
 * ZERO duplicated insert/business logic — every playbook & automation flows
 * through the existing governed router callers, so governance
 * (checkPermissionOrPropose), audit, and side-effects are identical to the
 * Phase-1 routes. When governance defers a create, the proposal id is surfaced.
 *
 * This is the ONE loop-materialization primitive — shared by the standalone
 * Hub-REST door AND the workspace `createFromDefinition` path — exactly like
 * `cron-automation.ts` is the one schedule primitive.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import type { FlowDefinition } from "@synap/database";
import type { LoopDefinition } from "@synap/playbooks";

import { playbooksRouter } from "../../routers/playbooks.js";
import { automationsRouter } from "../../routers/automations.js";
import { createLinks } from "../links/links-service.js";
import { buildPlaybookRunFlowDefinition } from "../playbooks/cron-automation.js";
import { interpolateDeep } from "../_shared/interpolate.js";
import type { Context } from "../../types/context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── templateKey → JSON loader (mirror loadCapabilityTemplate) ─────────────────

/** Candidate roots for the seed-template directory (dev + built + env). */
function templateDirCandidates(): string[] {
  const dirs: string[] = [];
  if (process.env.LOOP_TEMPLATES_DIR) {
    dirs.push(process.env.LOOP_TEMPLATES_DIR);
  }
  // From packages/api/src/services/loops → synap-backend/templates/loops
  dirs.push(path.resolve(__dirname, "../../../../../templates/loops"));
  // Built layout: packages/api/dist/services/loops → same backend root.
  dirs.push(path.resolve(__dirname, "../../../../templates/loops"));
  // cwd fallbacks (backend root or packages/api).
  dirs.push(path.resolve(process.cwd(), "templates/loops"));
  dirs.push(path.resolve(process.cwd(), "../../templates/loops"));
  return dirs;
}

/** Load a `LoopDefinition` by templateKey from the seed-template dir. */
export function loadLoopTemplate(templateKey: string): LoopDefinition {
  const fileName = `${templateKey}.loop.json`;
  for (const dir of templateDirCandidates()) {
    const filePath = path.join(dir, fileName);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as LoopDefinition;
    }
  }
  throw new Error(`Loop template not found: ${templateKey}`);
}

// ── Result shape ──────────────────────────────────────────────────────────────

export interface CreateLoopResult {
  loopKey: string;
  created: {
    playbooks: {
      ref: string;
      status: "created" | "proposed";
      playbookId: string | null;
      proposalId: string | null;
    }[];
    triggers: {
      name: string;
      status: "created" | "proposed" | "skipped";
      automationId: string | null;
      proposalId: string | null;
    }[];
  };
  proposals: string[];
}

// ── The applier ───────────────────────────────────────────────────────────────

/**
 * Apply a `LoopDefinition` (or a templateKey-loaded one), instantiating its
 * {playbooks · triggers} for the acting user/workspace in `ctx`.
 */
export async function createLoopFromDefinition(
  rawDef: LoopDefinition,
  params: Record<string, unknown>,
  ctx: Context
): Promise<CreateLoopResult> {
  const userId = ctx.userId;
  if (!userId) throw new Error("createLoopFromDefinition: missing userId");
  const workspaceId = ctx.workspaceId ?? null;

  // Interpolate the whole definition up front so every downstream value
  // (goalTemplate, names, schedule cron, trigger cron/event, params) has params
  // substituted. The template-local `ref` / `playbookRef` handles are plain
  // identifiers (no `{{}}`) and survive unchanged. The definition's own
  // `name`/`key` are exposed as implicit params (explicit params win).
  const effectiveParams: Record<string, unknown> = {
    name: rawDef.name,
    key: rawDef.key,
    ...params,
  };
  // Seed declared defaults so a caller that omits an optional param with a
  // `default` still gets it (mirrors the capability applier). Without this a
  // template's `{{cron}}` with default "0 8 * * *" would interpolate to "".
  // Explicit params (already spread above) win.
  for (const p of rawDef.params ?? []) {
    if (p.default !== undefined && !(p.name in params)) {
      effectiveParams[p.name] = p.default;
    }
  }
  const def = interpolateDeep(rawDef, effectiveParams);

  // Acting provenance — when an AI agent applies the loop (agentUserId present
  // on the caller ctx), forward it so each playbook/trigger create routes
  // through checkPermissionOrPropose (propose, not auto-apply). An operator
  // provision path (e.g. workspaces.createFromDefinition) carries no
  // agentUserId, so it stays synchronous. Mirrors the hub automations caller's
  // `source: agentUserId ? "agent" : "intelligence"`.
  const agentUserId = ctx.agentUserId ?? undefined;
  const source = agentUserId ? "agent" : "intelligence";

  const proposals: string[] = [];

  // 1. Playbooks — through the GOVERNED playbooksRouter caller. The inline
  //    `schedule` auto-materializes its backing cron automation in `create`.
  const playbooksCaller = playbooksRouter.createCaller(ctx as never);
  const playbookIdByRef = new Map<string, string>();
  const createdPlaybooks: CreateLoopResult["created"]["playbooks"] = [];
  for (const pb of def.playbooks) {
    const result = await playbooksCaller.create({
      name: pb.name,
      description: pb.description,
      goalTemplate: pb.goalTemplate,
      params: pb.params,
      inputStrategy: pb.inputStrategy,
      channelSpec: pb.channelSpec,
      expectedOutputs: pb.expectedOutputs,
      stages: pb.stages,
      subjectProfile: pb.subjectProfile,
      schedule: pb.schedule,
      executor: pb.executor ?? "is-agent",
      agentUserId,
      source,
    });

    const playbookId = result.playbook?.id ?? null;
    if (playbookId) playbookIdByRef.set(pb.ref, playbookId);
    if (result.proposalId) proposals.push(result.proposalId);
    createdPlaybooks.push({
      ref: pb.ref,
      status: result.status === "created" ? "created" : "proposed",
      playbookId,
      proposalId: result.proposalId,
    });

    // Resolve grants → `playbook --grants--> {tool|skill|command}` links. Only
    // when the playbook was actually created (a proposed playbook has no id).
    if (playbookId && pb.grants && pb.grants.length > 0) {
      await createLinks(
        pb.grants.map((g) => ({
          workspaceId,
          fromType: "playbook" as const,
          fromId: playbookId,
          toType: g.kind as "tool" | "skill" | "command",
          toId: g.id,
          linkType: "grants" as const,
          metadata: {},
        }))
      );
    }
  }

  // 2. Triggers — through the GOVERNED automationsRouter caller. Each trigger is
  //    a trigger → single `playbook_run` node (the SAME flow primitive the
  //    playbook-schedule sugar emits). Resolve playbookRef → id.
  const automationsCaller = automationsRouter.createCaller(ctx as never);
  const createdTriggers: CreateLoopResult["created"]["triggers"] = [];
  for (const trig of def.triggers ?? []) {
    const playbookId = playbookIdByRef.get(trig.playbookRef);
    if (!playbookId) {
      // The referenced playbook was proposed (or unknown) — skip the trigger;
      // it cannot point at a non-existent playbook id.
      createdTriggers.push({
        name: trig.name,
        status: "skipped",
        automationId: null,
        proposalId: null,
      });
      continue;
    }

    const flowDefinition: FlowDefinition = buildPlaybookRunFlowDefinition(
      playbookId,
      {
        playbookName: trig.playbookRef,
        paramsMapping: trig.params
          ? Object.fromEntries(
              Object.entries(trig.params).map(([k, v]) => [k, String(v)])
            )
          : undefined,
      }
    );

    const triggerType = trig.trigger.type;
    const triggerConfig =
      triggerType === "cron"
        ? { expression: trig.trigger.cron ?? "" }
        : triggerType === "event"
          ? { eventPattern: trig.trigger.eventType ?? "" }
          : {};

    const result = await automationsCaller.create({
      workspaceId,
      name: trig.name,
      description: trig.description,
      triggerType,
      triggerConfig,
      flowDefinition: flowDefinition as unknown as {
        nodes: Record<string, unknown>[];
        edges: Record<string, unknown>[];
      },
      status: "active",
      metadata: { createdVia: "template", playbookId },
      agentUserId,
      source,
    });

    if (result.proposalId) proposals.push(result.proposalId);
    createdTriggers.push({
      name: trig.name,
      status: result.status === "created" ? "created" : "proposed",
      automationId: result.id,
      proposalId: result.proposalId,
    });
  }

  return {
    loopKey: def.key,
    created: { playbooks: createdPlaybooks, triggers: createdTriggers },
    proposals,
  };
}
