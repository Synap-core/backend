/**
 * Resolving "on these things" from a door's input — the async half (a slug
 * lookup through the board's rule). The predicates live in
 * `session-subject-where.ts`.
 */
import { z } from "zod";
import { db } from "@synap/database";
import { assertKnownProfileSlug } from "../../utils/assert-known-profile-slug.js";
import type { SessionSubject, ThingsLens } from "./session-subject-where.js";

export type { SessionSubject, ThingsLens } from "./session-subject-where.js";
export {
  sessionSubjectWhere,
  proposalOnThingsWhere,
} from "./session-subject-where.js";

/** The wire shape every door takes: a profile slug OR explicit entity ids. */
export const sessionSubjectInputSchema = z.union([
  z.object({ profileSlug: z.string().min(1) }).strict(),
  z.object({ entityIds: z.array(z.string().uuid()).min(1).max(200) }).strict(),
]);
export type SessionSubjectInput = z.infer<typeof sessionSubjectInputSchema>;

/**
 * Resolve a door's subject input. An unknown slug THROWS (NOT_FOUND via
 * `assertKnownProfileSlug`) — "no such vocabulary" is not "no sessions".
 */
export async function resolveSessionSubject(
  input: SessionSubjectInput
): Promise<SessionSubject> {
  if ("entityIds" in input) {
    return { kind: "entities", entityIds: [...new Set(input.entityIds)] };
  }
  const rows = await assertKnownProfileSlug(db, input.profileSlug);
  // Lazy: the board's module pulls the entity read helpers, which the
  // proposal and signal doors importing this file never otherwise load.
  const { statusSubjectOfRows } =
    await import("../../routers/entities/status-groups.js");
  const { subject } = statusSubjectOfRows(input.profileSlug, rows);
  return { kind: subject.kind, profileIds: subject.profileIds };
}

/** Resolve a `profileSlug` door input into the lens the proposal predicate reads. */
export async function resolveThingsLens(
  profileSlug: string
): Promise<ThingsLens> {
  return {
    subject: await resolveSessionSubject({ profileSlug }),
    profileSlug,
  };
}
