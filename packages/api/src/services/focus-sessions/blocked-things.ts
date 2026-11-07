/**
 * THE THING A NEED-YOU CARD HOLDS UP (plan e7f753db §9): every owed slot on
 * a session about a thing (or naming one in `blocks.entityId`) says which
 * thing it blocks, the status it stands on and the status it cannot reach
 * until the person answers. Resolved here, for a whole page of slots, in one
 * entity read and one lifecycle read per profile — never per card.
 *
 * The thing is named only when the READER may read it (`thingStatusFloor`,
 * the statusOf floor): a slot on a session the reader owns may be about a
 * thing they cannot see, and the card then names nothing. The "status after"
 * is the ONE rule a board card's blocker unlocks (`thingBlockerUnlocks`).
 *
 * Its status is the thing's OWN lifecycle (its kind's). A role's status (a
 * lead on a person) is the flow board's lens (wave 2): this card names the
 * kind's.
 */
import { and, db, entities, inArray, ProfileResolutionService } from "@synap/database";
import { findLifecycleOption, lifecycleOptionLabel } from "@synap-core/types/lifecycle";
import { thingBlockerUnlocks } from "@synap-core/types/units";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import type { NeedsYouBlocks } from "@synap-core/types/needs-you";
import { isUuid } from "@synap-core/types/property-render";
import { thingStatusFloor } from "../status/status-floor.js";
import type { OwedSlot } from "./owed-outputs.js";

/** The thing a slot holds up: its declared `blocks.entityId`, else its session's subject. */
export function blockedThingIdOf(
  slot: Pick<OwedSlot, "blocks" | "subjectEntityId">
): string | null {
  const id = slot.blocks?.entityId ?? slot.subjectEntityId;
  return id && isUuid(id) ? id : null;
}

/**
 * Stamp {@link OwedSlot.blockedThing} on every slot that names a thing the
 * reader may read. THROWS on a failed read (the caller's read fails, as any
 * other part of the owed read would).
 */
export async function withBlockedThings(
  userId: string,
  slots: OwedSlot[]
): Promise<OwedSlot[]> {
  const ids = [
    ...new Set(slots.flatMap((s) => blockedThingIdOf(s) ?? [])),
  ];
  if (ids.length === 0) return slots;
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      status: entities.status,
      profileId: entities.profileId,
    })
    .from(entities)
    .where(and(inArray(entities.id, ids), thingStatusFloor(userId)));
  if (rows.length === 0) return slots;
  const lifecycles = await new ProfileResolutionService(
    db
  ).getEffectiveLifecycles([
    ...new Set(rows.flatMap((r) => (r.profileId ? [r.profileId] : []))),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return slots.map((s) => {
    const id = blockedThingIdOf(s);
    const row = id ? byId.get(id) : undefined;
    if (!row) return s;
    const lifecycle =
      (row.profileId ? lifecycles.get(row.profileId) : undefined) ?? null;
    const status = row.status ?? null;
    const option =
      lifecycle && status ? findLifecycleOption(lifecycle, status) : null;
    const next = thingBlockerUnlocks(lifecycle, status, s.blocks?.to);
    const blockedThing: NeedsYouBlocks = {
      thing: { id: row.id, name: row.title ?? null },
      statusNow: status
        ? {
            key: status,
            label: option
              ? lifecycleOptionLabel(option)
              : resolveStatusLabel(status),
          }
        : null,
      statusNext: next ? { key: next.to, label: next.label } : null,
    };
    return { ...s, blockedThing };
  });
}
