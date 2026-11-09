/**
 * Renderer targets — what the doors CHECK before a binding is gated, and the
 * ONE reader per store that answers "what is bound here now".
 *
 * Every door that binds a renderer to a target (Hub `profiles.setRenderer`,
 * MCP `synap_promote_cell_to_renderer`) runs the same three checks BEFORE it
 * files a proposal, so a person never approves a binding that cannot serve:
 *
 *   1. the slot and scope are valid for the target kind (`rendererTargetProblem`);
 *   2. a per-object target is an object the caller can open, of that kind
 *      (`resolveObjectKind`, the one id → kind prober);
 *   3. the cell exists: a built-in renderable, an active stored cell in scope,
 *      or a cell still awaiting review in a `cell/define` proposal (the
 *      create-then-bind loop files both before either is approved).
 */

import {
  and,
  db,
  eq,
  isNull,
  or,
  proposals,
  widgetDefinitions,
  getEffectiveCapabilityRenderer,
  ProfileResolutionService,
  userVisibleWhere,
} from "@synap/database";
import type { RendererRef } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { isBuiltinRenderableKey } from "@synap-core/types/renderables";
import { TRPCError } from "@trpc/server";

import { resolveObjectKind } from "../diagnose/resolve-object-kind.js";
import { authoredByUser } from "../agent-identity-service.js";
import { cellTypeKeyFor } from "../cells/define-cell.js";
import {
  SLOT_TO_CONTENT_KIND,
  type RendererSlot,
} from "../profiles/renderer-slots.js";
import {
  RENDERER_TARGETS,
  type RendererStore,
  type RendererTarget,
} from "./renderer-targets.js";

/**
 * Frame definitions are registered directly. Iframe widgets resolve through the
 * generic (sandboxed) iframe host.
 *
 * `"native"` is kept in the branch below deliberately, and NOT because native is
 * sandboxed — it never was. The renderer has been removed, but legacy rows still
 * carry `renderer_type = 'native'`. Mapping them to the sandboxed iframe host is
 * the fail-SAFE degradation: such a row has no `rendererSource`, so it renders an
 * init error instead of executing anything. Do not "fix" this by routing native
 * anywhere that runs code. See NATIVE_RENDERER_REJECTED in
 * `routers/widget-definitions.ts`.
 */
export function buildCellRendererRef(
  cellKey: string,
  props?: Record<string, unknown>,
  rendererType?: string | null
): RendererRef {
  if (rendererType === "iframe" || rendererType === "native") {
    return {
      kind: "cell",
      cellKey: "iframe-widget",
      props: { typeKey: cellKey, ...(props ?? {}) },
    };
  }
  return { kind: "cell", cellKey, props: props ?? {} };
}

/** The stored cell rows for `cellKey` in this scope: this space's, then pod-wide. */
async function storedCellRows(cellKey: string, workspaceId: string | null) {
  return db
    .select({
      workspaceId: widgetDefinitions.workspaceId,
      rendererType: widgetDefinitions.rendererType,
      isActive: widgetDefinitions.isActive,
    })
    .from(widgetDefinitions)
    .where(
      and(
        eq(widgetDefinitions.typeKey, cellKey),
        workspaceId
          ? or(
              eq(widgetDefinitions.workspaceId, workspaceId),
              isNull(widgetDefinitions.workspaceId)
            )
          : isNull(widgetDefinitions.workspaceId)
      )
    );
}

/**
 * The ref a door binds for `cellKey` — the stored row's renderer type decides
 * whether it mounts directly or through the sandboxed iframe host.
 */
export async function cellRendererRefFor(
  cellKey: string,
  props: Record<string, unknown> | undefined,
  workspaceId: string | null
): Promise<RendererRef> {
  const rows = await storedCellRows(cellKey, workspaceId);
  const row =
    rows.find((r) => r.workspaceId !== null) ??
    rows.find((r) => r.workspaceId === null);
  return buildCellRendererRef(cellKey, props, row?.rendererType);
}

/**
 * Refuse a cell that does not exist. Accepted: a built-in renderable, an
 * ACTIVE stored cell in this scope (a space's own row shadows a pod-wide one),
 * or a cell a `cell/define` proposal the caller can see is still waiting to
 * create — binding it is the second half of the create-then-bind loop, and the
 * two proposals are reviewed together.
 */
