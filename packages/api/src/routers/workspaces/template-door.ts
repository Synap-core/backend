/**
 * The tRPC template doors' ONE wrapper over `applyTemplate` (APPLY-ONE-DOOR-
 * PLAN, W3): `createFromDefinition` (D7), `reconcileFromDefinition` (D16),
 * `applyDefinition` create (D17), `installFromCatalog` (D8) and, through it,
 * `ensureTemplate` (D9).
 *
 * Each of those doors keeps its own governance (the human tRPC gates, the CRM
 * owner gate, the tier check) and translates its input; this runs the apply
 * and the parts the tRPC family adds around it:
 *   - the progress events the browser's loading state subscribes to;
 *   - `appId` / `composedFrom` written into the space (only where absent);
 *   - the seed bodies of a space built just now (positional on the create
 *     core's entity ids);
 *   - the log event / side-effects (`recordDomainMutation`) and pod-admin
 *     step of a new space;
 *   - one error mapping (the typed refusals keep their codes; a build failure
 *     names its step).
 *
 * The space lookup, the "create / resume / re-sync / unchanged" decision,
 * layer 2 and the stamp are `applyTemplate`'s alone: the tRPC re-hit and
 * resume branches, `reconcileExisting` and the tRPC idempotency lookups are
 * gone. A layer-2 failure is never thrown here: it is recorded on the space
 * and reported in `layers` (founder decision 3, 2026-10-13).
 */
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  workspaces,
  drizzleSql,
  getDb,
  eventRepository,
  EntityBodyService,
  EntityRepository,
  isWorkspaceIdentityConflictError,
  readTemplateState,
  type InstallLayerReport,
  type ReconcileReport,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import {
  applyTemplate,
  type ApplyTemplateInput,
  type TemplateApplyOutcome,
  type TemplateApplyResult,
} from "../../services/template-apply/index.js";
import {
  ComposeBaseUnavailableError,
  DependencyResolutionError,
  ComposeBaseNotFoundError,
  ComposeOverlayError,
} from "../../services/workspace-materialization-service.js";
import type { ResolvedPackageDependency } from "../../services/package-dependency-resolver.js";
import {
  summarizePostWorkspaceLayers,
  installedTrackTemplates,
  type InstalledTrackTemplate,
} from "../../services/capabilities/install-layers.js";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";
import { auditLog } from "../../utils/audit-log.js";
import { recordDomainMutation } from "../../utils/domain-mutation.js";
import { materializePodAdminsIntoWorkspace } from "../../utils/workspace-role.js";
import { logger, isPodReadableWorkspace } from "./helpers.js";
import { layerTwoFailedSentence } from "../../services/template-health.js";

export interface TrpcTemplateApplyInput {
  userId: string;
  agentUserId?: string;
  /** The door, for logs. */
  source: string;
  /** The layer-1 definition (also the overlay, on a compose). */
  definition: WorkspaceDefinitionInput;
  layerTwoBody: ApplyTemplateInput["layerTwoBody"];
  /** Install onto this existing space (compose). */
  targetWorkspaceId?: string;
  identity: ApplyTemplateInput["identity"];
  catalogVersion?: ApplyTemplateInput["catalogVersion"];
  sentDefinition?: ApplyTemplateInput["sentDefinition"];
  /** Written into the space's settings only where the key is absent. */
  settingsFill?: Record<string, unknown>;
  /** Written into a space built just now (absent keys only, like above). */
  createdFill?: Record<string, unknown>;
  /** The definition's seed entities, in order (a new space's seed bodies). */
  seeds?: ReadonlyArray<{ title: string; content?: string }>;
}

/**
 * `patch || settings` — the patch's keys land only where the stored blob has
 * none, in the UPDATE itself (never a read-then-write-back of the blob).
 */
async function fillSettings(
  workspaceId: string,
  patch: Record<string, unknown>
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  try {
    await db
      .update(workspaces)
      .set({
        settings: drizzleSql`${JSON.stringify(patch)}::jsonb || COALESCE(${workspaces.settings}, '{}'::jsonb)`,
      })
      .where(eq(workspaces.id, workspaceId));
  } catch (err) {
    logger.warn(
      { err, workspaceId, keys: Object.keys(patch) },
      "template door: failed to write appId/composedFrom (non-fatal)"
    );
  }
}

/**
 * The seed bodies of a space built just now, through the canonical body door
 * (`EntityBodyService`): long-form → a versioned document, short → inline.
 * Per-entity failures are logged, never fatal.
 */
