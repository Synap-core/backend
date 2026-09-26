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

import {
  db,
  eq,
  workspaces,
  eventRepository,
  WorkspaceRepository,
  reconcileWorkspaceFromDefinition,
  type ReconcileReport,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
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
export type ComposeReport = ReconcileReport & { seeds?: DefinitionSeedResult };

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
 * `reconcileWorkspaceFromDefinition` threw. Hub maps this to a 500 "Compose
 * overlay failed"; tRPC lets it propagate to a 500 — distinct from a
 * create-path failure so each door surfaces its original message.
 */
export class ComposeOverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeOverlayError";
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
  packageVersion?: string;
  /**
   * The overlay package's own identity — recorded in the target's
   * `settings.installedPacks` on EVERY compose (natural, transitive, or
   * `--onto`), so the boot reconcile can re-sync the pack and drift surfaces can
   * see it. Nothing wrote `installedPacks` server-side before, so a composed
   * pack could never reconcile nor show drift.
   */
  overlay?: { slug?: string; version?: string };
}

/** One `settings.installedPacks` entry. */
export interface InstalledPackEntry {
  slug: string;
  version: string;
  installedAt: string;
}

/**
 * Upsert a pack into an `installedPacks` ledger (by slug). A re-compose
 * refreshes the version and keeps the first `installedAt`. Pure.
 */
export function upsertInstalledPack(
  ledger: unknown,
  pack: { slug: string; version?: string | null },
  now: string
): InstalledPackEntry[] {
  const list = Array.isArray(ledger)
    ? (ledger as Array<Partial<InstalledPackEntry>>).filter(
        (e): e is InstalledPackEntry =>
          !!e && typeof e === "object" && typeof e.slug === "string"
      )
    : [];
  const existing = list.find((e) => e.slug === pack.slug);
  const entry: InstalledPackEntry = {
    slug: pack.slug,
    version: pack.version ?? existing?.version ?? "",
    installedAt: existing?.installedAt ?? now,
  };
  return [...list.filter((e) => e.slug !== pack.slug), entry];
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

  const baseSettings = (baseWs.settings ?? {}) as {
    packageSlug?: string;
    installedPacks?: unknown;
  };
  const baseIdentity = baseSettings.packageSlug ?? baseWs.packageSlug ?? null;
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
      workspaceId: composeTargetWorkspaceId,
      userId,
      definition:
        baseIdentity !== null && !stampIdentity
          ? overlayDefinitionForIdentifiedBase(definition)
          : definition,
      mergeCapabilities: true,
      ...(stampIdentity
        ? {
            packageSlug: input.packageSlug,
            packageVersion: input.packageVersion,
          }
        : {}),
    });
    if (recordPack && !stampIdentity) {
      const repo = new WorkspaceRepository(db, eventRepository);
      await repo.mergeSettings(
        composeTargetWorkspaceId,
        {
          installedPacks: upsertInstalledPack(
            baseSettings.installedPacks,
            {
              slug: overlaySlug!,
              version: input.overlay?.version ?? input.packageVersion,
            },
            new Date().toISOString()
          ),
        },
        userId
      );
    }
    // Seeds — adopt what the base already holds, create only what is missing.
    // Per-seed failures are collected (never thrown), like the other doors.
    const seedList = definitionSeedEntities(definition);
    if (seedList.length === 0) return report;
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
    return { ...report, seeds };
  } catch (e) {
    throw new ComposeOverlayError((e as Error).message);
  }
}
