/**
 * The `renderer_bundle_updates` row of a bundle: read, patched, and cleared
 * after an install. Shared by the update pass (`renderer-bundle-updates.ts`)
 * and every install door (`installOfficialRendererBundle`), so an install by
 * any door (an agent's approved proposal included) leaves no stale hold,
 * refusal or wait behind.
 */

import { getDb, eq } from "@synap/database";
import {
  rendererBundleUpdates,
  type RendererBundleUpdatesRow,
} from "@synap/database/schema";

export async function readRendererBundleUpdateRow(
  slug: string
): Promise<RendererBundleUpdatesRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(rendererBundleUpdates)
    .where(eq(rendererBundleUpdates.slug, slug))
    .limit(1);
  return row ?? null;
}

export type RendererBundleUpdatePatch = Partial<
  Omit<typeof rendererBundleUpdates.$inferInsert, "slug" | "updatedAt">
>;

/** Write part of a bundle's update row (created on its first write). */
export async function patchRendererBundleUpdateRow(
  slug: string,
  patch: RendererBundleUpdatePatch
): Promise<void> {
  const db = await getDb();
  const set = { ...patch, updatedAt: new Date() };
  await db
    .insert(rendererBundleUpdates)
    .values({ slug, ...set })
    .onConflictDoUpdate({ target: rendererBundleUpdates.slug, set });
}

export const NO_REFUSAL: RendererBundleUpdatePatch = {
  refusalCode: null,
  refusalMessage: null,
  refusedAt: null,
};
export const NO_HOLD: RendererBundleUpdatePatch = {
  holdVersion: null,
  holdReason: null,
  holdDetail: null,
  heldAt: null,
};
export const NOTHING_WAITS: RendererBundleUpdatePatch = {
  waitReason: null,
  applyAfter: null,
};

/** A version landed: nothing is held, refused or waiting any more. */
export async function clearAfterRendererBundleInstall(
  slug: string
): Promise<void> {
  await patchRendererBundleUpdateRow(slug, {
    ...NO_HOLD,
    ...NO_REFUSAL,
    ...NOTHING_WAITS,
  });
}
