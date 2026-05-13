/**
 * Matches calendar event attendees and email senders to existing person entities
 * after a connector sync. Runs as a post-sync step — never called during sync.
 *
 * For each synced event/note entity:
 * - Matched attendees: first match stored as `relatedContactId` in properties
 * - Unmatched attendees: stored as `unmatchedAttendees[]` for review inbox
 */

import { sql as drizzleSql } from "drizzle-orm";
import { getDb, eq } from "@synap/database";
import { entities } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "connector-matching" });

export async function matchAttendeesToContacts(
  workspaceId: string,
  syncedEntityIds: string[]
): Promise<void> {
  if (syncedEntityIds.length === 0) return;

  const database = await getDb();

  // Fetch only the synced entities that are events or notes
  const synced = await database.query.entities.findMany({
    where: (e, { and, inArray }) =>
      and(eq(e.workspaceId, workspaceId), inArray(e.id, syncedEntityIds)),
    columns: { id: true, type: true, properties: true },
  });

  const targets = synced.filter((e) => e.type === "event" || e.type === "note");
  if (targets.length === 0) return;

  // Collect all emails that need matching
  const allEmails = new Set<string>();
  for (const entity of targets) {
    const props = (entity.properties ?? {}) as Record<string, unknown>;
    const attendees = props.attendees;
    if (Array.isArray(attendees)) {
      for (const a of attendees) {
        if (typeof a === "string" && a) allEmails.add(a.toLowerCase());
      }
    }
    const fromEmail = props.fromEmail;
    if (typeof fromEmail === "string" && fromEmail) {
      allEmails.add(fromEmail.toLowerCase());
    }
  }

  if (allEmails.size === 0) return;

  // Fetch all person entities with an email in this workspace
  const persons = await database.query.entities.findMany({
    where: (e, { and }) =>
      and(eq(e.workspaceId, workspaceId), eq(e.type, "person")),
    columns: { id: true, properties: true },
  });

  // Build email → contactId lookup
  const emailToId = new Map<string, string>();
  for (const person of persons) {
    const email = ((person.properties ?? {}) as Record<string, unknown>).email;
    if (typeof email === "string" && email) {
      emailToId.set(email.toLowerCase(), person.id);
    }
  }

  // Update each event/note with matched and unmatched attendees
  for (const entity of targets) {
    const props = (entity.properties ?? {}) as Record<string, unknown>;

    const emailsToCheck: string[] = [
      ...(Array.isArray(props.attendees)
        ? props.attendees.filter((a): a is string => typeof a === "string")
        : []),
      ...(typeof props.fromEmail === "string" && props.fromEmail
        ? [props.fromEmail]
        : []),
    ];

    let relatedContactId: string | null = null;
    const unmatched: string[] = [];

    for (const email of emailsToCheck) {
      const contactId = emailToId.get(email.toLowerCase());
      if (contactId) {
        if (!relatedContactId) relatedContactId = contactId;
      } else {
        unmatched.push(email);
      }
    }

    // Only write back if there's something new to add
    if (!relatedContactId && unmatched.length === 0) continue;

    const updated = {
      ...props,
      ...(relatedContactId ? { relatedContactId } : {}),
      ...(unmatched.length > 0 ? { unmatchedAttendees: unmatched } : {}),
    };

    try {
      await database
        .update(entities)
        .set({
          properties: drizzleSql`${JSON.stringify(updated)}::jsonb`,
        })
        .where(eq(entities.id, entity.id));
    } catch (err) {
      logger.warn(
        { err, entityId: entity.id },
        "Failed to update entity with attendee match"
      );
    }
  }

  logger.info(
    { workspaceId, processed: targets.length },
    "Attendee matching complete"
  );
}
