/**
 * applyTemplate — the ONE template apply (APPLY-ONE-DOOR-PLAN §1):
 *
 *   resolve dependencies / compose  (`materializeWorkspaceCore`, deferCreate)
 *   → resolveTarget → plan → layer 1 (`applyLayerOne`)
 *   → layer 2 (`applyPackagePostWorkspace`)
 *   → finish (`finishTemplateApply`, the only writer of the stamp)
 *
 * Every door is a thin wrapper: its own governance (`checkPermissionOrPropose`,
 * the approve executor, …) runs BEFORE, then it translates its input, calls
 * this, and maps the result to its response. Founder decisions (2026-10-13):
 *   - a layer-2 failure NEVER throws once layer 1 exists: the space is usable,
 *     the failure is recorded (`state: failed`, `failedLayer: 2`) and reported
 *     (`layer2.status: "failed"`), and `synap templates update` finishes it;
 *   - governance stays per door: nothing here decides who may apply.
 *
 * Layer-1 failures (dependency graph, compose, create) still throw — there is
 * no space to report on — with the typed errors the doors already map.
 */
import type { WorkspaceDefinitionInput } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  materializeWorkspaceCore,
  materializeReportStatus,
  type MaterializeCoreResult,
  type MaterializeReportStatus,
} from "../workspace-materialization-service.js";
import type { ComposeReport } from "../compose-overlay.js";
import type { ResolvedPackageDependency } from "../package-dependency-resolver.js";
import {
  applyPackagePostWorkspace,
  markLayerTwoFailed,
  type PackagePostWorkspaceBody,
} from "../package-apply-post-workspace.js";
import {
  finishTemplateApply,
  type FinishTemplateApplyResult,
} from "../template-apply-finisher.js";
import { templateApplyWarningFor } from "../template-health.js";
import { applyLayerOne, type LayerOneResult } from "./layer-one.js";
import { planTemplateApply, type TemplateApplyAction } from "./plan.js";
import { resolveTarget } from "./resolve-target.js";

export { planTemplateApply, type TemplateApplyAction } from "./plan.js";
export { resolveTarget, findLegacyWorkspaceMatch } from "./resolve-target.js";
export { applyLayerOne, type LayerOneResult } from "./layer-one.js";

const logger = createLogger({ module: "template-apply" });

/** The package keys that make up layer 2. */
const LAYER_TWO_KEYS = [
  "capabilities",
  "automations",
  "playbooks",
  "loops",
  "cells",
  "actionPlacements",
  "rules",
  "skills",
] as const;

/** Does this body bring anything for layer 2 to apply? */
export function declaresLayerTwo(body: Record<string, unknown>): boolean {
  return (
    LAYER_TWO_KEYS.some(
      (k) => Array.isArray(body[k]) && (body[k] as unknown[]).length > 0
    ) || !!body.projectId
  );
}

export interface ApplyTemplateInput {
  /** The layer-1 definition (also the overlay, on a compose). */
  definition: WorkspaceDefinitionInput;
  /**
   * The caller's layer-2 body. Defaults to `definition`. Replaced by the
   * catalog's own package when layer 1 re-synced against it (layer 2 must
   * come from the same source as layer 1, or it skips what the new version
   * added). A function is called once the space is known (a body keyed by
   * the space, e.g. the tRPC doors' loop).
   */
  layerTwoBody?: LayerTwoBody | ((workspaceId: string) => LayerTwoBody);
  actor: {
    userId: string;
    /** The agent acting / proposing, if any. */
    agentUserId?: string;
    /**
     * A person approved this apply (the approve executor). Then the layers of
     * a CATALOG package apply under that approval and the agent is only
     * enrolled; the agent's own body keeps the agent's governance.
     */
    approved?: boolean;
    scopes?: string[];
  };
  /** The door, for logs. */
  source: string;
  /** Install onto this existing space (compose), whatever the package declares. */
  targetWorkspaceId?: string;
  /**
   * ADOPT this existing space into the template `identity.packageSlug` (Hub
   * `/pod/adopt`, approve `workspace/adopt`): it takes the identity, layer 1
   * re-syncs it from the catalog, layer 2 runs, the stamp lands on
   * convergence. No dependency or compose step — the space is the target.
   */
  adoptWorkspaceId?: string;
  /**
   * Run layer 2 even when the body declares nothing for it (agent enrollment,
   * the applier's own bookkeeping) — the `/packages/apply` family always did.
   * Other doors run it only when the body brings layer-2 content.
   */
  alwaysRunLayerTwo?: boolean;
  identity: {
    packageSlug?: string;
    packageVersion?: string;
    proposalId?: string;
    workspaceName?: string;
    templateId?: string;
    templateName?: string;
    workspaceType?: "personal" | "agent" | "project" | "operational";
    createdBy?: "user" | "provisioning" | "plugin";
    linkedAgentId?: string;
  };
  /** The create core's per-step progress (a door's realtime events). */
  onProgress?: (step: string, pct: number, label: string) => void;
  /**
   * Runs once the space exists, before layer 2 (the doors' engagement-project
   * step, the tRPC doors' seed bodies). May return the project the layers
   * should stamp. Its errors are the door's: they propagate.
   */
  beforeLayerTwo?: (
    workspaceId: string,
    applied: { outcome: TemplateApplyOutcome; layerOne?: LayerOneResult }
  ) => Promise<{ projectId?: string } | void>;
}

