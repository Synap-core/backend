/**
 * ExternalAgentExecutor — hand a run to an EXTERNAL agent through its binding.
 *
 * "Bring Your Own Agent", contract of 2026-10-08 ("Agents Synap can dispatch
 * work to"). Synap NEVER spawns a coding agent itself and never posts to a
 * caller-supplied URL: an agent is reached ONLY through the binding a person
 * stored for it (`participant --dispatched_via--> tool`, the tool's
 * `config.agentBinding`), whose `start` verb runs through `executeCapability`
 * — governed, and attributed to the AGENT user.
 *
 * ── Which agent (the contract order, never a silent default) ────────────────
 *   1. the run param `agentUserId` (or the same param answered onto the
 *      session's `metadata.params` through the "choose an agent" slot);
 *   2. the session roster's dispatchable agent (reach `'dispatch'`);
 *   3. THE dispatchable agent, when exactly one exists on the pod;
 *   4. otherwise the run FAILS and the person owes ONE slot, "Choose an
 *      agent", whose ask lists the dispatchable agents. Answering it writes
 *      `agentUserId` into the session's params; the next run uses it.
 *
 * ── What the agent receives ─────────────────────────────────────────────────
 * The task (goal fenced as UNTRUSTED data — it is the person's words and the
 * answers fed back, not instructions from Synap), repos/branch when the run
 * params carry them, the session and room ids, the run's capture path, the
 * pod's MCP URL, and a REFERENCE to the agent's own key (`api_keys.id` +
 * prefix — never the secret). How the key reaches the agent is the provider
 * template's business; no secret is ever put in a prompt.
 *
 * ── Outcomes ────────────────────────────────────────────────────────────────
 *   accepted  ⇒ run `running`, `externalAgent` recorded on the run (the poll
 *               and the cancel door read it), a room update.
 *   proposed  ⇒ run `proposed` — the start waits on a person's approval; the
 *               room says so with the review link.
 *   failed    ⇒ run `failed`, with the reason in the room. Never `running`
 *               over a delivery nothing received.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.4).
 */

import type {
  Executor,
  ExpectedOutput,
  RunContext,
  RunResult,
} from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import {
  db,
  focusSessions,
  playbooks,
  users,
  apiKeys,
  and,
  eq,
  desc,
  inArray,
  isNull,
  drizzleSql,
} from "@synap/database";
import { PARAM_SLOT_KIND } from "@synap-core/types/focus-sessions";
import {
  AgentBindingError,
  listDispatchableAgentIds,
  ownedAgentIds,
  resolveAgentBinding,
  resolveAgentReachMany,
  type AgentBinding,
} from "../../agent-dispatch/agent-binding.js";
import {
  asOptionalString,
  asRecord,
  callBindingVerb,
  externalRefFromStartResult,
  fenceUntrustedData,
  postDispatchNotice,
} from "../../agent-dispatch/binding-call.js";
import { RUN_PARAMS_METADATA_KEY } from "../playbook-lifecycle.js";
import { paramOwedSlots } from "../../focus-sessions/param-slots.js";
import { normalizeExpectedLabel } from "../../focus-sessions/expected-label.js";
import { updateExpectedOutputsLocked } from "../../focus-sessions/delegate-output.js";
import { notifySessionNeedsYou } from "../../focus-sessions/notify-needs-you.js";
import { podPublicOrigin } from "../../../utils/deep-links.js";

const logger = createLogger({ module: "external-agent-executor" });

/** The run param that names the agent (and the slot's `paramName`). */
export const AGENT_USER_ID_PARAM = "agentUserId";
/** The owed slot's label — one per session, merged by label. */
export const CHOOSE_AGENT_SLOT_LABEL = "Answer: Choose an agent";

interface SessionRow {
  id: string;
  userId: string;
  agentIds: string[];
  metadata: Record<string, unknown>;
}

export type RunAgentChoice =
  | { kind: "agent"; agentUserId: string; via: "param" | "roster" | "single" }
  | { kind: "invalid_param"; agentUserId: string }
  | { kind: "choose"; candidates: string[] };

/**
 * THE "which agent does this run use" rule (pure over its reads). Every step
 * is floored on the run OWNER's own agents (`ownedAgentIds` /
 * `listDispatchableAgentIds`, the `ownAgentUserFilter` lineage door): a param,
 * a roster entry or a pod-wide single naming a teammate's agent never hands
 * that agent the work.
 */
