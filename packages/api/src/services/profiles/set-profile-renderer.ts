/**
 * Set a profile's renderer — the shared write path.
 *
 * SINGLE SOURCE OF TRUTH used by BOTH the governed Hub route (operator
 * auto-apply) AND the `profile/renderer.set` proposal executor (agent proposal
 * → materialize on approval), plus the tRPC override door and MCP
 * `synap_promote_cell_to_renderer`.
 *
 * WHAT THIS WRITES (K2). The canonical store is now `renderer_bindings` — the
 * ONE table `ProfileResolutionService.getEffectiveRendererWithSource` reads at
 * layer 0, ABOVE the three legacy stores. Every call writes a binding through
 * `setRendererBinding` / `revokeRendererBinding` (`@synap/database`), which is
 * the only insert path into that table.
 *
 * LEGACY MIRROR — DECIDED, TIME-BOXED, NOT SILENT. For ONE release this door
 * ALSO keeps writing the legacy store a given scope used to own:
 *   - `scope: 'workspace'` → `workspaces.settings.profileRenderers[slug][kind]`
 *   - `scope: 'pod'`       → `profiles.defaultRenderers` + the deprecated
 *                            `default_(list|detail|dashboard)_renderer` column
 * so that a reader which has NOT been moved to the binding rung (an older pod
 * build, the frontend's own cached workspace settings) does not regress the
 * moment this lands. The mirror is gated on ONE named flag,
 * {@link MIRROR_LEGACY_RENDERER_STORES}, so retiring it is a one-line change
 * and not an archaeology exercise. It is deliberately NOT written for
 * `scope: 'user'`, the one shape the legacy stores cannot express — there is
 * no legacy key for it, and inventing one would fork the store this table
 * exists to unify. A per-object (`subjectId`) binding is a second such shape
 * in principle, but is moot in practice: this door REFUSES any non-null
 * `subjectId` outright (decision 2026-09-07, whole-kind only — see
 * `renderer-bindings.ts`), so it never reaches the mirror question.
 *
 * Mirrors the two pre-existing tRPC write paths it subsumes:
 *   - workspace overlay → `profiles.setProfileRendererOverride`
 *   - pod system default → `profiles.update` defaults( list|detail|dashboard )Renderer.
 */

import {
  getDb,
  ProfileRepository,
  ProfileResolutionService,
  WorkspaceRepository,
  eventRepository,
  revokeRendererBinding,
  setRendererBinding,
  widgetDefinitions,
  workspaces,
  and,
  eq,
  isNull,
  or,
} from "@synap/database";
import type { RendererRef, RendererSurface } from "@synap/database";
import { OBJECT_KINDS } from "@synap-core/types/vocabulary";
import { TRPCError } from "@trpc/server";

import { assertMayBindRenderer } from "./renderer-binding-authz.js";
import { assertRendererRefAllowedForScope } from "./renderer-ref-scope.js";
import {
  SLOT_TO_CONTENT_KIND,
  type RendererScope,
  type RendererSlot,
} from "./renderer-slots.js";

/**
 * The slot/scope vocabularies live in their own dependency-free module
 * (`renderer-slots.ts`) so a wire schema can import the enum without pulling in
 * this write path. Re-exported here for the existing callers that already
 * import them from this module.
 */
export {
  RENDERER_SLOTS,
  RENDERER_SCOPES,
  type RendererSlot,
  type RendererScope,
} from "./renderer-slots.js";

/**
 * Keep writing the pre-`renderer_bindings` stores alongside the binding, for
 * one release, so un-migrated readers do not regress. Flip to `false` (and then
 * delete the branches it guards) once every reader resolves through
 * `getEffectiveRendererWithSource`.
 */
export const MIRROR_LEGACY_RENDERER_STORES = true;

/**
 * The deprecated singular column a slot ALSO writes, for back-compat with rows
 * that predate `default_renderers` (migration 0112). `card` is deliberately
 * absent: `entity-card` is newer than the column era, so it has no legacy
 * column and lives ONLY in the `default_renderers` map. Written as a lookup
 * rather than a ternary chain because a chain's final `else` silently swallows
 * any slot added later — which is exactly how `card` would have landed in
 * `defaultDashboardRenderer`.
 */