/** A layer-2 body: the applier's shape, plus whatever else the package carries. */
export type LayerTwoBody = PackagePostWorkspaceBody & Record<string, unknown>;

export type TemplateApplyOutcome =
  "created" | "reconciled" | "unchanged" | "composed";

export type LayerTwoReport =
  | { status: "applied"; post: Record<string, unknown> }
  /** Nothing to apply (no layer-2 content, or an unchanged space). */
  | { status: "skipped" }
  | { status: "failed"; error: unknown };

export interface TemplateApplyResult {
  workspaceId: string;
  outcome: TemplateApplyOutcome;
  /** The honest "created / reused / composed" a report shows. */
  materializeStatus: MaterializeReportStatus;
  /** Standalone only: what the plan decided. */
  action?: TemplateApplyAction;
  /** Standalone only: layer one's result. */
  layerOne?: LayerOneResult;
  /** Compose only. */
  compose?: { onto: string; report: ComposeReport };
  /** The version this apply was converging to (stamped only on convergence). */
  pendingVersionStamp?: string;
  dependencies: ResolvedPackageDependency[];
  layer2: LayerTwoReport;
  finished: FinishTemplateApplyResult | null;
  /** The pod's one sentence for why the apply is not finished, when it is not. */
  warning: string | null;
}

/** The catalog package, through the Hub schema's defaults (statuses → active). */
async function normalizeCatalogBody(
  pkg: Record<string, unknown>
): Promise<PackagePostWorkspaceBody & Record<string, unknown>> {
  const { PackageApplySchema } =
    await import("../../routers/hub-protocol/rest/packages.js");
  return PackageApplySchema.parse(pkg) as unknown as PackagePostWorkspaceBody &
    Record<string, unknown>;
}

