/**
 * Do not contact (founder, 2026-11-09): a flag ON THE PERSON, read by the send
 * door (`connectors/external-dispatch.ts` → `sendExternalMessage`), which
 * refuses any message to a flagged person, for every app and agent, before
 * anything is filed or sent, and again when an approved send replays (the flag
 * may have been set after it was filed).
 *
 * The flag is three properties the system `person` kind declares once
 * (`database/src/utils/ensure-system-profiles.ts`): `doNotContact` (boolean),
 * `doNotContactReason` (text), `doNotContactSince` (date). It is pod-scoped
 * (on the person, every role and space): a lead's stage can move to lost
 * separately, and does not set or clear it.
 *
 * The recipient is the person the conversation's channel is bound to
 * (`contextObjectType = 'entity'`, the one derivation `channelPersonId` uses).
 * A channel bound to nobody resolves no recipient and the door goes on as
 * before: this rule refuses a flagged person, it does not widen the door's
 * policy to refuse an unknown one.
 *
 * A failed READ is not "not flagged": it throws, and the send fails without
 * reaching the provider.
 */

import { and, db, eq, isNull } from "@synap/database";
import { entities } from "@synap/database/schema";
import { resolveDoNotContactRefusal } from "@synap-core/types/vocabulary";

export const DO_NOT_CONTACT_PROPERTY = "doNotContact";
export const DO_NOT_CONTACT_REASON_PROPERTY = "doNotContactReason";
export const DO_NOT_CONTACT_SINCE_PROPERTY = "doNotContactSince";

/** The channel shape the recipient is read from. */
export interface RecipientChannel {
  contextObjectType: string | null;
  contextObjectId: string | null;
}

/** A person marked do not contact. */
export interface DoNotContactFlag {
  personId: string;
  name: string | null;
  reason: string | null;
  since: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Is the flag set? `true`, or the string "true" a loose writer may have
 * stored: a consent flag reads closed on the values that mean yes.
 */
export function isDoNotContactSet(properties: unknown): boolean {
  if (!isRecord(properties)) return false;
  const v = properties[DO_NOT_CONTACT_PROPERTY];
  return v === true || (typeof v === "string" && v.trim() === "true");
}

/**
 * The flag of the person a channel is bound to, or null when the channel is
 * bound to no person, the person is gone, or the flag is not set.
 */
export async function readRecipientDoNotContact(
  channel: RecipientChannel | null | undefined
): Promise<DoNotContactFlag | null> {
  const personId =
    channel?.contextObjectType === "entity"
      ? (channel.contextObjectId ?? null)
      : null;
  if (!personId) return null;
  const person = await db.query.entities.findFirst({
    where: and(eq(entities.id, personId), isNull(entities.deletedAt)),
    columns: { title: true, properties: true },
  });
  if (!person || !isDoNotContactSet(person.properties)) return null;
  const props = person.properties as Record<string, unknown>;
  return {
    personId,
    name: text(person.title),
    reason: text(props[DO_NOT_CONTACT_REASON_PROPERTY]),
    since: text(props[DO_NOT_CONTACT_SINCE_PROPERTY]),
  };
}

/** The send door's refusal sentence for a flagged person. */
export function doNotContactRefusal(flag: DoNotContactFlag): string {
  return resolveDoNotContactRefusal({ name: flag.name, reason: flag.reason });
}