const LEGACY_COLUMN_BY_SLOT: Partial<Record<RendererSlot, string>> = {
  list: "defaultListRenderer",
  detail: "defaultDetailRenderer",
  dashboard: "defaultDashboardRenderer",
};

/**
 * True iff `subjectKind` is a NON-PROFILE object kind — `proposal`, `session`,
 * `capability`, … — read from the ONE object-identity registry
 * (`OBJECT_KINDS`, `@synap-core/types/vocabulary`): any kind registered there
 * under a category other than `entity`. Such a subject has no `profiles` row
 * and no key in either legacy store (both are keyed by profile slug), so it is
 * never mirrored and never needs a profile to exist.
 *
 * A custom profile slug is absent from the registry and therefore reads as a
 * profile — the conservative side: it keeps today's preflight and mirror.
 */
export function isNonProfileObjectKind(subjectKind: string): boolean {
  if (!Object.hasOwn(OBJECT_KINDS, subjectKind)) return false;
  return OBJECT_KINDS[subjectKind]!.category !== "entity";
}

/**
 * The `rendererType` of the cell a ref names — the SAME scope rule
 * `resolveSurfaceRenderer` and Hub `profiles.setRenderer` use to find it: this
 * workspace's row or a pod-wide one, a workspace row shadowing a pod-wide row
 * of the same key. `null` = no such cell (a built-in has no row), or inactive.
 * An iframe cell is referenced as `iframe-widget` with its real key in
 * `props.typeKey`.
 */
async function lookupCellRendererType(
  db: Awaited<ReturnType<typeof getDb>>,
  ref: RendererRef,
  workspaceId: string | null
): Promise<string | null> {
  if (ref.kind !== "cell") return null;
  const props = (ref.props ?? {}) as Record<string, unknown>;
  const key =
    ref.cellKey === "iframe-widget" && typeof props.typeKey === "string"
      ? props.typeKey
      : ref.cellKey;
  const rows = await db
    .select({
      workspaceId: widgetDefinitions.workspaceId,
      rendererType: widgetDefinitions.rendererType,
      isActive: widgetDefinitions.isActive,
    })
    .from(widgetDefinitions)
    .where(
      and(
        eq(widgetDefinitions.typeKey, key),
        workspaceId
          ? or(
              eq(widgetDefinitions.workspaceId, workspaceId),
              isNull(widgetDefinitions.workspaceId)
            )
          : isNull(widgetDefinitions.workspaceId)
      )
    );
  const row =
    rows.find((r) => r.workspaceId !== null) ??
    rows.find((r) => r.workspaceId === null);
  return row && row.isActive ? (row.rendererType ?? null) : null;
}

export interface SetProfileRendererInput {
  userId: string;
  /** Required for `scope: 'workspace'`; also used to resolve the profile lens. */
  workspaceId: string | null;
  profileSlug: string;
  slot: RendererSlot;
  /** `null` clears the binding (and a workspace overlay); see the pod caveat below. */
  ref: RendererRef | null;
  scope: RendererScope;
  /**
   * REFUSED. Renderer bindings are whole-kind only (decision 2026-09-07, see
   * the header of `renderer-bindings.ts`) — a non-null value is rejected at
   * this door with `BAD_REQUEST` before any write. The field stays on the
   * input shape only because the three callers upstream (tRPC
   * `profiles.setProfileRendererOverride`, Hub Protocol `profiles.setRenderer`,
   * and the `profile/renderer.set` proposal executor) still parse and forward
   * it; removing it there is a separate, larger cleanup than this refusal.
   */
  subjectId?: string | null;
  /** Set when a proposal approval materialized this write — kept as lineage. */
  sourceProposalId?: string | null;
  /**
   * WHICH HOST renders the binding (0299). Omitted = `app`, the in-app
   * surface every caller meant before 0299. An `mcp-app` binding lives ONLY in
   * `renderer_bindings`: the legacy stores are in-app stores that know no
   * surface, so mirroring one there would leak an outside-host renderer into
   * the browser/relay chain.
   */
  surface?: RendererSurface;
}

