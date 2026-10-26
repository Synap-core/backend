/**
 * SUBJECT REF — a start door names what the work is ABOUT by an identity it
 * holds (a URL, a provider-scoped external id) instead of an entity id.
 *
 * A session's work type is the kind of its subject (founder decision 2 A,
 * 2026-10-26). A start door attaches a subject only when it KNOWS it:
 *   - a ref is resolved through the ONE identity door (`resolveIdentity`, strong
 *     atoms only, mapped by the ONE explicit mapper `signalsFromExplicit`). A
 *     strong hit the caller can see becomes the subject. A hit the caller
 *     cannot see reads exactly like no hit: the answer must not become an
 *     oracle over who owns an identity.
 *   - a same-name entity is WEAK: never attached, only returned as
 *     candidates (kinds that declare a lifecycle, through the one lifecycle
 *     reader) for the caller to confirm with `subjectEntityId`.
 *
 * Nothing here creates an entity: an issue, feature or task is made through
 * the doors that already resolve identity first (create_entity, capture).
 */
import {
  db,
  entities,
  inArray,
  ProfileResolutionService,
  resolveIdentity,
  signalsFromExplicit,
} from "@synap/database";
import { accessScopeWhere } from "../../utils/project-scope.js";
import { isOutputRefVisible } from "./assert-output-ref-visible.js";

export interface SubjectRef {
  url?: string | null;
  externalId?: string | null;
}

export type SubjectRefKey = keyof SubjectRef;

export type SubjectRefResolution =
  | { status: "resolved"; entityId: string }
  | { status: "unresolved"; tried: SubjectRefKey[] };

export interface SubjectCandidate {
  id: string;
  kind: string;
  title: string | null;
}

/** The ref keys that carry a value. Pure. */
export function subjectRefKeys(ref: SubjectRef): SubjectRefKey[] {
  return (["url", "externalId"] as const).filter((k) => {
    const v = ref[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/** Resolve a ref to the one entity it names, if the caller can see it. */
export async function resolveSubjectRef(
  userId: string,
  ref: SubjectRef
): Promise<SubjectRefResolution> {
  const tried = subjectRefKeys(ref);
  const signals = signalsFromExplicit(
    Object.fromEntries(tried.map((k) => [k, ref[k]]))
  );
  if (signals.length === 0) return { status: "unresolved", tried };
  // No `userScope`: only the strong (globally unique) path runs.
  const identity = await resolveIdentity(db, { userId, signals });
  const id = identity.match === "strong" ? identity.entity?.id : undefined;
  if (id && (await isOutputRefVisible({ userId, kind: "entity", refId: id }))) {
    return { status: "resolved", entityId: id };
  }
  return { status: "unresolved", tried };
}

/**
 * Up to `max` same-name entities the caller can see, of kinds that declare a
 * lifecycle. Suggestions only: never attached.
 */
export async function subjectCandidatesFor(
  userId: string,
  name: string,
  max = 3
): Promise<SubjectCandidate[]> {
  if (!name.trim()) return [];
  const identity = await resolveIdentity(db, {
    userId,
    name,
    userScope: accessScopeWhere({
      workspaceIdColumn: entities.workspaceId,
      entityIdColumn: entities.id,
      ownerColumn: entities.userId,
      userId,
      facetLens: true,
    }),
    limit: 10,
  });
  if (identity.candidates.length === 0) return [];
  const rows = await db
    .select({ id: entities.id, profileId: entities.profileId })
    .from(entities)
    .where(
      inArray(
        entities.id,
        identity.candidates.map((c) => c.id)
      )
    );
  const profileOf = new Map(rows.map((r) => [r.id, r.profileId]));
  const lifecycles = await new ProfileResolutionService(
    db
  ).getEffectiveLifecycles([
    ...new Set(rows.map((r) => r.profileId).filter((p): p is string => !!p)),
  ]);
  return identity.candidates
    .filter((c) => {
      const profileId = profileOf.get(c.id);
      return (
        !!profileId && (lifecycles.get(profileId)?.options.length ?? 0) > 0
      );
    })
    .slice(0, max)
    .map((c) => ({ id: c.id, kind: c.type, title: c.title }));
}
