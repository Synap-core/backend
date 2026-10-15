/**
 * Compose Overlay — the ONE door that layers an overlay package onto a base
 * workspace.
 * ==========================================================================
 *
 * Extracted from `workspace-materialization-service.ts` so that BOTH compose
 * call-sites drive the identical mechanics:
 *
 *   1. `materializeWorkspaceCore` — the TOP-LEVEL compose (the package being
 *      applied declares `compose: <base>`).
 *   2. `package-dependency-resolver` — the TRANSITIVE compose (a package
 *      `require`s a dependency template that ITSELF declares `compose: <base>`;
 *      that dependency must be layered onto its base, never materialized as a
 *      rogue standalone workspace).
 *
 * It lives in its own module rather than in the materialization service because
 * the resolver is imported BY that service — putting the primitive there would
 * make the two modules mutually importing. This module depends only on
 * `@synap/database` + the write-access util, so both can import it cleanly.
 *
 * The mechanics are deliberately tiny and total:
 *   - load the base row (gone → `ComposeBaseNotFoundError`),
 *   - write-gate it via `assertWorkspaceWrite` (defense in depth: the resolver
 *     already restricts compose targets to editor+ memberships), then
 *   - `reconcileWorkspaceFromDefinition({ mergeCapabilities: true })` — ADDITIVE
 *     layering, never a destructive overwrite, never a second workspace.
 */

import { unfilteredAiFanoutError } from "@synap-core/types/automations";
import {
  db,
  eq,
  workspaces,
  eventRepository,
  readTemplateState,
  upsertPack,
  reconcileWorkspaceFromDefinition,
  type ReconcileReport,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import {
  refusalCodeInCause,
  type RefusalTrpcCode,
} from "../utils/trpc-cause-code.js";
import {
  applyDefinitionSeeds,
  definitionSeedEntities,
  type DefinitionSeedRelation,
  type DefinitionSeedResult,
} from "./definition-seeds.js";

/**
 * The compose report: the schema reconcile plus the overlay's SEEDS, adopted
 * onto the base by `(kind, title)` (W4b — before, an overlay install applied
 * schema only, so its seed entities never landed on any install door).
 */
export type ComposeReport = ReconcileReport & {
  seeds?: DefinitionSeedResult;
  /**
   * The explicit `--onto` slug became the target's template IDENTITY (an
   * unidentified target, or a re-attach of the same slug) — as opposed to an
   * overlay pack recorded in `installedPacks`. The version that identity is at
   * is the caller's to stamp, through `finishTemplateApply`.
   */
  identityStamped?: boolean;
  /**
   * The overlay pack recorded in the target's `installedPacks` and the version
   * it is being applied at — NOT written to the ledger here (the entry keeps
   * its previous version, or none when new). The caller hands it to
   * `finishTemplateApply`, which records the version only once layer 2
   * converged. Absent when nothing was recorded as a pack.
   */
  pendingPack?: { slug: string; version: string };
};

/**
 * The compose base workspace row was gone by the time we loaded it (a delete /
 * race between resolve and compose). Hub maps this to a 500 "Compose overlay
 * failed"; tRPC maps it to NOT_FOUND.
 */
export class ComposeBaseNotFoundError extends Error {
  constructor() {
    super("compose base workspace not found");
    this.name = "ComposeBaseNotFoundError";
  }
}

/**
 * The compose overlay itself failed — `assertWorkspaceWrite` or
 * `reconcileWorkspaceFromDefinition` threw. It keeps the original error as
 * its `cause`, so a refusal stays a refusal at every door: the write gate's
 * FORBIDDEN is `refusalCode` here (tRPC) and a 403 through the Hub's
 * cause-walking `httpStatusForTrpcError`; a re-sync that broke has no
 * refusal code and is a server fault (500).
 */
export class ComposeOverlayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ComposeOverlayError";
  }

  /**
   * The tRPC code of a refusal in the cause chain, or null (a server fault) —
   * the same walk and code set the Hub maps to HTTP (`refusalCodeInCause`).
   */
  get refusalCode(): RefusalTrpcCode | null {
    return refusalCodeInCause(this.cause);
  }
}

export interface ComposeOntoBaseInput {
  /** The resolved base workspace to layer onto. */
  composeTargetWorkspaceId: string;
  userId: string;
  /** The OVERLAY's definition — layered additively onto the base. */
  definition: WorkspaceDefinitionInput;
  /**
   * Explicit install-onto-existing (`market attach --onto <ws>`) provenance.
   * Stamped as the workspace's template IDENTITY only when the target has none
   * yet (or already carries this same slug). A target that already has its OWN
   * identity keeps it — the package is recorded as an overlay pack instead.
   * Before this, `--onto` clobbered e.g. Foundation's `packageSlug` with
   * `business-model`, so Foundation stopped reconciling to foundation.yaml.
   */
  packageSlug?: string;
  // No `packageVersion`: the version an identity is at is stamped only by
  // `finishTemplateApply`, once the caller's layer 2 converged — the caller
  // gets it back as `MaterializeCoreResult.pendingVersionStamp`.
  /**
   * The overlay package's own identity — recorded in the target's
   * `settings.installedPacks` on EVERY compose (natural, transitive, or
   * `--onto`), so the boot reconcile can re-sync the pack and drift surfaces can
   * see it. Nothing wrote `installedPacks` server-side before, so a composed
   * pack could never reconcile nor show drift.
   */
  overlay?: { slug?: string; version?: string };
}

