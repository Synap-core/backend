/**
 * runPlaybook — the executor-spine runner (Phase 3).
 *
 * Turns a Playbook (config) into a live run:
 *   1. instantiateSession  — config → runtime focus_session (REUSED; no channel).
 *   2. create a channel    — the run's room, per playbook.channelSpec.
 *   3. wire session.channelId.
 *   4. insert playbook_runs — the ledger row (status "running").
 *   5. resolveExecutor(...).run(...) — dispatch to is-agent | external-agent | hybrid.
 *   6. record the result on the run row.
 *
 * This is a pure DOMAIN service — it performs NO governance. The CALLER (the
 * `playbooks.run` tRPC mutation / a scheduled job) MUST run
 * `checkPermissionOrPropose` before invoking it.
 *
 * Provenance NOTE: `session → used → capability` links are written when the
 * agent actually USES a capability, not here — so this runner records only the
 * run + its channel, never premature `used` edges.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.3-4.4).
 */

import {
  getDb,
  eq,
  channels,
  focusSessions,
  playbooks,
  playbookRuns,
} from "@synap/database";
import type {
  FocusSession,
  PlaybookRun,
  Playbook,
} from "@synap/database/schema";
import {
  ChannelType,
  ChannelScope,
  ChannelStatus,
} from "@synap/database/schema";
import type {
  CapabilityRef,
  ChannelSpec,
  GrantableKind,
  RunResult,
} from "@synap/playbooks";
import { instantiateSession } from "./playbook-lifecycle.js";
import { getLinksFor } from "../links/links-service.js";
import { resolveExecutor } from "./executors/registry.js";

export interface RunPlaybookInput {
  playbookId: string;
  workspaceId: string;
  /** The acting principal — used for session.userId, run.createdBy, channel.userId. */
  userId: string;
  params?: Record<string, unknown>;
  /** Extra agent members to add to the run channel. */
  agentIds?: string[];
  /** AI attribution — when set, the run is owned by the agent-user. */
  agentUserId?: string;
}

export interface RunPlaybookResult {
  run: PlaybookRun;
  session: FocusSession;
}

/** Map a ChannelSpec.type to the channels.channelType enum (default THREAD). */
function channelTypeFromSpec(spec: ChannelSpec | undefined) {
  switch (spec?.type) {
    case "GROUP":
      return ChannelType.GROUP;
    case "AGENT_COLLAB":
      return ChannelType.AGENT_COLLAB;
    case "THREAD":
    default:
      return ChannelType.THREAD;
  }
}

/**
 * Run a playbook end-to-end. Caller MUST gate (checkPermissionOrPropose) first.
 */
export async function runPlaybook(
  input: RunPlaybookInput
): Promise<RunPlaybookResult> {
  const db = await getDb();

  const playbook = (await db.query.playbooks.findFirst({
    where: eq(playbooks.id, input.playbookId),
  })) as Playbook | undefined;
  if (!playbook) {
    throw new Error(`Playbook ${input.playbookId} not found`);
  }

  // The owning principal: agent-user when an AI runs it, else the human.
  const actorId = input.agentUserId ?? input.userId;

  // 1. Instantiate the runtime session (no channel yet — wired below).
  const session = await instantiateSession({
    playbookId: input.playbookId,
    workspaceId: input.workspaceId,
    userId: actorId,
    params: input.params,
    agentIds: input.agentIds,
  });

  // 2. Create the run channel per channelSpec.
  // TODO(P3): full channelSpec member wiring (channel_members rows + per-member
  // caps from spec.members) — for now we create the channel and seed agentIds
  // onto the session; explicit member rows are a follow-up.
  const spec = (playbook.channelSpec ?? {}) as ChannelSpec;
  const channelType = channelTypeFromSpec(spec);
  const [channel] = await db
    .insert(channels)
    .values({
      userId: actorId,
      workspaceId: input.workspaceId,
      channelType,
      scope: ChannelScope.WORKSPACE,
      status: ChannelStatus.ACTIVE,
      title: playbook.name,
      contextObjectType: "playbook",
      contextObjectId: input.playbookId,
      metadata: { origin: "playbook-run", playbookId: input.playbookId },
    })
    .returning();

  // 3. Wire focus_sessions.channelId = the new channel.
  await db
    .update(focusSessions)
    .set({ channelId: channel.id })
    .where(eq(focusSessions.id, session.id));

  // 4. Insert the run ledger row (status "running").
  const [run] = await db
    .insert(playbookRuns)
    .values({
      workspaceId: input.workspaceId,
      playbookId: input.playbookId,
      sessionId: session.id,
      executor: playbook.executor,
      status: "running",
      input: (input.params ?? {}) as Record<string, unknown>,
      createdBy: actorId,
    })
    .returning();

  // 5. Resolve the playbook's granted capabilities (its `grants` links) into
  //    CapabilityRef[] and dispatch to the executor.
  const playbookLinks = await getLinksFor(
    actorId,
    "playbook",
    input.playbookId
  );
  const capabilities: CapabilityRef[] = playbookLinks
    .filter((l) => l.linkType === "grants" && l.fromType === "playbook")
    .map((l) => ({ kind: l.toType as GrantableKind, id: l.toId }))
    .filter(
      (c) => c.kind === "tool" || c.kind === "skill" || c.kind === "command"
    );

  let result: RunResult;
  try {
    result = await resolveExecutor(playbook.executor).run({
      workspaceId: input.workspaceId,
      userId: actorId,
      sessionId: session.id,
      channelId: channel.id,
      goal: session.goal,
      // Thread the run id so an external agent knows which run to capture back
      // against (POST /api/hub/runs/{runId}/capture); webhookUrl rides params.
      input: { ...(input.params ?? {}), runId: run.id },
      capabilities,
    });
  } catch (err) {
    result = {
      status: "failed",
      error: err instanceof Error ? err.message : "Executor threw",
    };
  }

  // 6. Record the result on the run row. Terminal statuses stamp completed_at.
  const terminal =
    result.status === "completed" ||
    result.status === "failed" ||
    result.status === "proposed";
  const [updated] = await db
    .update(playbookRuns)
    .set({
      status: result.status,
      summary: result.summary ?? null,
      error: result.error ?? null,
      completedAt: terminal ? new Date() : null,
    })
    .where(eq(playbookRuns.id, run.id))
    .returning();

  // Re-load the session so the returned row reflects the wired channelId.
  const refreshed = (await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, session.id),
  })) as FocusSession;

  return { run: updated as PlaybookRun, session: refreshed };
}
