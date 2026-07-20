import { and, eq, isNull } from "drizzle-orm";
import { db, entities, type resolveIdentity } from "@synap/database";
import { userVisibleWhere } from "./user-visible-where.js";

type IdentityResolution = Awaited<ReturnType<typeof resolveIdentity>>;

/**
 * Build the wire response for an identity-resolve lookup — the ONE place the
 * cross-user content scoping happens (shared by the Hub REST
 * POST /identity/resolve route and the MCP synap_resolve_identity tool).
 *
 * SECURITY — the STRONG identity path is deliberately GLOBAL (frozen policy:
 * one subject per email/phone pod-wide) so callers can avoid creating a
 * duplicate, but the matched row's CONTENT must not leak across users. When
 * the strong match isn't visible to the caller we return the match verdict +
 * id (the write doors stay governed — an attach/enrich on it will
 * propose/deny) but strip title/kind. Weak-path candidates are already
 * caller-scoped by the resolver's userScope.
 */
export async function buildIdentityResolveResponse(
  resolution: IdentityResolution,
  userId: string
): Promise<{
  match: "strong" | "weak" | "none";
  entityId?: string;
  entityTitle?: string | null;
  entityKind?: string;
  candidates: Array<{ entityId: string; title: string | null; kind: string }>;
  /**
   * Same-title entities of a DIFFERENT kind (e.g. a `question` and a `research`
   * sharing a title). ADVISORY ONLY — `match` stays "none" because title
   * similarity must never auto-merge; strong signals (email/phone/url) remain
   * the only automatic path. Present so a caller stops treating "none" as
   * "safe to create" and can propose a LINK instead of minting a duplicate.
   * A subset of `candidates`, so it inherits the same caller-scoping.
   */
  crossKindCandidates: Array<{
    entityId: string;
    title: string | null;
    kind: string;
  }>;
}> {
  let strongVisible = true;
  if (resolution.match === "strong" && resolution.entity) {
    const visible = await db.query.entities.findFirst({
      columns: { id: true },
      where: and(
        eq(entities.id, resolution.entity.id),
        isNull(entities.deletedAt),
        userVisibleWhere(entities.workspaceId, userId)
      ),
    });
    strongVisible = Boolean(visible);
  }
  return {
    match: resolution.match ?? "none",
    entityId: resolution.entity?.id,
    entityTitle: strongVisible ? resolution.entity?.title : undefined,
    entityKind: strongVisible ? resolution.entity?.type : undefined,
    candidates: resolution.candidates.map((cand) => ({
      entityId: cand.id,
      title: cand.title,
      kind: cand.type,
    })),
    crossKindCandidates: (resolution.crossKindCandidates ?? []).map((cand) => ({
      entityId: cand.id,
      title: cand.title,
      kind: cand.type,
    })),
  };
}