/**
 * The overlay definition with the base workspace's SHELL removed — what a pack
 * may layer onto a workspace that has its own template identity. The settings
 * step of `reconcileWorkspaceFromDefinition` overwrites `workspaceSubtype` /
 * `workspaceVisibility` unconditionally and a `layoutConfig.primarySurface`
 * REPLACES the live one; from an overlay each would rewrite the base's identity.
 * Profiles, views, links, sidebar items, capabilities stay additive. Pure.
 */
export function overlayDefinitionForIdentifiedBase(
  definition: WorkspaceDefinitionInput
): WorkspaceDefinitionInput {
  const {
    workspaceSubtype: _subtype,
    workspaceVisibility: _visibility,
    // What the space produces belongs to its own template, never an overlay.
    intent: _intent,
    ...rest
  } = definition as WorkspaceDefinitionInput & {
    workspaceSubtype?: unknown;
    workspaceVisibility?: unknown;
  };
  const layout = (rest as { layoutConfig?: Record<string, unknown> })
    .layoutConfig;
  if (layout && "primarySurface" in layout) {
    const { primarySurface: _primary, ...layoutRest } = layout;
    return {
      ...rest,
      layoutConfig: layoutRest,
    } as unknown as WorkspaceDefinitionInput;
  }
  return rest as WorkspaceDefinitionInput;
}

/**
 * Layer `definition` ADDITIVELY onto the base workspace. Throws
 * `ComposeBaseNotFoundError` / `ComposeOverlayError` (callers map to their own
 * status codes).
 */
export async function composeOntoBaseWorkspace(
  input: ComposeOntoBaseInput
): Promise<ComposeReport> {
  const { composeTargetWorkspaceId, userId, definition } = input;

  const [baseWs] = await db
    .select({
      id: workspaces.id,
      ownerId: workspaces.ownerId,
      settings: workspaces.settings,
      packageSlug: workspaces.packageSlug,
    })
    .from(workspaces)
    .where(eq(workspaces.id, composeTargetWorkspaceId))
    .limit(1);
  if (!baseWs) throw new ComposeBaseNotFoundError();

  const baseIdentity =
    readTemplateState(baseWs.settings, { packageSlug: baseWs.packageSlug })
      ?.slug ?? null;
  // Stamp the explicit `--onto` slug as IDENTITY only on an unidentified target
  // (or a re-attach of the same slug). Otherwise it is an overlay pack.
  const stampIdentity =
    !!input.packageSlug &&
    (baseIdentity === null || baseIdentity === input.packageSlug);
  const overlaySlug = input.overlay?.slug ?? input.packageSlug;
  const recordPack = !!overlaySlug && overlaySlug !== baseIdentity;

  try {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: baseWs.id,
      ownerId: baseWs.ownerId,
    });
    const report = await reconcileWorkspaceFromDefinition({
      validateFlow: unfilteredAiFanoutError,
      workspaceId: composeTargetWorkspaceId,
      userId,
      definition:
        baseIdentity !== null && !stampIdentity
          ? overlayDefinitionForIdentifiedBase(definition)
          : definition,
      mergeCapabilities: true,
      ...(stampIdentity ? { packageSlug: input.packageSlug } : {}),
    });
    if (recordPack && !stampIdentity) {
      // The VERSION is not recorded here: layer 2 has not run. The entry
      // keeps its previous version (or none when new); the finisher records
      // `pendingPack.version` on convergence. Upserted under the template-state
      // writer's row lock, so a concurrent pack record is never lost.
      await upsertPack(
        db,
        composeTargetWorkspaceId,
        { slug: overlaySlug! },
        { userId }
      );
    }
    // Seeds — adopt what the base already holds, create only what is missing.
    // Per-seed failures are collected (never thrown), like the other doors.
    const seedList = definitionSeedEntities(definition);
    const pendingPack =
      recordPack && !stampIdentity && input.overlay?.version
        ? { slug: overlaySlug!, version: input.overlay.version }
        : undefined;
    if (seedList.length === 0)
      return {
        ...report,
        identityStamped: stampIdentity,
        ...(pendingPack ? { pendingPack } : {}),
      };
    const seeds = await applyDefinitionSeeds({
      database: db,
      eventRepo: eventRepository,
      userId,
      workspaceId: composeTargetWorkspaceId,
      seeds: seedList,
      relations: (
        definition as { suggestedRelations?: DefinitionSeedRelation[] }
      ).suggestedRelations,
    });
    return {
      ...report,
      seeds,
      identityStamped: stampIdentity,
      ...(pendingPack ? { pendingPack } : {}),
    };
  } catch (e) {
    throw new ComposeOverlayError((e as Error).message, { cause: e });
  }
}
