import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  entities,
  type resolveIdentity,
  type IdentitySignal,
} from "@synap/database";
import { ownerPrivateVisibleWhere } from "./user-visible-where.js";
import {
  findPendingSignalMatches,
  type PendingSignalMatch,
} from "./pending-capture-dedup.js";

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
  userId: string,
  /**
   * The strong signals this lookup was built from. When supplied, the response
   * also carries `pendingCandidates` — matches in the caller's OWN pending
   * queue (see below). Optional so callers that don't have the signals handy
   * simply omit the pending scan.
   */
  signals?: IdentitySignal[]
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
  /**
   * Strong-signal matches in the caller's OWN pending capture/import proposals
   * — a duplicate already IN-FLIGHT but not yet committed (so `resolveIdentity`,
   * which only sees committed entities, returns "none"). ADVISORY ONLY and
   * carries a `proposalId`, never an `entityId`: the pending proposal can still
   * be rejected, so a caller must NOT link to it — it should wait for review or
   * revise, not file a second copy. Owner-floored; present only when signals
   * were supplied and something collided.
   */
  pendingCandidates?: PendingSignalMatch[];
}> {
  let strongVisible = true;
  if (resolution.match === "strong" && resolution.entity) {
    const visible = await db.query.entities.findFirst({
      columns: { id: true },
      where: and(
        eq(entities.id, resolution.entity.id),
        isNull(entities.deletedAt),
        // The STRONG-match recheck is the load-bearing floor for strong matches
        // (userScope is injected only on the weak path). A global strong signal
        // (email/phone) can match a NULL-workspace owner-private entity, so
        // owner-gate the NULL branch here — never leak its title/kind cross-tenant.
        ownerPrivateVisibleWhere(entities.workspaceId, entities.userId, userId)
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
    // Owner-floored pending scan — only when the caller passed the signals and a
    // committed match wasn't the whole story. Additive: never alters `match`.
    ...(signals && signals.length > 0
      ? await (async () => {
          const pending = await findPendingSignalMatches(db, {
            userId,
            signals,
          });
          return pending.length > 0 ? { pendingCandidates: pending } : {};
        })()
      : {}),
  };
}