export async function applyTemplate(
  input: ApplyTemplateInput
): Promise<TemplateApplyResult> {
  const { definition, actor, identity } = input;
  const { userId } = actor;

  // ── Dependencies + compose (layer 1 of an overlay / pack / --onto) ──────
  // An adopt names its space: nothing to resolve or compose.
  const core: MaterializeCoreResult = input.adoptWorkspaceId
    ? { status: "resolved", dependencies: [] }
    : await materializeWorkspaceCore({
        definition,
        userId,
        agentUserId: actor.agentUserId,
        selfSlug: identity.packageSlug,
        targetWorkspaceId: input.targetWorkspaceId,
        packageSlug: identity.packageSlug,
        packageVersion: identity.packageVersion,
        deferCreate: true,
      });

  let workspaceId: string;
  let outcome: TemplateApplyOutcome;
  let layerOne: LayerOneResult | undefined;
  let pendingVersionStamp: string | undefined;
  let pendingPack: { slug: string; version: string } | undefined;
  let materializeStatus: MaterializeReportStatus;
  if (core.status === "composed") {
    workspaceId = core.workspaceId;
    outcome = "composed";
    pendingVersionStamp = core.pendingVersionStamp;
    pendingPack = core.pendingPack;
    materializeStatus = materializeReportStatus(core);
  } else {
    // ── Standalone: resolveTarget → plan → layer 1 ───────────────────────
    layerOne = await applyLayerOne({
      definition,
      userId,
      proposalId: identity.proposalId,
      workspaceName: identity.workspaceName,
      templateId: identity.templateId,
      templateName: identity.templateName,
      packageSlug: identity.packageSlug,
      packageVersion: identity.packageVersion,
      workspaceType: identity.workspaceType,
      createdBy: identity.createdBy,
      linkedAgentId: identity.linkedAgentId,
      onProgress: input.onProgress,
      adoptWorkspaceId: input.adoptWorkspaceId,
    });
    workspaceId = layerOne.workspaceId;
    outcome = layerOne.outcome;
    pendingVersionStamp = layerOne.pendingVersionStamp;
    materializeStatus = layerOne.created ? "created" : "reused";
  }

  const hook = input.beforeLayerTwo
    ? await input.beforeLayerTwo(workspaceId, { outcome, layerOne })
    : undefined;
  const projectId = hook?.projectId;

  // ── Layer 2 ──────────────────────────────────────────────────────────────
  const callerBody = {
    ...(typeof input.layerTwoBody === "function"
      ? input.layerTwoBody(workspaceId)
      : ((input.layerTwoBody ?? definition) as LayerTwoBody)),
  };
  const meta = (callerBody._meta ?? {}) as { slug?: string; version?: string };
  callerBody._meta = {
    ...meta,
    ...(meta.slug || !identity.packageSlug
      ? {}
      : { slug: identity.packageSlug }),
  };
  if (projectId) callerBody.projectId = projectId;

  let layer2: LayerTwoReport = { status: "skipped" };
  let finished: FinishTemplateApplyResult | null = null;
  const runLayerTwo = async (
    body: PackagePostWorkspaceBody,
    posture: { agentUserId?: string; enrollAgentUserId?: string }
  ): Promise<LayerTwoReport> => {
    try {
      const post = await applyPackagePostWorkspace({
        workspaceId,
        body,
        userId,
        ...posture,
        scopes: actor.scopes ?? [],
      });
      return { status: "applied", post };
    } catch (error) {
      // Decision 3: recorded (the applier marks `failed`, `failedLayer: 2`;
      // marked again here for a failure before the applier ran), reported,
      // never thrown — the space is usable.
      await markLayerTwoFailed(workspaceId, userId, error).catch(
        () => undefined
      );
      logger.warn(
        { err: error, workspaceId, source: input.source },
        "template apply: layer 2 failed — recorded, the space stays usable"
      );
      return { status: "failed", error };
    }
  };

  // An APPROVED apply runs what the person approved, even on an unchanged
  // space (the agent's own additions to a same-version body — they keep the
  // agent's governance below). Only an unapproved re-hit takes the cheap path.
  if (outcome === "unchanged" && !actor.approved) {
    // "unchanged" says the STAMP matches — not that every playbook the
    // template declares exists (a stamp written by a pass that did not create
    // a later-added playbook). The playbook layer alone is database-only (no
    // Control Plane fetch, the cost the skip exists to avoid). The other
    // layers are NOT re-checked on an unchanged space — honest
    // under-convergence (backend-rules): nothing claims they were, and a
    // space whose stamp a pre-W2 door wrote without layer 2 is repaired by the
    // next catalog version (or `synap templates update`), not here.
    if (callerBody.playbooks?.length) {
      layer2 = await runLayerTwo(
        { _meta: callerBody._meta, playbooks: callerBody.playbooks },
        { agentUserId: actor.agentUserId }
      );
      if (layer2.status === "applied")
        finished = await finishTemplateApply({
          workspaceId,
          userId,
          built: false,
          post: layer2.post,
        });
    }
  } else {
    const catalog = layerOne?.packageDefinition as
      Record<string, unknown> | undefined;
    let body: (PackagePostWorkspaceBody & Record<string, unknown>) | null =
      callerBody;
    let posture: { agentUserId?: string; enrollAgentUserId?: string } = {
      agentUserId: actor.agentUserId,
    };
    if (catalog) {
      try {
        body = await normalizeCatalogBody({
          ...catalog,
          _meta: {
            ...((catalog._meta as Record<string, unknown>) ?? {}),
            ...(identity.packageSlug ? { slug: identity.packageSlug } : {}),
            ...(pendingVersionStamp ? { version: pendingVersionStamp } : {}),
          },
          // The engagement project is the CALLER's, never the template's.
          ...(callerBody.projectId !== undefined
            ? { projectId: callerBody.projectId }
            : {}),
        });
      } catch (error) {
        body = null;
        await markLayerTwoFailed(workspaceId, userId, error).catch(
          () => undefined
        );
        layer2 = { status: "failed", error };
      }
      // Approver authority covers ONLY what the server resolved from the
      // catalog: a person approved that package. Anything else is the
      // agent's own body and keeps the agent's governance.
      if (actor.approved) posture = { enrollAgentUserId: actor.agentUserId };
    }
    if (body && (input.alwaysRunLayerTwo || declaresLayerTwo(body)))
      layer2 = await runLayerTwo(body, posture);
    finished = await finishTemplateApply({
      workspaceId,
      userId,
      built: outcome === "created",
      pendingVersionStamp,
      pendingPack,
      post: layer2.status === "applied" ? layer2.post : {},
    });
  }

  const warning =
    finished && finished.state !== "converged"
      ? await templateApplyWarningFor(workspaceId).catch(() => null)
      : null;

  return {
    workspaceId,
    outcome,
    materializeStatus,
    ...(layerOne ? { action: layerOne.action, layerOne } : {}),
    ...(core.status === "composed"
      ? {
          compose: {
            onto: core.composeTargetWorkspaceId,
            report: core.reconcile,
          },
        }
      : {}),
    dependencies: core.dependencies,
    ...(pendingVersionStamp ? { pendingVersionStamp } : {}),
    layer2,
    finished,
    warning,
  };
}

