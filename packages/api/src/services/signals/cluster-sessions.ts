/**
 * The sessions a needs-you page's proposal clusters were filed under — named,
 * THROUGH THE SESSION READ FLOOR.
 *
 * A cluster filed entirely under one session (`ProposalCluster.sessionId`)
 * joins that session's block on a needs-you page, and the block is drawn as a
 * door naming the session. A door labelled "Session" names nothing, so the
 * name is read here — once per page, batched — and only for sessions the
 * viewer may READ (`sessionReadableWhere`, the roster-aware rule, with the
 * door's own `rosterReadFor(ctx)`). A session the viewer cannot read is simply
 * absent from the map, and `signalFromCluster` then gives its cluster NO
 * session key and no title: it stays a plain row, and neither the session's
 * name nor the fact that the proposals belong to it leaks.
 */

import { and, db, focusSessions, inArray } from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  sessionReadableWhere,
  type SessionReader,
} from "../../access/session-visibility.js";
import type { ProposalCluster } from "../proposals/fingerprint.js";
import type { ClusterSessionName } from "./needs-you-union.js";

export async function readClusterSessions(
  clusters: readonly Pick<ProposalCluster, "sessionId">[],
  reader: SessionReader
): Promise<Map<string, ClusterSessionName>> {
  const ids = [
    ...new Set(
      clusters.map((c) => c.sessionId).filter((id): id is string => !!id)
    ),
  ];
  const out = new Map<string, ClusterSessionName>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      projectId: focusSessions.projectId,
    })
    .from(focusSessions)
    .where(and(inArray(focusSessions.id, ids), sessionReadableWhere(reader)));
  for (const r of rows) {
    out.set(r.id, {
      title: resolveSessionTitle(r) || null,
      projectId: r.projectId ?? null,
    });
  }
  return out;
}
