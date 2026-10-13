/**
 * The CARD FACE of the things on a board (surfaces WP.9): what the pipeline
 * card needs to draw the kind card model's two slots — the visual (an avatar
 * for a person / lead, a date block for an event) and ONE field — namely the
 * thing's kind and its properties. Opt-in on `lifecycle.board({ card: true })`
 * (the `workedBy` pattern): ONE batched read for the page, never a per-card
 * fetch. The ids come from the board's own visibility-filtered read, so this
 * reads nothing the board did not already show.
 */
import { db, entities, profiles, eq, inArray } from "@synap/database";

export interface BoardCardFace {
  /** The thing's own kind (a role board holds things of several kinds). */
  profileSlug: string | null;
  properties: Record<string, unknown>;
}

export async function loadCardFaces(
  ids: readonly string[]
): Promise<Map<string, BoardCardFace>> {
  const out = new Map<string, BoardCardFace>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: entities.id,
      type: entities.type,
      slug: profiles.slug,
      properties: entities.properties,
    })
    .from(entities)
    .leftJoin(profiles, eq(profiles.id, entities.profileId))
    .where(inArray(entities.id, [...ids]));
  for (const r of rows) {
    const props =
      r.properties &&
      typeof r.properties === "object" &&
      !Array.isArray(r.properties)
        ? (r.properties as Record<string, unknown>)
        : {};
    out.set(r.id, { profileSlug: r.slug ?? r.type ?? null, properties: props });
  }
  return out;
}