/**
 * Apply a profile renderer write.
 *
 * Caller MUST have gated on intent first (`checkPermissionOrPropose` — agent
 * vs operator). This function additionally enforces the per-scope ROLE floor
 * (`assertMayBindRenderer`), which is a different question and was previously
 * unasked for `scope: 'pod'`.
 */
export async function setProfileRenderer(
  input: SetProfileRendererInput
): Promise<void> {
  const {
    userId,
    workspaceId,
    profileSlug,
    slot,
    ref,
    scope,
    subjectId = null,
    sourceProposalId = null,
    surface = "app",
  } = input;

  // WHOLE-KIND ONLY (decision 2026-09-07). Every prior-art system checked —
  // Salesforce Lightning page assignment, ServiceNow view rules, Dynamics
  // forms, VS Code editor associations, Notion, Backstage — stops layout
  // assignment at the class/kind and refuses a per-instance override; no
  // Synap caller needs one, and the legacy mirror this table replaces already
  // cannot express one. Refused here, at the one write door — before any DB
  // round trip — so a new caller can never reopen it by omission.
  if (subjectId !== null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Renderer bindings are whole-kind only — a per-object binding " +
        "(subjectId) is not supported. See renderer-bindings.ts.",
    });
  }

  // PLACES — `source-app` is user × profile-kind detail only. The ONE shared
  // rule (renderer-ref-scope.ts), before any DB round trip.
  assertRendererRefAllowedForScope(ref, scope, slot);

  const db = await getDb();
  const contentKind = SLOT_TO_CONTENT_KIND[slot] as
    "collection" | "entity-detail" | "entity-card" | "entity-profile";

  await assertMayBindRenderer({ userId, scope, workspaceId });

  // SURFACE ↔ RENDERER TYPE. An `mcp-app` cell serves outside AI hosts only; a
  // frame/iframe cell is an in-app React/ESM renderer. Handing either to the
  // other surface binds something that can never serve (the resolver returns
  // null for it), so refuse at the write, not at render. Only a cell ref is
  // typed; a view/declarative/source-app ref has no renderer type. A cleared
  // binding (`ref === null`) has nothing to check.
  if (ref !== null && ref.kind === "cell") {
    const rendererType = await lookupCellRendererType(db, ref, workspaceId);
    if (surface === "mcp-app" && rendererType !== "mcp-app") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `The 'mcp-app' surface needs an installed mcp-app cell; ` +
          (rendererType
            ? `'${ref.cellKey}' is a '${rendererType}' cell.`
            : `'${ref.cellKey}' is not an installed, active cell.`),
      });
    }
    if (surface === "app" && rendererType === "mcp-app") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `'${ref.cellKey}' is an mcp-app cell: it renders inside outside AI ` +
          `hosts only. Bind it with surface 'mcp-app'.`,
      });
    }
  }

  // Mirror the legacy stores ONLY for the shape they can express: an in-app,
  // whole-kind, workspace/pod binding of a PROFILE. A user-scoped or
  // per-object binding never mirrors; an `mcp-app` binding never mirrors (the
  // legacy stores are in-app readers — a mirror would serve an outside-host
  // cell in the browser); and a non-profile object kind (`proposal`, `run`, …)
  // has no profile row and no legacy key at all.
  const willMirrorLegacy =
    MIRROR_LEGACY_RENDERER_STORES &&
    scope !== "user" &&
    subjectId === null &&
    surface === "app" &&
    !isNonProfileObjectKind(profileSlug);

  // A pod default has no "cleared" state in the legacy store (the column and
  // the map both fall through to the hardcoded system fallback, which is a
  // different thing from "unset"). Refused for the kind-level pod write the
  // legacy store still answers; anything only the binding table holds (user,
  // per-object, `mcp-app`, a non-profile kind) is freely revocable.
  if (ref === null && scope === "pod" && willMirrorLegacy) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Pod-scoped profile renderer defaults cannot be cleared",
    });
  }
  if (scope === "workspace" && !workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "workspaceId is required for a workspace-scoped renderer",
    });
  }

  // ── 0. PREFLIGHT — every existence check, BEFORE the first write ─────────
  // The legacy mirror below resolves a profile row (pod scope) or a workspace
  // row (workspace scope) and throws NOT_FOUND when it is missing. Doing that
  // AFTER step 1 left a committed binding behind on a call that reported
  // failure: the caller saw NOT_FOUND, the pod had a new row, and a retry with
  // a corrected slug left the first one orphaned. Resolve both here so a failed
  // call writes nothing.
  //
  // Gated on `willMirrorLegacy` — the SAME condition step 2 uses. A binding
  // that never mirrors (user, per-object, `mcp-app`, or a non-profile kind
  // such as `proposal`) must not demand a profile row: that refused the very
  // pod-scope bindings the table exists for.
  const profileRepo = new ProfileRepository(db);
  const mirrorProfile =
    willMirrorLegacy && scope === "pod"
      ? await new ProfileResolutionService(db).resolveProfile(
          profileSlug,
          userId,
          workspaceId
        )
      : null;
  if (willMirrorLegacy && scope === "pod" && !mirrorProfile) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Profile '${profileSlug}' not found`,
    });
  }

  const mirrorWorkspace =
    willMirrorLegacy && scope === "workspace" && workspaceId
      ? await db.query.workspaces.findFirst({
          where: eq(workspaces.id, workspaceId),
        })
      : null;
  if (
    willMirrorLegacy &&
    scope === "workspace" &&
    workspaceId &&
    !mirrorWorkspace
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
  }

  // ── 1. The canonical store: renderer_bindings ────────────────────────────
  const bindingKey = {
    scopeKind: scope,
    userId: scope === "user" ? userId : null,
    workspaceId: scope === "workspace" ? workspaceId : null,
    subjectKind: profileSlug,
    subjectId,
    contentKind,
    surface,
  } as const;

  if (ref === null) {
    await revokeRendererBinding(db, { ...bindingKey, actorUserId: userId });
  } else {
    await setRendererBinding(db, {
      ...bindingKey,
      ref,
      sourceProposalId,
      actorUserId: userId,
    });
  }

  // ── 2. Legacy mirror (one release; see MIRROR_LEGACY_RENDERER_STORES) ─────
  // Skipped for every shape no legacy store can express (see above).
  if (!willMirrorLegacy) return;

  if (scope === "pod") {
    // System default: profiles.default_{list,detail,dashboard}_renderer.
    // `mirrorProfile` was resolved (and its absence refused) in the preflight.
    const profile = mirrorProfile!;
    const currentDefaultRenderers = (profile.defaultRenderers ?? {}) as Record<
      string,
      RendererRef | undefined
    >;
    const legacyColumn = LEGACY_COLUMN_BY_SLOT[slot];
    const patch = {
      ...(legacyColumn ? { [legacyColumn]: ref } : {}),
      defaultRenderers: { ...currentDefaultRenderers, [contentKind]: ref },
    };
    await profileRepo.update(profile.id, patch);
    return;
  }

  // Workspace overlay: workspaces.settings.profileRenderers[slug][contentKind].
  if (!workspaceId) return;
  // Shared singleton — a fresh EventRepository has no registered hooks, so
  // its emitCompleted() append would silently never reach the
  // realtime/materialization/sync hooks.
  const eventRepo = eventRepository;
  const workspaceRepo = new WorkspaceRepository(db, eventRepo);

  // Resolved (and its absence refused) in the preflight, before any write.
  const workspace = mirrorWorkspace!;

  const settings = (workspace.settings ?? {}) as Record<string, unknown>;
  const current = (settings.profileRenderers ?? {}) as Record<
    string,
    Record<string, RendererRef | undefined>
  >;
  const profileEntry = { ...(current[profileSlug] ?? {}) };
  if (ref === null) {
    delete profileEntry[contentKind];
  } else {
    profileEntry[contentKind] = ref;
  }
  const nextProfileRenderers: Record<
    string,
    Record<string, RendererRef | undefined>
  > = { ...current, [profileSlug]: profileEntry };

  if (Object.keys(profileEntry).length === 0) {
    delete nextProfileRenderers[profileSlug];
  }

  await workspaceRepo.mergeSettings(
    workspaceId,
    { profileRenderers: nextProfileRenderers },
    userId
  );
}
