/**
 * An agent's work belongs to the person it works for. A row an agent created
 * (`createdBy` = the agent user) is that person's row: the person can edit,
 * activate, pause or archive it (finding 50fd3e65, 2026-11-07: the founder
 * could not switch on two pod-wide automations their own agent proposed and
 * they approved).
 *
 * The person behind an agent is `users.createdByUserId` of a `userType =
 * 'agent'` row, the same reading the governance doors use
 * (`loadAgentOwner`, `governance-rules.ts`). This file is the one place that
 * turns "a row's owner" into "the person it stands for", so the write gate and
 * the automation run check cannot read it two ways.
 *
 * Two facts, two questions. `users.createdByUserId` is ACCOUNTABILITY (who
 * answers for the agent's rows; the readings above). `api_keys.linkedUserId` is
 * ACTING-FOR (whose person the agent's calls run as; {@link agentsActingFor}).
 * A pod-wide agent that serves every member (the Capture agent, the
 * Intelligence Service personas, a `podWide` key) is accountable to the person
 * who installed it but acts for nobody in particular.
 */
import { and, eq, inArray } from "drizzle-orm";
import { apiKeys, users } from "../schema/index.js";

type OwnerRow = {
  id: string;
  userType: string;
  createdByUserId: string | null;
};

/** The ONE reading of a users row as the person it stands for. */
function personOfRow(row: OwnerRow): string | null {
  return row.userType === "agent" ? (row.createdByUserId ?? null) : row.id;
}

/**
 * The person an owner id stands for:
 *  - a human user → itself;
 *  - an agent user → the human who created it, or `null` when nobody owns it;
 *  - no users row (a system owner) → `undefined`.
 *
 * A FAILED read throws; it never reads as "no person".
 */
export async function personOfOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  ownerId: string
): Promise<string | null | undefined> {
  const [owner] = (await database
    .select({
      id: users.id,
      userType: users.userType,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1)) as OwnerRow[];
  if (!owner) return undefined;
  return personOfRow(owner);
}

/**
 * {@link personOfOwner} for many owner ids in ONE read. An id with no users row
 * is absent from the map (a system owner: `undefined`, as above).
 */
export async function personsOfOwners(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  ownerIds: readonly string[]
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = Array.from(new Set(ownerIds));
  if (ids.length === 0) return out;
  const rows = (await database
    .select({
      id: users.id,
      userType: users.userType,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    .where(inArray(users.id, ids))) as OwnerRow[];
  for (const row of rows) out.set(row.id, personOfRow(row));
  return out;
}

/**
 * Every user id that acts AS the same person as `actorId`: that person and each
 * agent they own (decision 782c862e: "agent-created automations fire on your
 * events too"). An agent acting for person P counts as P, so an event recorded
 * by any of these ids is P's event, and a row any of them owns is P's row.
 *
 * When `actorId` stands for no person (a system id, or an agent nobody owns),
 * the answer is `[actorId]` alone: nothing to widen to. Two reads at most,
 * never one per automation. A FAILED read throws.
 */
export async function actorsOfSamePerson(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  actorId: string
): Promise<string[]> {
  const person = await personOfOwner(database, actorId);
  if (!person) return [actorId];
  const agents = (await database
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.userType, "agent"), eq(users.createdByUserId, person))
    )) as Array<{ id: string }>;
  return Array.from(new Set([person, actorId, ...agents.map((a) => a.id)]));
}

/**
 * The agents that act FOR `personId`: every `userType = 'agent'` user holding
 * an api key whose `linkedUserId` is that person (a surface agent's
 * `hub_inbound` key, an app's or a computer's `user_pat`; revoked keys count,
 * so a re-minted key for the same agent cannot revive what was taken away).
 * An agent with no key linked to a person (the Capture agent, an Intelligence
 * Service persona, a `podWide` key) acts for nobody and is never in this set.
 * One read. A FAILED read throws.
 */
export async function agentsActingFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  personId: string
): Promise<string[]> {
  const rows = (await database
    .selectDistinct({ id: users.id })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(
      and(eq(users.userType, "agent"), eq(apiKeys.linkedUserId, personId))
    )) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
