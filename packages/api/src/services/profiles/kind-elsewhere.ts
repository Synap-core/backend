/**
 * Where a kind the caller named DOES exist, when it is not available in the
 * space it was filed in — the `foundIn` of a `kind_missing` refusal
 * (`utils/kind-missing.ts`).
 *
 * Only spaces the caller can read (member ∪ owned ∪ pod-visible, the one floor
 * `getUserWorkspaceIds` composes) are named, and only an ACTIVE, non-probe
 * kind whose OWNER space is one of them (scope `workspace` or `shared`) with
 * that exact slug. A shared kind reachable through a grant row but owned by a
 * space the caller cannot read is not named; stated, not implied.
 *
 * Best-effort: a failed lookup answers with no `foundIn` rather than masking
 * the refusal it is describing.
 */

import { and, asc, db, eq, inArray, ne } from "@synap/database";
import {
  PROFILE_ORIGIN_PROBE,
  ProfileScope,
  profiles,
  workspaces,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { getUserWorkspaceIds } from "../../utils/workspace-membership.js";
import {
  KIND_ELSEWHERE_MAX,
  type KindMissingDetail,
} from "../../utils/kind-missing.js";

const logger = createLogger({ module: "kind-elsewhere" });

export async function describeMissingKind(args: {
  profileSlug: string;
  userId: string;
  /** The space the kind was looked up in. */
  workspaceId: string | null;
  database?: Pick<typeof db, "select">;
}): Promise<KindMissingDetail> {
  const { profileSlug, userId, workspaceId } = args;
  const database = args.database ?? db;
  const base: KindMissingDetail = { profileSlug, workspaceId, foundIn: [] };
  try {
    const readable = await getUserWorkspaceIds(userId);
    if (readable.length === 0) return base;
    const [here] = workspaceId
      ? await database
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.id, workspaceId),
              inArray(workspaces.id, readable)
            )
          )
          .limit(1)
      : [];
    const elsewhere = readable.filter((id) => id !== workspaceId);
    const rows =
      elsewhere.length === 0
        ? []
        : await database
            .select({
              workspaceId: profiles.workspaceId,
              kindName: profiles.displayName,
              name: workspaces.name,
            })
            .from(profiles)
            .innerJoin(workspaces, eq(workspaces.id, profiles.workspaceId))
            .where(
              and(
                eq(profiles.slug, profileSlug),
                eq(profiles.isActive, true),
                ne(profiles.origin, PROFILE_ORIGIN_PROBE),
                inArray(profiles.scope, [
                  ProfileScope.WORKSPACE,
                  ProfileScope.SHARED,
                ]),
                inArray(profiles.workspaceId, elsewhere)
              )
            )
            .orderBy(asc(workspaces.name))
            .limit(KIND_ELSEWHERE_MAX * 2);
    const foundIn: KindMissingDetail["foundIn"] = [];
    for (const r of rows) {
      if (
        !r.workspaceId ||
        foundIn.some((f) => f.workspaceId === r.workspaceId)
      )
        continue;
      foundIn.push({ workspaceId: r.workspaceId, name: r.name });
      if (foundIn.length >= KIND_ELSEWHERE_MAX) break;
    }
    const kindName = rows[0]?.kindName;
    return {
      ...base,
      ...(kindName ? { kindName } : {}),
      ...(here?.name ? { workspaceName: here.name } : {}),
      foundIn,
    };
  } catch (err) {
    logger.warn(
      { err, profileSlug, workspaceId },
      "describeMissingKind: lookup failed (refusal carries no foundIn)"
    );
    return base;
  }
}
