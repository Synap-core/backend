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
 * answers fed back, not instructions from Synap), the playbook's METHOD
 * (`task.method`: approved context skill, the rules it follows, the current
 * stage; the one renderer every door uses), repos when the run params
 * carry them, the branch the params name (`branch`, a checkout) or else the
 * per-session work branch to create (`workBranch`, `synap/<session short id>`),
 * the session and room ids, the run's capture path, the
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
  PlaybookStage,
  RunContext,
  RunResult,
  SlotAsk,
} from "@synap/playbooks";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  db,
  entities,
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
import { isLikelyUUID } from "@synap-core/types/proposals";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { externalAgentCallFailedReason } from "@synap-core/types/agents";
import {
  AgentBindingError,
  resolveAgentBinding,
  type AgentBinding,
} from "../../agent-dispatch/agent-binding.js";
import { route } from "../../agent-dispatch/route.js";
import {
  asOptionalString,
  agentDisplayName,
  asRecord,
  callBindingVerb,
  externalRefFromStartResult,
  noTaskIdMessage,
  fenceUntrustedData,
  postDispatchNotice,
} from "../../agent-dispatch/binding-call.js";
import { RUN_PARAMS_METADATA_KEY } from "../playbook-lifecycle.js";
import {
  loadRunMethodParts,
  renderPlaybookMethod,
} from "../playbook-method.js";
import { paramOwedSlots } from "../../focus-sessions/param-slots.js";
import { normalizeExpectedLabel } from "../../focus-sessions/expected-label.js";
import { updateExpectedOutputsLocked } from "../../focus-sessions/delegate-output.js";
import { notifySessionNeedsYou } from "../../focus-sessions/notify-needs-you.js";
import { attachSessionAgent } from "../../focus-sessions/attach-session-agent.js";
import { openTypedLink, podPublicOrigin } from "../../../utils/deep-links.js";

const logger = createLogger({ module: "external-agent-executor" });

/** The run param that names the agent (and the slot's `paramName`). */
export const AGENT_USER_ID_PARAM = "agentUserId";
/** The owed slot's label — one per session, merged by label. */
export const CHOOSE_AGENT_SLOT_LABEL = "Answer: Choose an agent";
/** The Settings section where a person binds an agent (`/open/settings/<it>`). */
export const AGENT_SETTINGS_SECTION = "agents";

interface SessionRow {
  id: string;
  userId: string;
  agentIds: string[];
  metadata: Record<string, unknown>;
  projectId: string | null;
  workspaceId: string | null;
}

async function loadSession(sessionId: string): Promise<SessionRow | null> {
  const row = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, sessionId),
    columns: {
      id: true,
      userId: true,
      agentIds: true,
      metadata: true,
      projectId: true,
      workspaceId: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    agentIds: Array.isArray(row.agentIds) ? (row.agentIds as string[]) : [],
    metadata: asRecord(row.metadata),
    projectId: row.projectId ?? null,
    workspaceId: row.workspaceId ?? null,
  };
}

