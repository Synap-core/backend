/**
 * Does a kind HAVE a lifecycle? — the gate on "Draft a process for this".
 *
 * A process is worth drafting for a kind only when the kind already moves
 * through states: it carries a SELECT property whose slug names a status or a
 * stage (case-insensitive: `status`, `post-status`, `dealStage`, `stage`).
 * That property becomes the draft's `subjectProfile.statusProperty`.
 *
 * "Select" = a closed value set: a string property with a non-empty
 * `constraints.enum`, or one authored with `uiHints.inputType: "select"`.
 * A free-text "status" field is not a lifecycle — nothing could advance it.
 *
 * Read through the 3-layer property door (`getEffectiveProperties`, threaded
 * with the workspace) — never a raw property_defs read.
 */

import { getDb, ProfileResolutionService } from "@synap/database";

const LIFECYCLE_SLUG = /status|stage/i;

export interface LifecycleCandidateProperty {
  slug: string;
  valueType?: string | null;
  constraints?: unknown;
  uiHints?: unknown;
  displayOrder?: number;
}

function isSelect(p: LifecycleCandidateProperty): boolean {
  const c = (p.constraints ?? {}) as { enum?: unknown };
  if (Array.isArray(c.enum) && c.enum.length > 0) return true;
  const hints = (p.uiHints ?? {}) as { inputType?: unknown };
  return hints.inputType === "select";
}

/** The kind's lifecycle property slug, or null. Pure. First in display order wins. */
export function findLifecycleProperty(
  props: readonly LifecycleCandidateProperty[]
): string | null {
  const hit = [...props]
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
    .find((p) => LIFECYCLE_SLUG.test(p.slug) && isSelect(p));
  return hit?.slug ?? null;
}

export async function loadKindLifecycleProperty(input: {
  profileSlug: string;
  userId: string;
  workspaceId: string | null;
}): Promise<string | null> {
  const database = await getDb();
  const resolver = new ProfileResolutionService(database);
  const profile = await resolver.resolveProfile(
    input.profileSlug,
    input.userId,
    input.workspaceId
  );
  if (!profile) return null;
  const props = await resolver.getEffectiveProperties(
    profile.id,
    input.workspaceId
  );
  return findLifecycleProperty(props as LifecycleCandidateProperty[]);
}
