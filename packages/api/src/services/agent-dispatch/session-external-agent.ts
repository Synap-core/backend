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
  proposals,
  users,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";
import { AgentBindingError, resolveAgentBinding } from "./agent-binding.js";

export interface SessionExternalAgent {
  runId: string;
  /** The run's own lifecycle (`running`, `failed`, `cancelled`, `proposed`, …). */
  runStatus: string;
  agentUserId: string;
  /** The agent's name (`users.name`), `null` when it has none. */
  agentName: string | null;
  provider: string;
  /**
   * The task's state: pending_start | running | needs_input | done | failed |
   * cancelled. A pending start whose proposal was REJECTED reads `cancelled`
   * (it was called off); one whose proposal is no longer pending but whose
   * hand-off was never recorded reads `unknown` — the view's unmeasured arm,
   * never a guess.
   */
  status: PlaybookRunExternalAgent["status"] | "unknown";
  /** `pending_start` only: the proposal the start waits on. */
  proposalId: string | null;
  /** The provider's page for the task. */
  url: string | null;
  prUrl: string | null;
  branch: string | null;
  previewUrl: string | null;
  summary: string | null;
  /** The failed status reads in a row (`null` = the last read was good). */
  pollError: { firstSeenAt: string; count: number } | null;
  /**
   * The binding can stop the agent (`supports.cancel`) — read from the LIVE
   * binding, as the cancel door does. `null` = no usable binding to ask.
   */
  cancelStopsAgent: boolean | null;
  /** When the agent first reported each output (ISO), by output key. */
  reportedAt: { pull_request?: string; branch?: string; preview?: string };
  /** When the status poll last read the task (ISO), `null` before the first read. */
  polledAt: string | null;
  startedAt: string;
}

/** A start proposal that was called off — the pending start reads `cancelled`. */
const CALLED_OFF_PROPOSAL = new Set<string>([
  ProposalStatus.REJECTED,
  ProposalStatus.WITHDRAWN,
  ProposalStatus.APPROVAL_FAILED,
  ProposalStatus.EXPIRED,
]);

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

  const [agentRow, binding, proposal] = await Promise.all([
    database
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, ext.agentUserId))
      .limit(1)
      .then((r) => r[0]),
    // The LIVE binding, as the cancel door reads it. A broken one is "unknown"
    // (null) here — its fault is shown on the agent's own reach mark.
    resolveAgentBinding(ext.agentUserId).catch((err: unknown) => {
      if (err instanceof AgentBindingError) return null;
      throw err;
    }),
    ext.status === "pending_start" && ext.proposalId
      ? database
          .select({ status: proposals.status })
          .from(proposals)
          .where(eq(proposals.id, ext.proposalId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(undefined),
  ]);

  let status: SessionExternalAgent["status"] = ext.status;
  if (ext.status === "pending_start" && proposal !== undefined) {
    const p = proposal?.status ?? null;
    status =
      p === ProposalStatus.PENDING
        ? "pending_start"
        : p && CALLED_OFF_PROPOSAL.has(p)
          ? "cancelled"
          : "unknown";
  }
  const supports = binding?.supports ?? null;
  const seen = ext.reportedAt ?? {};
  return {
    runId: row.id,
    runStatus: row.status,
    agentUserId: ext.agentUserId,
    agentName: agentRow?.name?.trim() || null,
    provider: ext.provider,
    status,
    proposalId: status === "pending_start" ? (ext.proposalId ?? null) : null,
    url: ext.url ?? last?.url ?? null,
    prUrl: last?.prUrl ?? null,
    branch: last?.branch ?? null,
    previewUrl: last?.previewUrl ?? null,
    summary: last?.summary ?? null,
    pollError: ext.pollError
      ? { firstSeenAt: ext.pollError.firstSeenAt, count: ext.pollError.count }
      : null,
    cancelStopsAgent: supports ? supports.cancel === true : null,
    reportedAt: {
      ...(seen.prUrl ? { pull_request: seen.prUrl } : {}),
      ...(seen.branch ? { branch: seen.branch } : {}),
      ...(seen.previewUrl ? { preview: seen.previewUrl } : {}),
    },
    polledAt: ext.polledAt ?? null,
    startedAt: ext.startedAt,
  };
}
