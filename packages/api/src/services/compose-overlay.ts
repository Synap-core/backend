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
  reconcileWorkspaceFromDefinition,
  type ReconcileReport,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";

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
   * Package provenance to stamp onto the target workspace's settings. Supplied
   * ONLY for an explicit install-onto-existing (`market attach --onto <ws>`),
   * so `market update` can later track it; omitted for a natural declared/
   * transitive compose so a shared base keeps its own stamp. Forwarded verbatim
   * to `reconcileWorkspaceFromDefinition`, which writes them only when present.
   */
  packageSlug?: string;
  packageVersion?: string;
}

/**
 * Layer `definition` ADDITIVELY onto the base workspace. Throws
 * `ComposeBaseNotFoundError` / `ComposeOverlayError` (callers map to their own
 * status codes).
 */
export async function composeOntoBaseWorkspace(
  input: ComposeOntoBaseInput
): Promise<ReconcileReport> {
  const {
    composeTargetWorkspaceId,
    userId,
    definition,
    packageSlug,
    packageVersion,
  } = input;

  const [baseWs] = await db
    .select({ id: workspaces.id, ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, composeTargetWorkspaceId))
    .limit(1);
  if (!baseWs) throw new ComposeBaseNotFoundError();

  try {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: baseWs.id,
      ownerId: baseWs.ownerId,
    });
    return await reconcileWorkspaceFromDefinition({
      workspaceId: composeTargetWorkspaceId,
      userId,
      definition,
      mergeCapabilities: true,
      packageSlug,
      packageVersion,
    });
  } catch (e) {
    throw new ComposeOverlayError((e as Error).message);
  }
}