async function seedBodies(
  userId: string,
  workspaceId: string,
  seeds: ReadonlyArray<{ title: string; content?: string }>,
  entityIds: string[]
): Promise<void> {
  const withContent = seeds
    .map((entity, idx) => ({ entity, entityId: entityIds[idx] }))
    .filter(
      (e): e is typeof e & { entity: { content: string }; entityId: string } =>
        !!e.entity.content && !!e.entityId
    );
  if (withContent.length === 0) return;
  const database = await getDb();
  const entityBodyService = new EntityBodyService(database, eventRepository);
  const entRepo = new EntityRepository(database, eventRepository);
  for (const { entity, entityId } of withContent) {
    try {
      const body = await entityBodyService.setBody({
        entityId,
        userId,
        workspaceId,
        title: entity.title,
        provenance: { createdByKind: "system", createdByUserId: userId },
        text: entity.content,
      });
      if (body.documentId) {
        await entRepo.update(entityId, { documentId: body.documentId }, userId);
      } else if (body.inlineContent !== undefined) {
        await entRepo.update(
          entityId,
          { properties: { content: body.inlineContent } },
          userId
        );
      }
    } catch (err) {
      logger.warn(
        { err, entityId, title: entity.title },
        "Failed to seed body for entity (non-fatal)"
      );
    }
  }
}

/** A typed refusal keeps its code; a build failure names the step it died at. */
function doorError(
  err: unknown,
  userId: string,
  source: string,
  packageSlug: string | undefined
): unknown {
  if (err instanceof TRPCError) return err;
  // The tRPC error middleware maps these (409 identity, 4xx domain errors).
  if (isWorkspaceIdentityConflictError(err)) return err;
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === "number" && statusCode < 500) return err;
  if (err instanceof ComposeBaseUnavailableError) {
    const unresolved = err.dependencies.find((d) => d.relation === "compose");
    return new TRPCError({
      code: "BAD_REQUEST",
      message:
        unresolved?.message ??
        "compose base not available — the base template must be installed on the pod first",
    });
  }
  if (err instanceof DependencyResolutionError)
    return new TRPCError({
      code: "BAD_REQUEST",
      message: `Dependency resolution failed: ${err.message}`,
    });
  if (err instanceof ComposeBaseNotFoundError)
    return new TRPCError({
      code: "NOT_FOUND",
      message: "compose base workspace not found",
    });
  // A compose onto a space the caller may not write is a REFUSAL (the write
  // gate's code), never a 500 "creation failed" with an error progress event.
  if (err instanceof ComposeOverlayError && err.refusalCode)
    return new TRPCError({
      code: err.refusalCode,
      message: `Compose overlay failed: ${err.message}`,
      cause: err,
    });
  const message = err instanceof Error ? err.message : String(err);
  const failedStep = message.match(/at step '([^']+)'/)?.[1];
  logger.error(
    { err, userId, packageSlug, failedStep, source },
    `${source} failed`
  );
  // The browser's loading state shows what went wrong instead of spinning.
  emitChatEvent({
    event: "workspace:creation_progress",
    data: {
      step: failedStep ?? "error",
      pct: 0,
      label: failedStep
        ? `Failed at step '${failedStep}': ${message}`
        : `Creation failed: ${message}`,
      status: "error",
    },
    userId,
  });
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: failedStep
      ? `Workspace creation failed at step '${failedStep}': ${message}`
      : `Workspace creation failed: ${message}`,
    cause: err,
  });
}

/**
 * The compose target for an install ONTO `workspaceId` — or none, when that
 * space already holds `packageSlug` as its own template: then the install is
 * that template's UPDATE, and the apply finds the same space (its pod-wide
 * identity) and plans it like any re-hit (unchanged · re-sync · a failed
 * layer 2 reopened). Composing it instead would skip the plan: always
 * re-write, never reopen a failed space (the browser update banner's path).
 */
