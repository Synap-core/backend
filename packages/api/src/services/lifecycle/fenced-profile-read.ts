/**
 * A kind's or role's read for a key bounded by a grant (a pod app's token, a
 * scoped key): the ONE narrowing `GET /lifecycle` and the flow read
 * (`flow.of`, every door) share. Moved out of `rest/intent-surfaces.ts` so
 * the two can never answer a fenced key differently.
 *
 * A fenced key must name `workspaceId`, and reads a profile only where its
 * grant reads that kind (`entity.<kind>.read`) or, for a role, `facet.read`:
 * the permission it needs for the rows themselves. A failed read (unknown
 * slug, no lifecycle) tells a fenced key nothing about a kind it may not
 * read: it gets the 403, never the read's own error. An unfenced caller (a
 * person, a full-access key) passes straight through.
 */
import { TRPCError } from "@trpc/server";
import { getRequestGrant } from "@synap/database";
import { isFencedGrant } from "../../access/grant-door-fence.js";
import { grantWriteDenial } from "../../utils/grant-write-check.js";

export async function readProfileUnderGrant<T>(
  q: { profileSlug: string; workspaceId?: string | null },
  read: () => Promise<T>,
  profileKindOf: (result: T) => "kind" | "role"
): Promise<T> {
  const fenced = isFencedGrant(getRequestGrant());
  if (!fenced) return read();
  const workspaceId = q.workspaceId ?? undefined;
  if (!workspaceId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "A key bounded by a grant must name `workspaceId`.",
    });
  const denial = (subjectType: "entity" | "facet") =>
    grantWriteDenial({
      subjectType,
      action: "read",
      workspaceId,
      data: { profileSlug: q.profileSlug },
    });
  let result: T;
  try {
    result = await read();
  } catch (err) {
    const denied = await denial("entity");
    if (denied && (await denial("facet")))
      throw new TRPCError({ code: "FORBIDDEN", message: denied });
    throw err;
  }
  const denied = await denial(
    profileKindOf(result) === "role" ? "facet" : "entity"
  );
  if (denied) throw new TRPCError({ code: "FORBIDDEN", message: denied });
  return result;
}