export async function chooseRunAgent(p: {
  ownerId: string;
  paramAgentUserId: string | undefined;
  rosterAgentIds: readonly string[];
}): Promise<RunAgentChoice> {
  if (p.paramAgentUserId) {
    const [reach, owned] = await Promise.all([
      resolveAgentReachMany([p.paramAgentUserId]),
      ownedAgentIds(p.ownerId, [p.paramAgentUserId]),
    ]);
    return reach.get(p.paramAgentUserId) === "dispatch" &&
      owned.has(p.paramAgentUserId)
      ? { kind: "agent", agentUserId: p.paramAgentUserId, via: "param" }
      : { kind: "invalid_param", agentUserId: p.paramAgentUserId };
  }
  if (p.rosterAgentIds.length > 0) {
    const [reach, owned] = await Promise.all([
      resolveAgentReachMany(p.rosterAgentIds),
      ownedAgentIds(p.ownerId, p.rosterAgentIds),
    ]);
    const staffed = p.rosterAgentIds.find(
      (id) => reach.get(id) === "dispatch" && owned.has(id)
    );
    if (staffed) return { kind: "agent", agentUserId: staffed, via: "roster" };
  }
  const candidates = await listDispatchableAgentIds(p.ownerId);
  if (candidates.length === 1) {
    return { kind: "agent", agentUserId: candidates[0]!, via: "single" };
  }
  return { kind: "choose", candidates };
}

async function loadSession(sessionId: string): Promise<SessionRow | null> {
  const row = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, sessionId),
    columns: { id: true, userId: true, agentIds: true, metadata: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    agentIds: Array.isArray(row.agentIds) ? (row.agentIds as string[]) : [],
    metadata: asRecord(row.metadata),
  };
}

/** The agent's own door key, by REFERENCE (id + prefix) — never the secret. */
async function agentKeyRef(
  agentUserId: string
): Promise<{ apiKeyId: string; keyPrefix: string } | null> {
  const [key] = await db
    .select({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, agentUserId),
        isNull(apiKeys.revokedAt),
        drizzleSql`${apiKeys.keyType} IS DISTINCT FROM 'is_internal'`
      )
    )
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  return key ? { apiKeyId: key.id, keyPrefix: key.keyPrefix } : null;
}

/**
 * Owe the person ONE "Choose an agent" slot. Its ask chooses among the
 * dispatchable agents by NAME (value = the agent user id); answering it writes
 * `agentUserId` into the session's params through the ONE answer door.
 */
async function oweChooseAgentSlot(p: {
  session: SessionRow;
  candidates: string[];
  playbookName: string;
}): Promise<void> {
  const named = p.candidates.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, p.candidates))
    : [];
  const owedAt = new Date().toISOString();
  const [slot] = paramOwedSlots(
    [
      {
        name: AGENT_USER_ID_PARAM,
        label: "Choose an agent",
        type: "choice",
        options: p.candidates,
        required: true,
      },
    ],
    p.playbookName,
    owedAt,
    p.candidates.length === 0
      ? "No agent is bound for dispatch yet — bind one to its provider in Settings › Agents, then run this again."
      : "Several agents can take this work; pick the one that builds it, then run this again."
  );
  const chooseSlot: ExpectedOutput = {
    ...slot!,
    label: CHOOSE_AGENT_SLOT_LABEL,
    kind: PARAM_SLOT_KIND,
    ...(named.length > 0
      ? {
          ask: {
            mode: "choose",
            options: named.map((a) => ({
              label: a.name?.trim() || "Agent",
              value: a.id,
            })),
          },
        }
      : {}),
  };
  let before: ExpectedOutput[] = [];
  let after: ExpectedOutput[] = [];
  await updateExpectedOutputsLocked(p.session.id, (current) => {
    // Merged by label: a second failed run never files the question twice.
    const owed = current.some(
      (o) =>
        normalizeExpectedLabel(o?.label) ===
          normalizeExpectedLabel(CHOOSE_AGENT_SLOT_LABEL) && o.status !== "done"
    );
    if (owed) return null;
    before = current;
    after = [
      ...current.filter(
        (o) =>
          normalizeExpectedLabel(o?.label) !==
          normalizeExpectedLabel(CHOOSE_AGENT_SLOT_LABEL)
      ),
      chooseSlot,
    ];
    return after;
  });
  if (after.length > 0) {
    // A headless run handed the person a question — tell them.
    await notifySessionNeedsYou({
      sessionId: p.session.id,
      byAgent: true,
      recipientUserId: p.session.userId,
      reason: { kind: "slots", before, after },
    });
  }
}

async function playbookNameOf(playbookId: string | undefined): Promise<string> {
  if (!playbookId) return "This run";
  const [row] = await db
    .select({ name: playbooks.name })
    .from(playbooks)
    .where(eq(playbooks.id, playbookId))
    .limit(1);
  return row?.name?.trim() || "This run";
}

/** The repos/branch a run carries, when its params name them. */
function repoInputs(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const repos = Array.isArray(params.repos)
    ? params.repos.filter((r): r is string => typeof r === "string")
    : asOptionalString(params.repo)
      ? [asOptionalString(params.repo)!]
      : [];
  if (repos.length) out.repos = repos;
  const branch = asOptionalString(params.branch);
  if (branch) out.branch = branch;
  return out;
}

/** The run param `agentUserId`, then the same param answered onto the session. */
function paramAgent(
  input: Record<string, unknown>,
  session: SessionRow
): string | undefined {
  return (
    asOptionalString(input[AGENT_USER_ID_PARAM]) ??
    asOptionalString(
      asRecord(session.metadata[RUN_PARAMS_METADATA_KEY])[AGENT_USER_ID_PARAM]
    )
  );
}