export async function installTarget(
  workspaceId: string | undefined,
  packageSlug: string | undefined
): Promise<string | undefined> {
  if (!workspaceId || !packageSlug) return workspaceId;
  const [row] = await db
    .select({
      settings: workspaces.settings,
      packageSlug: workspaces.packageSlug,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const held = row
    ? (readTemplateState(row.settings, { packageSlug: row.packageSlug })
        ?.slug ?? null)
    : null;
  return held === packageSlug ? undefined : workspaceId;
}

export async function applyTemplateForTrpc(
  input: TrpcTemplateApplyInput
): Promise<TemplateApplyResult> {
  const { userId, identity } = input;
  let result: TemplateApplyResult;
  try {
    result = await applyTemplate({
      definition: input.definition,
      layerTwoBody: input.layerTwoBody,
      actor: { userId, agentUserId: input.agentUserId, scopes: [] },
      source: input.source,
      targetWorkspaceId: input.targetWorkspaceId,
      identity,
      catalogVersion: input.catalogVersion,
      sentDefinition: input.sentDefinition,
      onProgress: (step, pct, label) =>
        emitChatEvent({
          event: "workspace:creation_progress",
          data: { step, pct, label, status: "progress" },
          userId,
        }),
      beforeLayerTwo: async (workspaceId, { outcome, layerOne }) => {
        const built = outcome === "created";
        await fillSettings(workspaceId, {
          ...(built ? input.createdFill : {}),
          ...input.settingsFill,
        });
        if (built && layerOne?.built && input.seeds?.length)
          await seedBodies(
            userId,
            workspaceId,
            input.seeds,
            layerOne.built.entityIds
          );
      },
    });
  } catch (err) {
    throw doorError(err, userId, input.source, identity.packageSlug);
  }

  if (result.outcome === "created") {
    // The log event + its side-effects through the ONE mutation door, on the
    // `workspace` vocabulary the side-effects (and the Hub apply) use.
    await recordDomainMutation({
      subjectType: "workspace",
      action: "create",
      subjectId: result.workspaceId,
      userId,
      agentUserId: input.agentUserId,
      workspaceId: result.workspaceId,
      data: {
        id: result.workspaceId,
        packageSlug: identity.packageSlug,
        createdBy: identity.createdBy ?? "user",
      },
    });
    // Pod owner/admins join a pod-visible space (same gate as
    // `workspaces.create`); the stored row is the visibility source.
    try {
      const created = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, result.workspaceId),
        columns: { settings: true },
      });
      if (isPodReadableWorkspace(created?.settings))
        await materializePodAdminsIntoWorkspace(result.workspaceId);
    } catch (err) {
      logger.warn(
        { err, workspaceId: result.workspaceId },
        "Failed to materialize pod admins into new pod-visible workspace (non-fatal)"
      );
    }
  } else if (result.outcome === "composed") {
    auditLog({
      subjectType: "workspaces",
      subjectId: result.workspaceId,
      action: "update",
      phase: "completed",
      userId,
      data: { templateSlug: identity.packageSlug, composed: true },
    });
  }
  return result;
}

/**
 * Layer 2's verdict as `InstallLayerReport[]`: the applier's per-item bag
 * through the ONE summarizer, or the whole layer failed. Empty = nothing
 * failed (or nothing ran).
 */
export function templateLayerReports(
  result: Pick<TemplateApplyResult, "layer2">
): InstallLayerReport[] {
  if (result.layer2.status === "applied")
    return summarizePostWorkspaceLayers(result.layer2.post);
  if (result.layer2.status === "failed")
    // The raw cause is in the operator log (`applyTemplate`), never here.
    return [
      {
        layer: "post-workspace",
        status: "failed",
        message: layerTwoFailedSentence(),
      },
    ];
  return [];
}

export interface TemplateDoorReply {
  /** Kept for older clients: `"composed"` onto a base, else `"created"`. */
  status: "created" | "composed";
  /** What happened: created · reconciled · unchanged · composed. */
  outcome: TemplateApplyOutcome;
  workspaceId: string;
  composed: boolean;
  /** Built just now only (empty on a re-hit / compose). */
  profileIds: string[];
  viewIds: string[];
  entityIds: string[];
  /** Layer 1's re-sync (or compose) report, when it ran (with any failed layers). */
  reconciled: ReconcileReport | undefined;
  /**
   * A FAILED install layer; `undefined` = nothing failed. Always present as a
   * key (never a conditional spread: that widens the reply into a union and
   * hides `composed` from every consumer).
   */
  layers: InstallLayerReport[] | undefined;
  /** Project-scope playbooks the client may OFFER to start. */
  trackTemplates: InstalledTrackTemplate[];
  dependencies: ResolvedPackageDependency[];
  /** The pod's sentence for why the apply is not finished; null when it is. */
  warning: string | null;
}

export function templateDoorReply(
  result: TemplateApplyResult
): TemplateDoorReply {
  const layers = templateLayerReports(result);
  // A compose onto a space is a re-sync too: its report is the same shape.
  const reconciled = result.layerOne?.reconciled ?? result.compose?.report;
  const built = result.layerOne?.built;
  return {
    status: result.outcome === "composed" ? "composed" : "created",
    outcome: result.outcome,
    workspaceId: result.workspaceId,
    composed: result.outcome === "composed",
    profileIds: built?.profileIds ?? [],
    viewIds: built?.viewIds ?? [],
    entityIds: built?.entityIds ?? [],
    reconciled:
      reconciled && layers.length > 0 ? { ...reconciled, layers } : reconciled,
    layers: layers.length > 0 ? layers : undefined,
    trackTemplates:
      result.layer2.status === "applied"
        ? installedTrackTemplates(result.layer2.post)
        : [],
    dependencies: result.dependencies,
    warning: result.warning,
  };
}
