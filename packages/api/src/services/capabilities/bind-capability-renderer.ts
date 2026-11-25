/**
 * Bind a capability's renderer page-set — the ONE governed door.
 *
 * Shared by the tRPC route `capabilities.setRenderer` (the desktop's renderer
 * chip) and MCP `synap_promote_cell_to_renderer` with a `capability` target.
 * Both reach the store the same way: authorize on the LOADED capability (never
 * a request-supplied workspace), gate with `checkPermissionOrPropose`
 * (`capability` / `renderer.set`, absent from DEFAULT_AUTO_APPROVE like every
 * meta-model write), then apply through `setCapabilityRenderer` — the same
 * service the `capability/renderer.set` proposal executor replays on approval.
 *
 * scope 'workspace' writes the per-workspace overlay
 * (workspaces.settings.capabilityRenderers[capabilityId]); scope 'capability'
 * writes the capability's own default (capabilities.metadata.renderers). An
 * empty `pages` array CLEARS the binding for the scope.
 */

import {
  db,
  eq,
  capabilities as capabilitiesTable,
  workspaces,
} from "@synap/database";
import type { CapabilityRendererPage } from "@synap/database";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { TRPCError } from "@trpc/server";

import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import {
  setCapabilityRenderer,
  type CapabilityRendererScope,
} from "./set-capability-renderer.js";

export interface BindCapabilityRendererInput {
  userId: string;
  /** The acting agent, when an agent is the caller (its write becomes a proposal). */
  agentUserId?: string;
  /** Governance source recorded on the gate (`operator` for the desktop). */
  source: string;
  capabilityId: string;
  /** Required for scope 'workspace'; the overlay's target workspace. */
  workspaceId: string | null;
  scope: CapabilityRendererScope;
  /**
   * The page-set to store, or a function of the page-set stored at this scope
   * now (how a one-page change keeps the others). Resolved after the
   * capability is authorized, before the gate, so the proposal carries the
   * full set an approval writes.
   */
  pages:
    | CapabilityRendererPage[]
    | ((stored: CapabilityRendererPage[]) => CapabilityRendererPage[]);
  reasoning?: string;
}

export type BindCapabilityRendererResult =
  | { status: "applied"; proposalId: null }
  | {
      status: "proposed";
      proposalId: string;
      summary?: string;
      reviewPath?: string;
      reviewUrl?: string;
      deduped?: boolean;
    };

/** The page-set stored at one scope (not the effective one). */
async function storedPages(
  capabilityMetadata: unknown,
  capabilityId: string,
  scope: CapabilityRendererScope,
  workspaceId: string | null
): Promise<CapabilityRendererPage[]> {
  if (scope === "capability") {
    const config = (capabilityMetadata as Record<string, unknown> | null)
      ?.renderers as { pages?: CapabilityRendererPage[] } | undefined;
    return Array.isArray(config?.pages) ? config.pages : [];
  }
  if (!workspaceId) return [];
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { settings: true },
  });
  const overlay = (
    (workspace?.settings as Record<string, unknown> | null)
      ?.capabilityRenderers as
      Record<string, { pages?: CapabilityRendererPage[] }> | undefined
  )?.[capabilityId];
  return Array.isArray(overlay?.pages) ? overlay.pages : [];
}

export async function bindCapabilityRenderer(
  input: BindCapabilityRendererInput
): Promise<BindCapabilityRendererResult> {
  const { userId, capabilityId, scope } = input;
  const workspaceId = input.workspaceId ?? null;

  // Load the capability by id ALONE, then gate on the LOADED row's workspace
  // (never a request-supplied workspaceId — the cross-workspace write-leak
  // class). assertWorkspaceWrite is the AUTHZ floor; the governance gate
  // below decides auto-apply vs propose, not access.
  const [cap] = await db
    .select({
      id: capabilitiesTable.id,
      workspaceId: capabilitiesTable.workspaceId,
      createdBy: capabilitiesTable.createdBy,
      metadata: capabilitiesTable.metadata,
    })
    .from(capabilitiesTable)
    .where(eq(capabilitiesTable.id, capabilityId))
    .limit(1);
  if (!cap) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Capability not found" });
  }

  if (scope === "capability") {
    // Editing the capability's own default → must be able to write ITS
    // workspace (or own it, if pod-wide).
    await assertWorkspaceWrite(db, userId, {
      workspaceId: cap.workspaceId,
      ownerId: cap.createdBy,
    });
  } else {
    if (!workspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "workspaceId is required for a workspace-scoped renderer",
      });
    }
    // Writing a per-workspace overlay → must be able to write THAT workspace.
    await assertWorkspaceWrite(db, userId, { workspaceId });
  }

  const pages =
    typeof input.pages === "function"
      ? input.pages(
          await storedPages(cap.metadata, capabilityId, scope, workspaceId)
        )
      : input.pages;

  const perm = await checkPermissionOrPropose({
    userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    // Governance lens: the capability's own workspace for a default write,
    // the overlay target for a workspace-scoped write.
    workspaceId: scope === "capability" ? cap.workspaceId : workspaceId,
    subjectType: "capability",
    action: "renderer.set",
    source: input.source,
    reasoning: input.reasoning,
    // STORE EVERYTHING approval needs — the executor reads capabilityId +
    // scope + the full pages payload, so approving actually applies the
    // binding (not a {id}-only gate that no-ops).
    data: { capabilityId, scope, pages },
  });

  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
      ...(perm.deduped ? { deduped: true } : {}),
    };
  }

  // Granted → apply immediately via the shared write path.
  await setCapabilityRenderer({
    userId,
    workspaceId,
    capabilityId,
    pages,
    scope,
  });
  return { status: "applied", proposalId: null };
}

/**
 * The page-set with ONE page set or removed: `ref` replaces the page under
 * `slot` (or appends it, titled from the slot), `null` removes it. Every other
 * page stays where it was — binding the `detail` page never drops a bound
 * `dashboard` page.
 */
export function withCapabilityPage(
  pages: CapabilityRendererPage[],
  slot: string,
  ref: CapabilityRendererPage["ref"] | null
): CapabilityRendererPage[] {
  if (ref === null) return pages.filter((p) => p.slot !== slot);
  const existing = pages.find((p) => p.slot === slot);
  if (existing) {
    return pages.map((p) => (p.slot === slot ? { ...p, ref } : p));
  }
  return [...pages, { slot, title: humanizeToken(slot), ref }];
}
