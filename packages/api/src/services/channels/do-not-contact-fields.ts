/**
 * The do-not-contact flag's fields and the pure reads of a write that touches
 * them (no database): the gate (`utils/permission-check.ts`) and the entity
 * update door (`routers/entities/mutate.ts`) read them, and
 * `do-not-contact.ts` (the send door's read) re-exports them. The rule itself
 * is documented there.
 */

export const DO_NOT_CONTACT_PROPERTY = "doNotContact";
export const DO_NOT_CONTACT_REASON_PROPERTY = "doNotContactReason";
export const DO_NOT_CONTACT_SINCE_PROPERTY = "doNotContactSince";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Is the flag set? `true`, or the string "true" a loose writer may have
 * stored: a consent flag reads closed on the values that mean yes.
 */
export function isDoNotContactSet(properties: unknown): boolean {
  if (!isRecord(properties)) return false;
  const v = properties[DO_NOT_CONTACT_PROPERTY];
  return v === true || (typeof v === "string" && v.trim() === "true");
}

/** The three properties of the flag, in the order the person kind declares them. */
export const DO_NOT_CONTACT_FIELDS: readonly string[] = [
  DO_NOT_CONTACT_PROPERTY,
  DO_NOT_CONTACT_REASON_PROPERTY,
  DO_NOT_CONTACT_SINCE_PROPERTY,
];

/**
 * The keys of an entity update that do not change what is written (the
 * record, who asks, why, how it is grouped or shown). Any other key set takes
 * a write out of "sets the flag only".
 */
const SET_NEUTRAL_KEYS = new Set([
  "id",
  "properties",
  "source",
  "reasoning",
  "agentUserId",
  "batchId",
  "viewContext",
  "forcePropose",
]);

/**
 * Does this entity update ONLY SET the flag? `properties` carries
 * `doNotContact: true` (and at most its reason and date), and no other key
 * of the write is set (no title, body, kind, home, status move, deletion).
 *
 * Setting the flag only REDUCES what the pod does (the send door then refuses
 * every message to that person), so it is a DE-ESCALATION, like pausing an
 * automation (CNIL: an opt-out recorded in an app holds at once; a default
 * the founder may override, session 6ade1f9d): the gate applies it instead of
 * proposing it
 * (`utils/permission-check.ts`), and a pod app reaches a pod-wide person
 * through a role in its space to set it (`utils/reach-field-grant.ts`).
 * Clearing it is never this: see {@link clearsDoNotContact}.
 */
export function isDoNotContactSetWrite(write: unknown): boolean {
  if (!isRecord(write)) return false;
  const properties = write.properties;
  if (!isRecord(properties)) return false;
  if (properties[DO_NOT_CONTACT_PROPERTY] !== true) return false;
  if (!Object.keys(properties).every((k) => DO_NOT_CONTACT_FIELDS.includes(k)))
    return false;
  return Object.entries(write).every(
    ([k, v]) => v === undefined || SET_NEUTRAL_KEYS.has(k)
  );
}

/**
 * Does this entity update CLEAR the flag, or remove its reason or date? A
 * `doNotContact` written to anything but yes, or any of the three removed.
 * Lifting an opt-out is the person's alone: an app or an agent asking for it
 * files a proposal the person approves (`routers/entities/mutate.ts`).
 */
export function clearsDoNotContact(write: {
  properties?: unknown;
  deleteProperties?: readonly string[] | null;
}): boolean {
  if (write.deleteProperties?.some((k) => DO_NOT_CONTACT_FIELDS.includes(k)))
    return true;
  return (
    isRecord(write.properties) &&
    DO_NOT_CONTACT_PROPERTY in write.properties &&
    !isDoNotContactSet(write.properties)
  );
}
