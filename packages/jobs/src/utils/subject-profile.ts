/**
 * The ONE reader of a subject profile's kind/role and declared lifecycle.
 * Its own module (not `session-process.ts`) so a suite that mocks the process
 * loader keeps the real reader, and the reverse.
 */
import { db, profiles, ProfileResolutionService, eq } from "@synap/database";

/** What a process (or an activator) needs to know about its subject profile. */
export interface SubjectLifecycle {
  profileKind: "kind" | "role";
  /** The property the profile's lifecycle is declared on; null = none. */
  lifecycleProperty: string | null;
}

/**
 * Read the subject profile's kind/role and declared lifecycle — the profile
 * the given workspace sees under that slug. A slug the pod does not know reads
 * as a kind with no lifecycle.
 *
 * The ONE reader of "is this process's subject a kind or a role, and where
 * does its lifecycle live" — the activators (@synap/api
 * `playbook-activators.ts`, which re-exports it), the stage door
 * (`stage-subject-status.ts`) and `loadSessionProcess` (`session-process.ts`)
 * all ask it, so they can never disagree about where the status lives. Here,
 * in @synap/jobs, because jobs cannot import api.
 */
export async function readSubjectProfile(
  profileSlug: string,
  workspaceId: string | null
): Promise<SubjectLifecycle> {
  const rows = await db
    .select({
      id: profiles.id,
      profileKind: profiles.profileKind,
      workspaceId: profiles.workspaceId,
    })
    .from(profiles)
    .where(eq(profiles.slug, profileSlug));
  // The space's own profile wins over the pod-wide one of the same slug.
  const row =
    rows.find((r) => workspaceId && r.workspaceId === workspaceId) ??
    rows.find((r) => r.workspaceId === null) ??
    rows[0];
  if (!row) return { profileKind: "kind", lifecycleProperty: null };
  const lifecycle = await new ProfileResolutionService(
    db
  ).getEffectiveLifecycle(row.id, workspaceId);
  return {
    profileKind: row.profileKind === "role" ? "role" : "kind",
    lifecycleProperty: lifecycle?.propertySlug ?? null,
  };
}
