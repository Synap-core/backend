/**
 * A run's subject must BE of the playbook's subject kind.
 *
 * `subjectProfile.profileSlug` says what a playbook operates over ("post",
 * "lead"). Every run door accepted a caller-supplied `subjectId` without asking
 * whether it named that kind, so "Produce content" could be bound to a person
 * and every stage write (`subjectStatus`) would then land on the wrong entity.
 *
 * The rule: the entity's KIND slug — or one of its profile's ANCESTORS
 * (`parent_profile_id`, "webinar" extends "event") — or one of its LIVE FACET
 * slugs (a `person` wearing the `lead` role) equals `profileSlug`. WIDER than
 * the matcher (`playbooks.matchForEntity` reads kind + facets, not ancestors):
 * the matcher decides what to OFFER, this decides what a run may be bound to. Facets are read through the ONE facet
 * reader, under the canonical visibility lens, so a caller can only satisfy the
 * check with facets it can see.
 *
 * What this does NOT judge, deliberately:
 *  - a playbook with no `profileSlug` — no kind to check against;
 *  - a subject id that does not resolve to an entity — VISIBILITY is the run
 *    door's own floor (it refuses or drops an unseen subject), and reporting a
 *    "kind mismatch" for a row that is not there would be a false fact.
 *
 * ONE call site, in the `runPlaybook` spine (after the subject is resolved,
 * before a session is minted), so every door — tRPC `playbooks.run`, MCP
 * `synap_run_playbook`, the automation `playbook_run` step, the entity action
 * strip — is guarded by existing.
 */

import { TRPCError } from "@trpc/server";
import {
  getDb,
  entities,
  profiles,
  eq,
  loadFacetSlugsBatch,
} from "@synap/database";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { subjectProfileSlug } from "./pinned-subject.js";

/** Profile inheritance is shallow in practice; the walk is bounded anyway. */
const MAX_ANCESTOR_DEPTH = 8;

export const SUBJECT_KIND_MISMATCH = "SUBJECT_KIND_MISMATCH" as const;

/** The refusal in the person's words: object nouns, never raw slugs. PURE. */
export function subjectKindMismatchMessage(
  expected: string,
  actual: string[]
): string {
  const template = resolveObjectNoun("playbook");
  const want = resolveObjectNoun(expected).toLowerCase();
  const got = actual.map((a) => resolveObjectNoun(a).toLowerCase());
  const is =
    got.length > 0
      ? `a ${got[0]}${got.length > 1 ? ` (also: ${got.slice(1).join(", ")})` : ""}`
      : "of no known kind";
  return `This ${template.toLowerCase()} runs on a ${want}, but the subject you chose is ${is}. Pick a ${want}, or run a ${template.toLowerCase()} made for this kind.`;
}

/** Typed refusal: the subject is not of the playbook's kind. A BAD_REQUEST. */
export class SubjectKindMismatchError extends TRPCError {
  readonly reasonCode = SUBJECT_KIND_MISMATCH;
  readonly expected: string;
  readonly actual: string[];
  readonly subjectId: string;
  constructor(input: {
    expected: string;
    actual: string[];
    subjectId: string;
  }) {
    super({
      code: "BAD_REQUEST",
      message: subjectKindMismatchMessage(input.expected, input.actual),
    });
    this.name = "SubjectKindMismatchError";
    this.expected = input.expected;
    this.actual = input.actual;
    this.subjectId = input.subjectId;
  }
}

/**
 * Every slug the entity counts as: its kind, the kind's ancestors, and its live
 * facet roles visible to `userId` in `workspaceId`. `null` when the entity does
 * not exist (see the header — not judged here).
 */
export async function subjectKindSlugs(input: {
  subjectId: string;
  userId: string;
  workspaceId: string | null;
}): Promise<string[] | null> {
  const db = await getDb();
  const [entity] = await db
    .select({ type: entities.type, profileId: entities.profileId })
    .from(entities)
    .where(eq(entities.id, input.subjectId))
    .limit(1);
  if (!entity) return null;

  const slugs: string[] = [];
  const push = (s: string | null | undefined) => {
    if (s && !slugs.includes(s)) slugs.push(s);
  };
  push(entity.type);

  // The kind's ancestors — "webinar" extends "event" runs an event playbook.
  let profileId = entity.profileId ?? null;
  for (let depth = 0; profileId && depth < MAX_ANCESTOR_DEPTH; depth++) {
    const [p] = await db
      .select({
        slug: profiles.slug,
        parentProfileId: profiles.parentProfileId,
      })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);
    if (!p) break;
    push(p.slug);
    profileId = p.parentProfileId ?? null;
  }

  const facets = await loadFacetSlugsBatch(db, [input.subjectId], {
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  for (const s of facets.get(input.subjectId) ?? []) push(s);
  return slugs;
}

/**
 * Refuse a run whose explicit subject is not of the playbook's subject kind.
 * Resolves silently when there is nothing to judge (no subject, no kind on the
 * playbook, no such entity) — see the header.
 */
export async function assertRunSubjectMatchesPlaybook(input: {
  subjectId: string | null | undefined;
  subjectProfile: unknown;
  userId: string;
  workspaceId: string | null;
}): Promise<void> {
  const subjectId =
    typeof input.subjectId === "string" ? input.subjectId.trim() : "";
  if (!subjectId) return;
  const expected = subjectProfileSlug(input.subjectProfile);
  if (!expected) return;
  const slugs = await subjectKindSlugs({
    subjectId,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  if (slugs === null) return;
  if (slugs.includes(expected)) return;
  throw new SubjectKindMismatchError({ expected, actual: slugs, subjectId });
}
