/**
 * What a host reads to draw pod content through the installed renderer
 * bundle (spec c9b1e4d0 §3c): `renderers.status`, `renderers.hostModules`
 * and their Hub REST mirror `GET /api/hub/renderers/host-modules`.
 *
 * The ACTIVE bundle is the one that holds the pod's host-module set (its
 * `react` module; one set per pod, `renderer_host_modules_one_set`).
 *
 * `installed` lists the frame and iframe cells the caller may read, without
 * their source (a cell's source stays on `widgetDefinitions.get`), with the
 * same filter as `GET /api/hub/cells` (`rest/cells.ts`): active rows, the
 * calling key's `widget` grant clause, pod-wide cells plus those of the
 * caller's space when one is in the lens.
 */

import { TRPCError } from "@trpc/server";
import { getDb, and, eq, inArray, isNull, or } from "@synap/database";
import {
  rendererBundles,
  rendererHostModules,
  widgetDefinitions,
  type RendererBundleDefaultsRow,
} from "@synap/database/schema";
import type { InstalledRenderer } from "@synap-core/types/renderer-resolution";
import { grantReadPredicate } from "../../access/grant-read.js";

/** Reason on the NOT_FOUND below (`error.data.reasonCode`). */
export const NO_RENDERER_BUNDLE = "NO_RENDERER_BUNDLE" as const;

export interface RendererStatus {
  bundle: {
    slug: string;
    version: string;
    setSha256: string;
    reactVersion: string;
  } | null;
  /** By the bundle's cell KEY; the cell is `cell:<bundle.slug>:<key>`. `{}` with no bundle. */
  defaults: RendererBundleDefaultsRow;
  installed: InstalledRenderer[];
}

export type RendererHostModulesRead =
  | { notModified: true; setSha256: string }
  | {
      notModified: false;
      setSha256: string;
      /** Module name (`react`, `reactDom`, …, `tokensCss`) → its source. */
      modules: Record<string, string>;
      kitExports: string[];
    };

async function activeBundle() {
  const db = await getDb();
  const [row] = await db
    .select({
      slug: rendererBundles.slug,
      version: rendererBundles.version,
      setSha256: rendererBundles.setSha256,
      reactVersion: rendererBundles.reactVersion,
      kitExports: rendererBundles.kitExports,
      defaults: rendererBundles.defaults,
    })
    .from(rendererBundles)
    .innerJoin(
      rendererHostModules,
      and(
        eq(rendererHostModules.bundleSlug, rendererBundles.slug),
        eq(rendererHostModules.module, "react")
      )
    )
    .limit(1);
  return row ?? null;
}

export async function readRendererStatus(input: {
  workspaceId: string | null;
}): Promise<RendererStatus> {
  const bundle = await activeBundle();
  const db = await getDb();
  const rows = await db
    .select({
      typeKey: widgetDefinitions.typeKey,
      rendererType: widgetDefinitions.rendererType,
      contentKind: widgetDefinitions.contentKind,
      viewTypes: widgetDefinitions.viewRendererViewTypes,
    })
    .from(widgetDefinitions)
    .where(
      and(
        inArray(widgetDefinitions.rendererType, ["frame", "iframe"]),
        eq(widgetDefinitions.isActive, true),
        grantReadPredicate(widgetDefinitions),
        input.workspaceId
          ? or(
              isNull(widgetDefinitions.workspaceId),
              eq(widgetDefinitions.workspaceId, input.workspaceId)
            )
          : isNull(widgetDefinitions.workspaceId)
      )
    )
    .orderBy(widgetDefinitions.typeKey);
  return {
    bundle: bundle
      ? {
          slug: bundle.slug,
          version: bundle.version,
          setSha256: bundle.setSha256,
          reactVersion: bundle.reactVersion,
        }
      : null,
    defaults: bundle?.defaults ?? {},
    installed: rows.map((r) => ({
      key: r.typeKey,
      // The one derivation (widget_definitions `viewRendererViewTypes` doc,
      // the browser's frame-cell registration): `frame` → frame, else direct.
      runtime:
        r.rendererType === "frame" ? ("frame" as const) : ("direct" as const),
      contentKind: r.contentKind ?? null,
      viewTypes: r.viewTypes ?? [],
    })),
  };
}

/** The active host-module set's sha256, or null when no bundle is installed. */
export async function readRendererSetSha256(): Promise<string | null> {
  return (await activeBundle())?.setSha256 ?? null;
}

export async function readRendererHostModules(input: {
  knownSetSha256?: string;
}): Promise<RendererHostModulesRead> {
  if (input.knownSetSha256) {
    const current = await readRendererSetSha256();
    if (current !== null && current === input.knownSetSha256) {
      return { notModified: true, setSha256: current };
    }
  }
  // ONE statement, so one snapshot: the set's sha256, its kit exports and its
  // modules always belong together, even while an install replaces the set.
  // One set per pod (`renderer_host_modules_one_set`): every row is the same
  // bundle's.
  const db = await getDb();
  const rows = await db
    .select({
      setSha256: rendererBundles.setSha256,
      kitExports: rendererBundles.kitExports,
      module: rendererHostModules.module,
      source: rendererHostModules.source,
    })
    .from(rendererHostModules)
    .innerJoin(
      rendererBundles,
      eq(rendererBundles.slug, rendererHostModules.bundleSlug)
    );
  const [first] = rows;
  if (!first) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No renderer bundle is installed on this pod.",
      cause: { reasonCode: NO_RENDERER_BUNDLE },
    });
  }
  return {
    notModified: false,
    setSha256: first.setSha256,
    modules: Object.fromEntries(rows.map((r) => [r.module, r.source])),
    kitExports: first.kitExports,
  };
}