export interface PreviewTemplateApplyInput {
  userId: string;
  packageSlug?: string;
  packageVersion?: string;
  proposalId?: string;
  workspaceName?: string;
  /**
   * An explicit or declared compose target (`resolvePreflightComposeTarget`):
   * the apply composes onto it. `workspaceId` absent = a declared base that is
   * not installed yet (the apply installs it first).
   */
  compose?: { workspaceId?: string };
}

export type TemplateApplyPreview =
  | { action: { kind: "compose" }; workspaceId: string | null }
  | { action: TemplateApplyAction; workspaceId: string | null }
  | {
      action: { kind: "refused" };
      workspaceId: string | null;
      reason: "identity-held";
    };

/**
 * The dry run (`/packages/preflight`): the SAME lookup and the SAME plan an
 * apply would run, with no lock and no write. A space the caller may not
 * write is reported, never thrown.
 */
export async function previewTemplateApply(
  input: PreviewTemplateApplyInput
): Promise<TemplateApplyPreview> {
  if (input.compose)
    return {
      action: { kind: "compose" },
      workspaceId: input.compose.workspaceId ?? null,
    };
  const target = await resolveTarget({
    userId: input.userId,
    proposalId: input.proposalId,
    packageSlug: input.packageSlug,
    workspaceName: input.workspaceName,
    onForeignHolder: "report",
  });
  if (!target.found) {
    if (target.foreignHolder)
      return {
        action: { kind: "refused" },
        workspaceId: target.foreignHolder.existingWorkspaceId,
        reason: "identity-held",
      };
    return { action: { kind: "create" }, workspaceId: null };
  }
  let version = input.packageVersion;
  if (input.packageSlug) {
    try {
      const { resolveWorkspaceTemplate } =
        await import("../capabilities/resolve-workspace-template.js");
      version =
        (await resolveWorkspaceTemplate(input.packageSlug))?.version ?? version;
    } catch {
      // Unresolvable catalog: the caller's version is what an apply would use.
    }
  }
  return {
    action: planTemplateApply({ target: { state: target.state }, version }),
    workspaceId: target.workspaceId,
  };
}
