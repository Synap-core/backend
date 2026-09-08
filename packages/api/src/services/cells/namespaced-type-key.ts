/**
 * typeKey PROVENANCE FLOOR — one implementation, shared by every cell write
 * door that accepts a caller-supplied `typeKey`.
 *
 * `widget_definitions.type_key` takes three shapes, and two of them are a CLAIM
 * about where the row came from:
 *
 *   bare kebab        `win-rate-gauge`  — authored here (Cell Studio) / seeded
 *   `generated:<slug>`                  — minted by `defineCell` for an AI cell
 *   `cell:<pkg>:<key>`                  — minted by the package installer
 *                                         (`packageCellTypeKey`)
 *
 * Two SHIPPED surfaces read that prefix back as provenance: the browser's
 * "Made for you" lane treats `generated:` as AI-authored (`apps/made-for-you.ts`)
 * and the installed list parses `cell:<pkg>:` into a package slug it reports as
 * installed (`hub-protocol/rest/installed.ts`).
 *
 * THE RULE (identical at every door): a namespaced key may be UPDATED but never
 * MINTED by a door that is not its minter. Editing an existing row claims
 * nothing new — "install then tweak" must keep working — but CREATING one would
 * forge an origin. Forging `cell:<pkg>:<key>` is the sharper half: it lets a
 * write land on the row an INSTALLED vendor cell would occupy, and because
 * `defineCell` writes `rendererSource` unconditionally while it demotes
 * `trustLevel` only on an `externalHosts` CHANGE, swapped code would inherit the
 * vendor's approved `connect-src` grant AND its trust level.
 *
 * This module exists because the rule lived only inside the tRPC door
 * (`widget-definitions.upsert`) while the Hub REST door (`POST /cells/define`)
 * had no guard at all — a second implementation would have been a second place
 * to drift, so both now call THIS one.
 */

import { getDb, and, eq, isNull } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";

/** True for the two namespaces a general-purpose door may edit but never mint. */
export function isNamespacedTypeKey(typeKey: string): boolean {
  return typeKey.startsWith("generated:") || typeKey.startsWith("cell:");
}

/**
 * Thrown when a door tries to MINT a namespaced key. A distinct class so each
 * door can map it to its own client-error shape (tRPC `BAD_REQUEST`, HTTP 400)
 * instead of letting a caller error surface as a 500.
 */
export class NamespacedTypeKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamespacedTypeKeyError";
  }
}

/**
 * Assert a caller-supplied `typeKey` may be written at `workspaceId`.
 *
 * `workspaceId` is `string | null` — `null` means the POD-GLOBAL row
 * (`workspace_id IS NULL`), which is a real scope for this table and must be
 * matched with `IS NULL` rather than an equality that never holds.
 */
export async function assertMayWriteNamespacedTypeKey(
  typeKey: string,
  workspaceId: string | null
): Promise<void> {
  if (!isNamespacedTypeKey(typeKey)) return;
  const db = await getDb();
  const [existing] = await db
    .select({ id: widgetDefinitions.id })
    .from(widgetDefinitions)
    .where(
      and(
        eq(widgetDefinitions.typeKey, typeKey),
        workspaceId
          ? eq(widgetDefinitions.workspaceId, workspaceId)
          : isNull(widgetDefinitions.workspaceId)
      )
    )
    .limit(1);
  if (!existing) {
    throw new NamespacedTypeKeyError(
      `typeKey "${typeKey}" is namespaced, and no such cell exists in this ` +
        "scope. `generated:` keys are minted by the cell-define door " +
        "(synap_create_cell / POST /cells/define) and `cell:` keys by the " +
        "package installer — this door may edit them, not create them. Use a " +
        "kebab-case typeKey for a new cell."
    );
  }
}
