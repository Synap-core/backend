/**
 * A session that serves MORE THAN ONE goal (ticket 3fb0e2c3): `trackId` files
 * it into one; each other goal it serves is a `session --serves--> track`
 * edge, the link the goal rollup already counts (`status-rollup.ts`). Written
 * through THE dependency door (`governedDependencyLink`: the endpoint floor,
 * the space write check, governance), never a second producer or a new link
 * type. One outcome per goal, never folded: a bad id does not fail the call.
 */
import { SERVES_LINK_TYPE } from "@synap-core/types/connections";
import { governedDependencyLink } from "../links/dependency-links.js";

/** At most this many goals per call: a session serves a few goals, not a list. */
export const SERVES_TRACK_IDS_MAX = 5;

export type SessionServesReport =
  | { trackId: string; status: "linked" | "exists" }
  | { trackId: string; status: "proposed"; proposalId: string }
  | { trackId: string; status: "failed"; reason: string };

export async function addSessionServes(input: {
  sessionId: string;
  trackIds: readonly string[];
  userId: string;
  agentUserId?: string | null;
  door: string;
}): Promise<SessionServesReport[]> {
  const reports: SessionServesReport[] = [];
  for (const trackId of [...new Set(input.trackIds)]) {
    try {
      const r = await governedDependencyLink({
        edge: {
          fromType: "session",
          fromId: input.sessionId,
          toType: "track",
          toId: trackId,
          linkType: SERVES_LINK_TYPE,
        },
        userId: input.userId,
        agentUserId: input.agentUserId ?? null,
        sessionId: input.sessionId,
        door: input.door,
      });
      switch (r.status) {
        case "created":
          reports.push({ trackId, status: "linked" });
          break;
        case "exists":
          reports.push({ trackId, status: "exists" });
          break;
        case "proposed":
          reports.push({
            trackId,
            status: "proposed",
            proposalId: r.proposalId,
          });
          break;
        case "denied":
          reports.push({ trackId, status: "failed", reason: r.reason });
          break;
        case "refused":
          reports.push({ trackId, status: "failed", reason: r.error });
          break;
        default:
          reports.push({
            trackId,
            status: "failed",
            reason: `unexpected result ${r.status}`,
          });
      }
    } catch (err) {
      reports.push({
        trackId,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return reports;
}
