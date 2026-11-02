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
  gte,
  inArray,
  isNull,
  drizzleSql,
  playbookRuns,
  proposals,
  users,
  focusSessions,
  messages,
} from "@synap/database";
import { MessageAuthorType, ProposalStatus } from "@synap/database/schema";
import { EXTERNAL_AGENT_QUIET_AFTER_MS } from "@synap-core/types/agents";
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
  /**
   * The newest sign of life (ISO): the newest AGENT post in the session room
   * since the start, else the start. Any agent counts — an external agent
   * reports through its own connector identity, not the bound agent's.
   */
  lastNewsAt: string;
  /**
   * The silence window after which the task reads "No news" — ONLY for a
   * binding with no `status` verb (nothing can be asked; the room is its only
   * voice). `null` = pollable, or no usable binding: never marked quiet.
   */
  quietAfterMs: number | null;
}

/** A start proposal that was called off — the pending start reads `cancelled`. */
const CALLED_OFF_PROPOSAL = new Set<string>([
  ProposalStatus.REJECTED,
  ProposalStatus.WITHDRAWN,
  ProposalStatus.APPROVAL_FAILED,
  ProposalStatus.EXPIRED,
]);

/**
 * One session's external agent — one session of
 * {@link readSessionExternalAgentsFor}, so the packet, the holder and the
 * list rows read it through one loader.
 */
export async function readSessionExternalAgent(
  sessionId: string,
  database: typeof defaultDb = defaultDb
): Promise<SessionExternalAgent | null> {
  return (
    (await readSessionExternalAgentsFor([sessionId], database)).get(
      sessionId
    ) ?? null
  );
}

/**
 * The external agent of MANY sessions: one query for the newest handed-off
 * run of each, then — only for the sessions that have one — one batched read
 * each for the agents' names, the start proposals and the newest agent post,
 * and one binding read per distinct agent. Every asked id is in the map
 * (`null` = never handed to an external agent). THROWS on a failed read.
 */
export async function readSessionExternalAgentsFor(
  sessionIds: readonly string[],
  database: typeof defaultDb = defaultDb
): Promise<Map<string, SessionExternalAgent | null>> {
  const ids = [...new Set(sessionIds)];
  const out = new Map<string, SessionExternalAgent | null>(
    ids.map((id) => [id, null])
  );
  if (ids.length === 0) return out;
  // The newest run of each session that was handed to an external agent.
  const runs = (
    await database
      .selectDistinctOn([playbookRuns.sessionId], {
        sessionId: playbookRuns.sessionId,
        id: playbookRuns.id,
        status: playbookRuns.status,
        ext: playbookRuns.externalAgent,
      })
      .from(playbookRuns)
      .where(
        and(
          inArray(playbookRuns.sessionId, ids),
          drizzleSql`${playbookRuns.externalAgent} IS NOT NULL`
        )
      )
      .orderBy(playbookRuns.sessionId, desc(playbookRuns.startedAt))
  ).flatMap((r) => {
    const ext = r.ext as PlaybookRunExternalAgent | null | undefined;
    return r.sessionId && ext ? [{ ...r, sessionId: r.sessionId, ext }] : [];
  });
  if (runs.length === 0) return out;

  const agentIds = [...new Set(runs.map((r) => r.ext.agentUserId))];
  const proposalIds = [
    ...new Set(
      runs.flatMap((r) =>
        r.ext.status === "pending_start" && r.ext.proposalId
          ? [r.ext.proposalId]
          : []
      )
    ),
  ];
  const [agentRows, bindings, proposalRows, postRows] = await Promise.all([
    database
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, agentIds)),
    // The LIVE binding, as the cancel door reads it. A broken one is "unknown"
    // (null) here — its fault is shown on the agent's own reach mark.
    Promise.all(
      agentIds.map(async (agentUserId) => {
        const binding = await resolveAgentBinding(agentUserId).catch(
          (err: unknown) => {
            if (err instanceof AgentBindingError) return null;
            throw err;
          }
        );
        return [agentUserId, binding] as const;
      })
    ),
    proposalIds.length
      ? database
          .select({ id: proposals.id, status: proposals.status })
          .from(proposals)
          .where(inArray(proposals.id, proposalIds))
      : Promise.resolve(
          [] as Array<{
            id: string;
            status: (typeof proposals.$inferSelect)["status"];
          }>
        ),
    // The newest agent post in each such session's room since its hand-off
    // (one indexed read per handed-off session: they are few).
    Promise.all(
      runs.map((r) =>
        database
          .select({ at: messages.timestamp })
          .from(messages)
          .innerJoin(
            focusSessions,
            eq(focusSessions.channelId, messages.channelId)
          )
          .where(
            and(
              eq(focusSessions.id, r.sessionId),
              eq(messages.authorType, MessageAuthorType.AI_AGENT),
              isNull(messages.deletedAt),
              gte(messages.timestamp, new Date(r.ext.startedAt))
            )
          )
          .orderBy(desc(messages.timestamp))
          .limit(1)
          .then((rows) => [r.sessionId, rows[0]?.at ?? null] as const)
      )
    ),
  ]);
  const nameOf = new Map(agentRows.map((r) => [r.id, r.name]));
  const bindingOf = new Map(bindings);
  const proposalOf = new Map(proposalRows.map((r) => [r.id, r.status]));
  const newestPostOf = new Map(postRows);

  for (const row of runs) {
    const ext = row.ext;
    const last = ext.lastState;
    const binding = bindingOf.get(ext.agentUserId) ?? null;
    const proposalStatus =
      ext.status === "pending_start" && ext.proposalId
        ? (proposalOf.get(ext.proposalId) ?? null)
        : undefined;
    const newestPost = newestPostOf.get(row.sessionId) ?? null;

    let status: SessionExternalAgent["status"] = ext.status;
    if (ext.status === "pending_start" && proposalStatus !== undefined) {
      const p = proposalStatus;
      status =
        p === ProposalStatus.PENDING
          ? "pending_start"
          : p && CALLED_OFF_PROPOSAL.has(p)
            ? "cancelled"
            : "unknown";
    }
    const supports = binding?.supports ?? null;
    const seen = ext.reportedAt ?? {};
    out.set(row.sessionId, {
      runId: row.id,
      runStatus: row.status,
      agentUserId: ext.agentUserId,
      agentName: nameOf.get(ext.agentUserId)?.trim() || null,
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
      lastNewsAt: newestPost ? newestPost.toISOString() : ext.startedAt,
      quietAfterMs:
        binding && !binding.verbs.status ? EXTERNAL_AGENT_QUIET_AFTER_MS : null,
    });
  }
  return out;
}