export async function assertCellBindable(input: {
  cellKey: string;
  workspaceId: string | null;
  userId: string;
}): Promise<void> {
  const { cellKey, workspaceId, userId } = input;
  if (isBuiltinRenderableKey(cellKey)) return;

  const rows = await storedCellRows(cellKey, workspaceId);
  const row =
    rows.find((r) => r.workspaceId !== null) ??
    rows.find((r) => r.workspaceId === null);
  if (row?.isActive) return;
  if (row && !row.isActive) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cell '${cellKey}' is switched off. Turn it back on before binding it as a renderer.`,
    });
  }

  const pending = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "cell"),
        eq(proposals.status, ProposalStatus.PENDING),
        or(
          userVisibleWhere(proposals.workspaceId, userId),
          authoredByUser(userId)
        )
      )
    )
    .limit(200);
  const awaitingReview = pending.some(({ data }) => {
    const inner = ((data as Record<string, unknown> | null)?.data ??
      {}) as Record<string, unknown>;
    if (typeof inner.name !== "string" || inner.name === "") return false;
    const typeKey =
      typeof inner.typeKey === "string" && inner.typeKey !== ""
        ? inner.typeKey
        : undefined;
    return cellTypeKeyFor(inner.name, typeKey) === cellKey;
  });
  if (awaitingReview) return;

  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      `No cell '${cellKey}' exists here. Create it first with synap_create_cell ` +
      `(its key is 'generated:<name-slug>'), or pick one from synap_list_widgets.`,
  });
}

/**
 * Refuse a per-object target the caller cannot open, or that is not the kind
 * it claims. Returns the object's own workspace (`null` = pod-wide). A target
 * that names a whole kind (`profile`) has nothing to resolve.
 */
export async function assertRendererTargetVisible(
  target: RendererTarget,
  userId: string
): Promise<{ workspaceId: string | null }> {
  if (target.kind === "profile") return { workspaceId: null };
  const expected = RENDERER_TARGETS[target.kind].openAs;
  const resolved = await resolveObjectKind(target.id, userId);
  const sameKind =
    resolved?.kind === expected &&
    // `capability` covers three tables in the prober; only a registered
    // capability carries a renderer page-set.
    (expected !== "capability" || resolved.subKind === "capability");
  if (!resolved || !sameKind) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No ${target.kind} '${target.id}' that you can see.`,
    });
  }
  return { workspaceId: resolved.workspaceId ?? null };
}

/** What is bound on a target's slot now, or null when nothing is. */
export interface BoundRenderer {
  ref: RendererRef;
  /** Which layer answered (the store's own source vocabulary). */
  source: string;
}

export interface RendererReadQuery {
  target: RendererTarget;
  slot: RendererSlot;
  userId: string;
  /** The lens the reader resolves in, exactly as the desktop passes it. */
  workspaceId: string | null;
}

/**
 * The ONE reader per store — the same resolution the desktop's read doors run
 * (`profiles.getEffectiveRenderers` for `renderer_bindings`,
 * `capabilities.getEffectiveRenderer` for `capability_pages`). Keyed by
 * {@link RendererStore} so a new store cannot exist without a reader:
 * `renderer-targets-have-a-resolver.tripwire.test.ts` writes through each
 * target's door and reads back through this.
 */
export const RENDERER_STORE_READERS: Record<
  RendererStore,
  (q: RendererReadQuery) => Promise<BoundRenderer | null>
> = {
  renderer_bindings: async ({ target, slot, userId, workspaceId }) => {
    const subjectKind = target.kind === "profile" ? target.slug : target.kind;
    const hit = await new ProfileResolutionService(
      db
    ).getEffectiveRendererWithSource(
      subjectKind,
      workspaceId,
      SLOT_TO_CONTENT_KIND[slot],
      {
        userId,
        subjectId: target.kind === "profile" ? null : target.id,
      }
    );
    // `default` is the hardcoded system fallback: nothing is bound.
    return hit.source === "default"
      ? null
      : { ref: hit.ref, source: hit.source };
  },
  capability_pages: async ({ target, slot, workspaceId }) => {
    if (target.kind === "profile") return null;
    const { pages, source } = await getEffectiveCapabilityRenderer(
      db,
      target.id,
      workspaceId
    );
    const page = pages.find((p) => p.slot === slot);
    return page ? { ref: page.ref, source } : null;
  },
};

/** Read what is bound on a target's slot, through its store's reader. */
export function readBoundRenderer(
  q: RendererReadQuery
): Promise<BoundRenderer | null> {
  return RENDERER_STORE_READERS[RENDERER_TARGETS[q.target.kind].store](q);
}
