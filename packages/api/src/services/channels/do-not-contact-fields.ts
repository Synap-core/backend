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

/** The flag's evidence: why and since when the person opted out. */
const DO_NOT_CONTACT_EVIDENCE: readonly string[] = [
  DO_NOT_CONTACT_REASON_PROPERTY,
  DO_NOT_CONTACT_SINCE_PROPERTY,
];

/**
 * Does this write REMOVE a piece of the evidence? Its reason or date written
 * as anything but a non-empty string (null, blank, a value that is not text)
 * erases what was recorded: a removal, never part of a set.
 */
function removesEvidence(properties: Record<string, unknown>): boolean {
  return DO_NOT_CONTACT_EVIDENCE.some((k) => {
    if (!(k in properties)) return false;
    const value = properties[k];
    return !(typeof value === "string" && value.trim() !== "");
  });
}

/**
 * Does this entity update ONLY SET the flag? `properties` carries
 * `doNotContact: true` (and at most its reason and date, each a non-empty
 * string), and no other key of the write is set (no title, body, kind, home,
 * status move, deletion).
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
  // A null or blank reason or date would erase the recorded evidence while
  // the flag stays on (ticket 85a8f115): a removal, the person's alone.
  if (removesEvidence(properties)) return false;
  return Object.entries(write).every(
    ([k, v]) => v === undefined || SET_NEUTRAL_KEYS.has(k)
  );
}

/**
 * Does this entity update CLEAR the flag, or remove its reason or date? A
 * `doNotContact` written to anything but yes, any of the three deleted, or
 * the reason or date written empty (null or blank).
 * Lifting an opt-out is the person's alone: an app or an agent asking for it
 * files a proposal the person approves (`routers/entities/mutate.ts`).
 */
export function clearsDoNotContact(write: {
  properties?: unknown;
  deleteProperties?: readonly string[] | null;
}): boolean {
  if (write.deleteProperties?.some((k) => DO_NOT_CONTACT_FIELDS.includes(k)))
    return true;
  if (!isRecord(write.properties)) return false;
  if (removesEvidence(write.properties)) return true;
  return (
    DO_NOT_CONTACT_PROPERTY in write.properties &&
    !isDoNotContactSet(write.properties)
  );
}

/**
 * Does this write REPLACE the evidence of an opt-out already in force? The
 * person is flagged (`existing`), a reason or date is recorded there, and the
 * write sets it to another non-empty value (founder, 21 Nov 2026, finding
 * 6d7af9b9). An app may do it, but only through the person's approval
 * (`routers/entities/mutate.ts`). Setting a reason or date the first time,
 * re-setting the same value, or a new opt-out on a person not flagged now
 * stays direct; erasing one is {@link clearsDoNotContact}.
 */
export function replacesDoNotContactEvidence(
  existing: unknown,
  write: { properties?: unknown }
): boolean {
  if (!isDoNotContactSet(existing) || !isRecord(existing)) return false;
  const properties = write.properties;
  if (!isRecord(properties)) return false;
  return DO_NOT_CONTACT_EVIDENCE.some((k) => {
    const before = existing[k];
    const after = properties[k];
    return (
      typeof before === "string" &&
      before.trim() !== "" &&
      typeof after === "string" &&
      after.trim() !== "" &&
      after.trim() !== before.trim()
    );
  });
}