/** The kind (profile row) of the run's subject, for the assignment rung. */
async function subjectProfileId(
  subjectId: string | undefined
): Promise<string | null> {
  if (!subjectId || !isLikelyUUID(subjectId)) return null;
  const [row] = await db
    .select({ profileId: entities.profileId })
    .from(entities)
    .where(eq(entities.id, subjectId))
    .limit(1);
  return row?.profileId ?? null;
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
      ? "No agent is bound for dispatch yet. Bind one to its provider — this run starts again by itself once you do."
      : "Several agents can take this work; pick the one that builds it, then run this again."
  );
  // Zero options is not a question with no answers: it is something to DO —
  // an `act` ask whose door opens agent Settings. Binding an agent there
  // re-dispatches this run (`redispatchAfterAgentBound`, the same door as an
  // answer to this slot).
  const settingsDoor = openTypedLink("settings", AGENT_SETTINGS_SECTION);
  const ask: SlotAsk =
    named.length > 0
      ? {
          mode: "choose",
          options: named.map((a) => ({
            label: a.name?.trim() || "Agent",
            value: a.id,
          })),
        }
      : {
          mode: "act",
          // An ask's url is http(s) only: a pod without PUBLIC_URL (a
          // pod-relative link) gives the steps alone, never a dead door.
          ...(/^https?:\/\//.test(settingsDoor) ? { url: settingsDoor } : {}),
          steps: ["Bind one of your agents to its provider."],
        };
  const chooseSlot: ExpectedOutput = {
    ...slot!,
    label: CHOOSE_AGENT_SLOT_LABEL,
    kind: PARAM_SLOT_KIND,
    ask,
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

/**
 * The branch a run's work lands on when its params name none: one per
 * session, `synap/<first 8 of the session id>` — so the agent never works on
 * the default branch, and two runs of one session share their branch.
 */
export function defaultRunBranch(sessionId: string): string {
  return `synap/${sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}

/**
 * The repos and branch a run carries. Two DIFFERENT fields, because they mean
 * different things to the provider:
 *   - `branch`     — a branch the run params NAME. It exists, so the provider
 *                    may check it out (mount the repo on it).
 *   - `workBranch` — the DEFAULTED per-session branch (`defaultRunBranch`). It
 *                    does not exist yet, so it is never a checkout: the repo
 *                    mounts at its default branch and the agent is told to
 *                    create this branch and push its work to it.
 * Exactly one of the two is set.
 */
function repoInputs(
  params: Record<string, unknown>,
  sessionId: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const repos = Array.isArray(params.repos)
    ? params.repos.filter((r): r is string => typeof r === "string")
    : asOptionalString(params.repo)
      ? [asOptionalString(params.repo)!]
      : [];
  if (repos.length) out.repos = repos;
  const named = asOptionalString(params.branch);
  if (named) out.branch = named;
  else out.workBranch = defaultRunBranch(sessionId);
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

    // 1. Which agent — THE route (`agent-dispatch/route.ts`): the param, then
    // the roster, then the single bound one, else the person chooses.
    const named = paramAgent(input, session);
    const choice = await route({
      ownerId,
      accept: ["dispatch"],
      selector: named ? { agentUserId: named } : null,
      roster: session.agentIds,
      // What the run is about — the assignment rung (W1b).
      targets: {
        playbook: ctx.playbookId ?? null,
        profile: await subjectProfileId(ctx.subjectId),
        project: session.projectId,
        workspace: session.workspaceId ?? ctx.workspaceId ?? null,
      },
      pool: "owned",
    });
    if (choice.kind === "refused") {
      return fail(
        `${await agentDisplayName(choice.agentUserId)} is not one of your agents bound for dispatch — bind it to its provider, or choose another agent`,
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
    // The agent the work is handed to is ON the session (roster + room), so
    // the session reads as staffed by it and a mention in the room routes to
    // it — whichever way it was chosen (param, roster, the single bound one).
    await attachSessionAgent({
      sessionId: ctx.sessionId,
      agentId: agentUserId,
      userId: ownerId,
    });

    // 2–4. Its binding, the playbook's METHOD and the task, started as the
    // agent: THE start path (`startAgentTask`), shared with the stage runner.
    const stage = ctx.currentStage
      ? (ctx.stages?.find((s) => s.key === ctx.currentStage) ?? null)
      : null;
    const started = await startAgentTask({
      agentUserId,
      ownerId,
      userId: ctx.userId,
      playbookId: ctx.playbookId,
      sessionId: ctx.sessionId,
      channelId: ctx.channelId ?? null,
      runId,
      goal: ctx.goal,
      feedback: typeof input.feedback === "string" ? input.feedback : null,
      subject: ctx.subjectId
        ? {
            id: ctx.subjectId,
            name: ctx.subjectName ?? null,
            profile: ctx.subjectProfile ?? null,
          }
        : null,
      stage,
      currentStage: ctx.currentStage ?? null,
      repo: repoInputs(input, ctx.sessionId),
      ...(runId ? { idempotencyKey: `agent-start:${runId}` } : {}),
    });
    if (started.status === "failed") return fail(started.error, started.key);
    if (started.status === "proposed") {
      await postDispatchNotice({
        channelId: ctx.channelId,
        ownerId,
        content: `Starting the ${started.service} agent needs your approval: ${started.reviewUrl}`,
        idempotencyKey: `external-agent:${runId ?? ctx.sessionId}:proposed`,
      });
      return {
        status: "proposed",
        summary: `Waiting on approval to start the ${started.service} agent`,
        externalAgent: started.externalAgent,
      };
    }
    // No link in prose: the session section carries "Open in <service>".
    await postDispatchNotice({
      channelId: ctx.channelId,
      ownerId,
      content: `Handed to the ${started.service} agent.`,
      idempotencyKey: `external-agent:${runId ?? ctx.sessionId}:started`,
    });
    return {
      status: "running",
      summary: `dispatched to ${started.service} (${started.externalAgent.externalId})`,
      externalAgent: started.externalAgent,
    };
  }
}

/** What {@link startAgentTask} did. */
export type StartAgentTaskResult =
  | {
      status: "running";
      service: string;
      externalAgent: PlaybookRunExternalAgent;
    }
  | {
      /** Governance holds the start for the person (nothing reached the provider). */
      status: "proposed";
      service: string;
      reviewUrl: string;
      proposalId: string;
      externalAgent: PlaybookRunExternalAgent;
    }
  | {
      status: "failed";
      error: string;
      /** Which step refused: the binding, the start, or a start with no task id. */
      key: "binding" | "start" | "start-no-task-id";
    };

/**
 * THE START PATH of a provider task for an agent bound for dispatch — its
 * binding (a broken one is a visible failure, never a skip), the playbook's
 * METHOD for the stage, and the binding's `start` verb called AS THE AGENT
 * (`callBindingVerb`: governed and attributed to the agent user). One path
 * for a whole run handed to an agent (`ExternalAgentExecutor.run`) and for one
 * STEP of a run handed to it (the stage runner, `enterStage`). Posts nothing:
 * each caller says what happened in its own words.
 */
export async function startAgentTask(p: {
  agentUserId: string;
  ownerId: string;
  /** The run's actor (`RunContext.userId`): whose method parts are read. */
  userId: string;
  playbookId: string | null | undefined;
  sessionId: string;
  channelId: string | null;
  runId: string | null;
  /** The task: a run's goal, or a step's. Fenced as the person's words. */
  goal: string;
  feedback?: string | null;
  subject?: { id: string; name: string | null; profile: string | null } | null;
  /** The stage the task is about: its method part. */
  stage: PlaybookStage | null;
  /** The run's current stage key, as the task names it (absent: the stage's). */
  currentStage?: string | null;
  /** The run's repository inputs (`repoInputs`), when it has any. */
  repo?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<StartAgentTaskResult> {
  const { agentUserId, ownerId } = p;
  let binding: AgentBinding | null;
  try {
    binding = await resolveAgentBinding(agentUserId);
  } catch (err) {
    if (err instanceof AgentBindingError) {
      return { status: "failed", error: err.message, key: "binding" };
    }
    throw err;
  }
  if (!binding) {
    return {
      status: "failed",
      error: `${await agentDisplayName(agentUserId)} has no dispatch binding`,
      key: "binding",
    };
  }
  const service = resolveServiceName(binding.provider);

  // The playbook's METHOD — the same text the IS kickoff and the MCP bind
  // doors render (`renderPlaybookMethod`): the approved context skill, the
  // rules this playbook follows (its guidance, stamped on the run's
  // snapshot) and the current stage. Not fenced like the goal: every part
  // of it is person-approved pod content, not the person's free words.
  const { contextSkill, guidance } = await loadRunMethodParts({
    playbookId: p.playbookId ?? undefined,
    userId: p.userId,
    runId: p.runId,
    warn: (obj, msg) => logger.warn(obj, `external-agent: ${msg}`),
  });
  const method = renderPlaybookMethod({
    contextSkill,
    guidance,
    stage: p.stage,
  });

  const origin = podPublicOrigin() ?? null;
  const params = {
    task: {
      goal: fenceUntrustedData(p.goal, "synap session goal"),
      ...(p.feedback && p.feedback.trim()
        ? {
            feedback: fenceUntrustedData(p.feedback, "synap reviewer feedback"),
          }
        : {}),
      ...(p.subject ? { subject: p.subject } : {}),
      currentStage: p.currentStage ?? p.stage?.key ?? null,
      method: method || null,
    },
    ...(p.repo ?? {}),
    sessionId: p.sessionId,
    channelId: p.channelId,
    runId: p.runId,
    capturePath: p.runId ? `/api/hub/runs/${p.runId}/capture` : null,
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
    sessionId: p.sessionId,
    channelId: p.channelId,
    ...(p.idempotencyKey ? { idempotencyKey: p.idempotencyKey } : {}),
  });

  if (started.status === "proposed") {
    return {
      status: "proposed",
      service,
      reviewUrl: started.reviewUrl,
      proposalId: started.proposalId,
      // A PENDING start (nothing reached the provider): the session section
      // shows it as "Needs you" with the proposal as its door. The approval
      // (`approved-start.ts`) records the real hand-off over it.
      externalAgent: {
        agentUserId,
        toolId: binding.toolId,
        provider: binding.provider,
        externalId: null,
        url: null,
        status: "pending_start",
        proposalId: started.proposalId,
        startedAt: new Date().toISOString(),
      },
    };
  }
  if (started.status !== "ok") {
    logger.warn(
      {
        runId: p.runId,
        agentUserId,
        toolId: binding.toolId,
        error: started.message,
      },
      "external-agent start failed"
    );
    return {
      status: "failed",
      error: `the ${service} agent did not accept the task: ${externalAgentCallFailedReason(
        {
          providerName: service,
          errorClass:
            started.status === "failed" ? started.errorClass : undefined,
          message: started.message,
        }
      )}`,
      key: "start",
    };
  }

  const { externalId, url } = externalRefFromStartResult(started.result);
  // Nothing to follow: the status poll, the wake and cancel all key on the
  // task id, so a "running" task with none could never be answered or stopped.
  if (!externalId) {
    logger.warn(
      { runId: p.runId, agentUserId, toolId: binding.toolId },
      "external-agent start returned no task id"
    );
    return {
      status: "failed",
      error: noTaskIdMessage(await agentDisplayName(agentUserId), url),
      key: "start-no-task-id",
    };
  }
  return {
    status: "running",
    service,
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