export class ExternalAgentExecutor implements Executor {
  readonly ref = "external-agent" as const;

  async run(ctx: RunContext): Promise<RunResult> {
    const input = asRecord(ctx.input);
    const runId = asOptionalString(input.runId) ?? null;
    const session = await loadSession(ctx.sessionId);
    if (!session) {
      return {
        status: "failed",
        error: `external-agent run: session ${ctx.sessionId} not found`,
      };
    }
    const ownerId = session.userId;
    const fail = async (error: string, key: string): Promise<RunResult> => {
      await postDispatchNotice({
        channelId: ctx.channelId,
        ownerId,
        content: `Could not hand this run to an agent: ${error}`,
        idempotencyKey: `external-agent:${runId ?? ctx.sessionId}:${key}`,
      });
      return { status: "failed", error };
    };

    // 1. Which agent.
    const choice = await chooseRunAgent({
      ownerId,
      paramAgentUserId: paramAgent(input, session),
      rosterAgentIds: session.agentIds,
    });
    if (choice.kind === "invalid_param") {
      return fail(
        `agent ${choice.agentUserId} is not one of your agents bound for dispatch — bind it to its provider, or choose another agent`,
        "invalid-agent"
      );
    }
    if (choice.kind === "choose") {
      await oweChooseAgentSlot({
        session,
        candidates: choice.candidates,
        playbookName: await playbookNameOf(ctx.playbookId),
      });
      return fail(
        choice.candidates.length === 0
          ? "no agent is bound for dispatch — bind one, then run this again"
          : "several agents can take this work — choose one in the session, then run this again",
        "choose-agent"
      );
    }
    const agentUserId = choice.agentUserId;

    // 2. Its binding (a broken one is a visible failure, never a skip).
    let binding: AgentBinding | null;
    try {
      binding = await resolveAgentBinding(agentUserId);
    } catch (err) {
      if (err instanceof AgentBindingError) return fail(err.message, "binding");
      throw err;
    }
    if (!binding) {
      return fail(`agent ${agentUserId} has no dispatch binding`, "binding");
    }

    // 3. Start the task, as the agent.
    const origin = podPublicOrigin() ?? null;
    const params = {
      task: {
        goal: fenceUntrustedData(ctx.goal, "synap session goal"),
        ...(typeof input.feedback === "string" && input.feedback.trim()
          ? {
              feedback: fenceUntrustedData(
                input.feedback,
                "synap reviewer feedback"
              ),
            }
          : {}),
        ...(ctx.subjectId
          ? {
              subject: {
                id: ctx.subjectId,
                name: ctx.subjectName ?? null,
                profile: ctx.subjectProfile ?? null,
              },
            }
          : {}),
        currentStage: ctx.currentStage ?? null,
      },
      ...repoInputs(input),
      sessionId: ctx.sessionId,
      channelId: ctx.channelId ?? null,
      runId,
      capturePath: runId ? `/api/hub/runs/${runId}/capture` : null,
      pod: {
        url: origin,
        mcpUrl: origin ? `${origin}/mcp` : null,
      },
      agent: {
        agentUserId,
        keyRef: await agentKeyRef(agentUserId),
      },
    };
    const started = await callBindingVerb({
      binding,
      verb: "start",
      agentUserId,
      ownerId,
      parameters: params,
      sessionId: ctx.sessionId,
      channelId: ctx.channelId ?? null,
      ...(runId ? { idempotencyKey: `agent-start:${runId}` } : {}),
    });

    if (started.status === "proposed") {
      await postDispatchNotice({
        channelId: ctx.channelId,
        ownerId,
        content: `Starting the ${binding.provider} agent needs your approval: ${started.reviewUrl}`,
        idempotencyKey: `external-agent:${runId ?? ctx.sessionId}:proposed`,
      });
      return {
        status: "proposed",
        summary: `Waiting on approval to start the ${binding.provider} agent`,
      };
    }
    if (started.status !== "ok") {
      logger.warn(
        { runId, agentUserId, toolId: binding.toolId, error: started.message },
        "external-agent start failed"
      );
      return fail(
        `the ${binding.provider} agent did not accept the task: ${started.message}`,
        "start"
      );
    }

    const { externalId, url } = externalRefFromStartResult(started.result);
    await postDispatchNotice({
      channelId: ctx.channelId,
      ownerId,
      content: `Handed to the ${binding.provider} agent${url ? ` — ${url}` : ""}.`,
      idempotencyKey: `external-agent:${runId ?? ctx.sessionId}:started`,
    });
    return {
      status: "running",
      summary: `dispatched to ${binding.provider}${externalId ? ` (${externalId})` : ""}`,
      externalAgent: {
        agentUserId,
        toolId: binding.toolId,
        provider: binding.provider,
        externalId,
        url,
        status: "running",
        startedAt: new Date().toISOString(),
      },
    };
  }
}
