/**
 * ensureCoreRenderers — every pod gets the first-party MCP-Apps renderers.
 *
 * Outside AI hosts (Claude, ChatGPT) render Synap objects inline through
 * `ui://synap/*` resources, served from the `mcp-app` renderer-binding ladder
 * (`routers/mcp/ui-tools.ts` → `resolveSurfaceRenderer`). A pod with no bound
 * `mcp-app` cell serves no UI at all. This boot reconciler closes that gap for
 * the pinned core list below — founder decision: automatic, no per-pod human
 * approval, because a core renderer declares no external hosts.
 *
 * ONE catalog, ONE install door. The cell is read from the pod's catalog mirror
 * (`cp_catalog_cache`, filled by `cp-catalog-sync`) and installed through
 * `applyMarketInstall` — the same door `market.install` uses. Never inline
 * source, never read from disk, never a second registry.
 *
 * CONVERGENCE (backend-rules "Template→installed convergence"):
 *   - The ONLY marker is the installed row's own `widget_definitions.version`,
 *     written by the install itself from the catalog row it installed. There is
 *     no separate "done" flag, so nothing can claim a convergence the install
 *     did not perform.
 *   - The comparator is VERSION ONLY (`isTemplateDrifted`, the pod's one
 *     installed-vs-catalog version rule). It asserts nothing about the cell's
 *     content: a republish that keeps its version is not picked up. That is
 *     honest under-convergence, not a stamped lie.
 *   - A catalog row with NO version (a CP whose cells endpoint sends no
 *     `packageVersion`, so `cp-catalog-sync` stores NULL) can only answer "is
 *     it installed?". The cell is installed when missing and never
 *     re-installed; logged so the gap is visible.
 *   - Absent from the catalog ⇒ skipped at info, retried next boot. Nothing
 *     is written.
 *
 * ADMIN CHOICES WIN. A pod-scope `mcp-app` binding for the subject that ever
 * existed — active or revoked — is a pod admin's decision (rebind elsewhere, or
 * unbind); the binding is created only when there is no such history at all,
 * the same "never re-seed what a person revoked" rule as
 * `ensureSessionNarrativeRule`. A deactivated (`is_active = false`) core cell
 * is likewise left alone. User and workspace bindings are never read or
 * touched.
 *
 * ACTOR: the pod owner (`resolvePodOwnerUserId`), exactly as
 * `ensureSynapCoreCapability` attributes its seed. A boot path is not an
 * agent: no acting-agent scope, so `checkPermissionOrPropose` is not involved
 * (same precedent). `setProfileRenderer` still runs its pod-admin floor
 * against that owner. Pre-bootstrap pods (no owner) are skipped and retried.
 *
 * Errors PROPAGATE: a failed read is not an empty catalog. The startup hook
 * wraps the call, non-fatal and logged, like every other boot ensurer.
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, isNull } from "@synap/database";
import { rendererBindings, widgetDefinitions } from "@synap/database/schema";

import { TOOL_UI_SUBJECT } from "../../routers/mcp/ui-tools.js";
import {
  lookupCatalogEntry,
  applyMarketInstall,
} from "../capabilities/marketplace-install.js";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";
import { setProfileRenderer } from "../profiles/set-profile-renderer.js";
import {
  RENDERER_SLOTS,
  SLOT_TO_CONTENT_KIND,
  type RendererContentKind,
  type RendererSlot,
} from "../profiles/renderer-slots.js";
import { isTemplateDrifted } from "../template-health.js";
import { packageCellTypeKey } from "./install-cell-from-definition.js";

const logger = createLogger({ module: "ensure-core-renderers" });

export interface CoreMcpRenderer {
  /** Catalog package slug that owns the cell. */
  slug: string;
  /** Cell key within the package. */
  cellKey: string;
  /** Object kind the binding renders. */
  subjectKind: string;
  /** Binding content kind — read from `TOOL_UI_SUBJECT`, never spelled here. */
  contentKind: RendererContentKind;
}

const PROPOSAL_UI = TOOL_UI_SUBJECT.synap_get_proposal!;

/** The pinned first-party MCP-Apps renderers every pod converges to. */
export const CORE_MCP_RENDERERS: readonly CoreMcpRenderer[] = [
  {
    slug: "synap-mcp-renderers",
    cellKey: "proposal-card",
    subjectKind: PROPOSAL_UI.subjectKind,
    contentKind: PROPOSAL_UI.contentKind,
  },
];

