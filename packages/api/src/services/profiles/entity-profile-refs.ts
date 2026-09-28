/**
 * `resolveEntityProfileRefs` — the KIND of each entity a list item points at,
 * so a card can name it ("Decision", "Person") instead of the generic object
 * kind ("Entity"). Shared by the outputs join (`session-outputs.ts`, which
 * feeds `focusSessions.outputs` AND `projects.outputs`) and the desk read
 * (`artifacts.list`).
 *
 * AUTHORIZATION IS THE CALLER'S: `rows` must be entity rows the caller has
 * already loaded through its own floor. This only reads the profile rows those
 * entities name — one batched query, none when no entity carries a profile id.
 */

import { db, profiles, inArray } from "@synap/database";

/** The identity a card needs: the kind slug, its display name, its icon. */
export interface EntityProfileRef {
  /** Profile slug (`entities.type` mirrors it when the profile row is absent). */
  slug: string;
  /** `profiles.display_name`, when the profile row was found. */
  displayName: string | null;
  /** `profiles.ui_hints.icon`, when set. */
  icon: string | null;
}

export async function resolveEntityProfileRefs(
  database: typeof db,
  rows: ReadonlyArray<{
    id: string;
    type: string | null;
    profileId: string | null;
  }>
): Promise<Map<string, EntityProfileRef>> {
  const out = new Map<string, EntityProfileRef>();
  const profileIds = [
    ...new Set(
      rows.map((r) => r.profileId).filter((id): id is string => Boolean(id))
    ),
  ];
  const profileRows = profileIds.length
    ? await database
        .select({
          id: profiles.id,
          slug: profiles.slug,
          displayName: profiles.displayName,
          uiHints: profiles.uiHints,
        })
        .from(profiles)
        .where(inArray(profiles.id, profileIds))
    : [];
  const byId = new Map(profileRows.map((p) => [p.id, p]));

  for (const r of rows) {
    const p = r.profileId ? byId.get(r.profileId) : undefined;
    const slug = p?.slug || r.type;
    if (!slug) continue;
    const icon = (p?.uiHints as { icon?: unknown } | null | undefined)?.icon;
    out.set(r.id, {
      slug,
      displayName: p?.displayName || null,
      icon: typeof icon === "string" && icon.trim() ? icon.trim() : null,
    });
  }
  return out;
}
