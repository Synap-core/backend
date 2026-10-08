/**
 * The session's EXTERNAL AGENT, as a room reads it — the newest run of the
 * session that was handed to an external agent (`playbook_runs.external_agent`),
 * projected to what a surface draws: who, where it stands, and the links the
 * agent reported (PR, branch, preview). ONE read, carried by the continuation
 * packet, so tRPC `focusSessions.get`, Hub `GET /focus-sessions/:id` and MCP
 * `synap_get_session` (browser and relay alike) show the same thing.
 *
 * `null` = no run of this session was ever handed to an external agent (a
 * true state). A FAILED read is the packet section's `unavailable`, never null.
 */

import {
  db as defaultDb,
  and,
  desc,
  eq,
  drizzleSql,
  playbookRuns,
} from "@synap/database";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";

export interface SessionExternalAgent {
  runId: string;
  /** The run's own lifecycle (`running`, `failed`, `cancelled`, …). */
  runStatus: string;
  agentUserId: string;
  provider: string;
  /** The task's normalized state: running | needs_input | done | failed | cancelled. */
  status: PlaybookRunExternalAgent["status"];
  /** The provider's page for the task. */
  url: string | null;
  prUrl: string | null;
  branch: string | null;
  previewUrl: string | null;
  summary: string | null;
  /** When the status poll last read the task (ISO), `null` before the first read. */
  polledAt: string | null;
  startedAt: string;
}

export async function readSessionExternalAgent(
  sessionId: string,
  database: typeof defaultDb = defaultDb
): Promise<SessionExternalAgent | null> {
  const [row] = await database
    .select({
      id: playbookRuns.id,
      status: playbookRuns.status,
      ext: playbookRuns.externalAgent,
    })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, sessionId),
        drizzleSql`${playbookRuns.externalAgent} IS NOT NULL`
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  const ext = row?.ext as PlaybookRunExternalAgent | null | undefined;
  if (!row || !ext) return null;
  const last = ext.lastState;
  return {
    runId: row.id,
    runStatus: row.status,
    agentUserId: ext.agentUserId,
    provider: ext.provider,
    status: ext.status,
    url: ext.url ?? last?.url ?? null,
    prUrl: last?.prUrl ?? null,
    branch: last?.branch ?? null,
    previewUrl: last?.previewUrl ?? null,
    summary: last?.summary ?? null,
    polledAt: ext.polledAt ?? null,
    startedAt: ext.startedAt,
  };
}