export type CoreRendererOutcome =
  "not-in-catalog" | "installed" | "reinstalled" | "up-to-date" | "deactivated";

export interface CoreRendererResult {
  slug: string;
  cellKey: string;
  install: CoreRendererOutcome;
  binding: "created" | "kept" | "skipped";
}

/** The binding door takes a slot; invert the ONE slot → content-kind table. */
function slotFor(contentKind: RendererContentKind): RendererSlot {
  const slot = RENDERER_SLOTS.find(
    (s) => SLOT_TO_CONTENT_KIND[s] === contentKind
  );
  if (!slot) throw new Error(`No renderer slot maps to "${contentKind}"`);
  return slot;
}

export async function ensureCoreRenderers(
  renderers: readonly CoreMcpRenderer[] = CORE_MCP_RENDERERS
): Promise<CoreRendererResult[] | null> {
  const ownerUserId = await resolvePodOwnerUserId();
  if (!ownerUserId) {
    logger.info(
      "No pod owner yet (pre-bootstrap) — deferring core renderers to a later boot"
    );
    return null;
  }
  const results: CoreRendererResult[] = [];
  for (const renderer of renderers) {
    results.push(await ensureOne(renderer, ownerUserId));
  }
  return results;
}

async function ensureOne(
  renderer: CoreMcpRenderer,
  ownerUserId: string
): Promise<CoreRendererResult> {
  const { slug, cellKey } = renderer;
  // Catalog cell slugs are `<package>/<key>` (cp-catalog-sync).
  const catalogSlug = `${slug}/${cellKey}`;
  const typeKey = packageCellTypeKey(slug, cellKey);

  const entry = await lookupCatalogEntry("cell", catalogSlug);
  if (!entry) {
    logger.info(
      { catalogSlug },
      "Core renderer not in the catalog yet — skipping (retried next boot)"
    );
    return { slug, cellKey, install: "not-in-catalog", binding: "skipped" };
  }

  const [installed] = await db
    .select({
      version: widgetDefinitions.version,
      isActive: widgetDefinitions.isActive,
    })
    .from(widgetDefinitions)
    .where(
      and(
        eq(widgetDefinitions.typeKey, typeKey),
        isNull(widgetDefinitions.workspaceId)
      )
    )
    .limit(1);

  if (installed && !installed.isActive) {
    logger.info(
      { typeKey },
      "Core renderer was deactivated on this pod — leaving it alone"
    );
    return { slug, cellKey, install: "deactivated", binding: "skipped" };
  }

  let install: CoreRendererOutcome = "up-to-date";
  if (
    !installed ||
    isTemplateDrifted(installed.version ?? null, entry.version)
  ) {
    await applyMarketInstall({
      kind: "cell",
      slug: catalogSlug,
      version: entry.version,
      userId: ownerUserId,
      workspaceId: null,
    });
    install = installed ? "reinstalled" : "installed";
  } else if (!entry.version) {
    logger.info(
      { catalogSlug },
      "Core renderer catalog row has no version — installed copy cannot be checked for updates"
    );
  }

  return {
    slug,
    cellKey,
    install,
    binding: await ensurePodBinding(renderer, typeKey, ownerUserId),
  };
}

async function ensurePodBinding(
  renderer: CoreMcpRenderer,
  typeKey: string,
  ownerUserId: string
): Promise<"created" | "kept"> {
  // ANY history counts — an active row elsewhere is a rebind, a revoked row
  // with nothing newer is an unbind. Both are a pod admin's choice.
  const [existing] = await db
    .select({ id: rendererBindings.id })
    .from(rendererBindings)
    .where(
      and(
        eq(rendererBindings.scopeKind, "pod"),
        eq(rendererBindings.subjectKind, renderer.subjectKind),
        isNull(rendererBindings.subjectId),
        eq(rendererBindings.contentKind, renderer.contentKind),
        eq(rendererBindings.surface, "mcp-app")
      )
    )
    .limit(1);
  if (existing) return "kept";

  await setProfileRenderer({
    userId: ownerUserId,
    workspaceId: null,
    profileSlug: renderer.subjectKind,
    slot: slotFor(renderer.contentKind),
    ref: { kind: "cell", cellKey: typeKey, props: {} },
    scope: "pod",
    surface: "mcp-app",
  });
  return "created";
}
