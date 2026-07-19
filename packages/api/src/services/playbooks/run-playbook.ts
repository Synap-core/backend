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
  entities,
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
  ChannelSpec,
  RunResult,
  InputStrategy,
  PlaybookStage,
} from "@synap/playbooks";
import { instantiateSession } from "./playbook-lifecycle.js";
import {
  resolveGrantedCapabilities,
  getLinksFor,
} from "../links/links-service.js";
import { resolveExecutor } from "./executors/registry.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "run-playbook" });
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
  /** The entity this run is about (e.g. a contact, deal, or document).
   * Stored as focus_sessions.subjectEntityId and forwarded in RunContext. */
  subjectId?: string;
  /**
   * Route the run's external output to this existing channel instead of creating
   * a new playbook channel. When set, the channel-create step is skipped and the
   * existing channel is used as the run room. Intended for delivering playbook
   * output to a client entity's team channel (branchPurpose='team') rather than
   * a throwaway playbook-scoped channel.
   *
   * The caller is responsible for ensuring the channel exists and is accessible
   * to the acting principal.
   */
  targetChannelId?: string;
}

export interface RunPlaybookResult {
  run: PlaybookRun;
  session: FocusSession;
}

/** Max runs a single `query`/`rotating` fan-out may spawn (safety bound). */
const MAX_INPUT_FANOUT = 50;

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

/** Narrow the loosely-typed JSONB `inputStrategy` column. */
function readInputStrategy(value: unknown): InputStrategy {
  if (!value || typeof value !== "object") return { kind: "none" };
  const s = value as { kind?: string };
  if (
    s.kind === "static" ||
    s.kind === "rotating" ||
    s.kind === "query" ||
    s.kind === "none"
  ) {
    return value as InputStrategy;
  }
  return { kind: "none" };
}

/**
 * Resolve a playbook's InputStrategy into the set of run items to execute.
 *
 *   - none / static-empty → exactly ONE run with the caller's params (the
 *     baseline behavior; `static` with items fans one run per item).
 *   - static  → one run per declared item.
 *   - rotating → advance a cursor stored in `playbook.metadata.inputCursor`
 *     (NO new column) and run for the CURRENT item only.
 *   - query   → TODO(P-query): resolve `sourceSubscriptionId` into a live item
 *     set. Not yet implemented — runs ONCE with the caller's params so the
 *     playbook still fires (we do NOT fabricate items).
 *
 * Returns the per-run `input` payloads, capped at MAX_INPUT_FANOUT.
 */
async function resolveInputItems(
  playbook: Playbook,
  baseParams: Record<string, unknown>
): Promise<Array<Record<string, unknown>>> {
  const strategy = readInputStrategy(playbook.inputStrategy);

  switch (strategy.kind) {
    case "none":
      return [baseParams];

    case "static": {
      const items = strategy.items ?? [];
      if (items.length === 0) return [baseParams];
      return items
        .slice(0, MAX_INPUT_FANOUT)
        .map((item) => ({ ...baseParams, item }));
    }

    case "rotating": {
      const items = strategy.items ?? [];
      if (items.length === 0) return [baseParams];
      const cursor = typeof strategy.cursor === "number" ? strategy.cursor : 0;
      const idx = ((cursor % items.length) + items.length) % items.length;
      const item = items[idx];

      // Persist the advanced cursor back into the strategy (JSONB, no new column).
      const db = await getDb();
      const nextStrategy: InputStrategy = {
        ...strategy,
        cursor: (idx + 1) % items.length,
      };
      await db
        .update(playbooks)
        .set({ inputStrategy: nextStrategy, updatedAt: new Date() })
        .where(eq(playbooks.id, playbook.id));

      return [{ ...baseParams, item }];
    }

    case "query": {
      // TODO(P-query): resolve strategy.sourceSubscriptionId → a live item set
      // (via the source_subscription's query) and fan ONE run per item, bounded
      // by MAX_INPUT_FANOUT. Until then, run once with the caller's params —
      // never fabricate items.
      logger.warn(
        {
          playbookId: playbook.id,
          sourceSubscriptionId: strategy.sourceSubscriptionId,
        },
        "inputStrategy 'query' not yet implemented — running once with caller params"
      );
      return [baseParams];
    }

    default:
      return [baseParams];
  }
}

/**
 * Run a playbook end-to-end. Caller MUST gate (checkPermissionOrPropose) first.
 *
 * Honors the playbook's `inputStrategy` (S9): `none` runs once; `static`/`query`
 * may fan one run per item (bounded); `rotating` advances a cursor and runs the
 * current item. The PRIMARY (first) run + session is returned for the stable
 * single-result contract; any additional fan-out runs execute as side effects.
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

  // S9: resolve the input strategy into per-run param payloads. The first item
  // is the primary (returned) run; the rest fan out as side effects.
  const runItems = await resolveInputItems(
    playbook,
    (input.params ?? {}) as Record<string, unknown>
  );

  const primary = await executeSingleRun(playbook, input, runItems[0]);

  // Fan-out: additional items each get their own session/channel/run. Failures
  // are logged but never abort the primary result.
  for (let i = 1; i < runItems.length; i++) {
    try {
      await executeSingleRun(playbook, input, runItems[i]);
    } catch (err) {
      logger.error(
        { err, playbookId: playbook.id, itemIndex: i },
        "Input-strategy fan-out run failed (non-fatal)"
      );
    }
  }

  return primary;
}

/**
 * Execute ONE playbook run for a single resolved param payload: instantiate a
 * session, create the run channel, record the run ledger row, and dispatch to
 * the executor. Extracted so the input-strategy fan-out reuses identical logic.
 */
async function executeSingleRun(
  playbook: Playbook,
  input: RunPlaybookInput,
  params: Record<string, unknown>
): Promise<RunPlaybookResult> {
  const db = await getDb();

  // The owning principal: agent-user when an AI runs it, else the human.
  const actorId = input.agentUserId ?? input.userId;

  // 1. Instantiate the runtime session (no channel yet — wired below).
  const session = await instantiateSession({
    playbookId: input.playbookId,
    workspaceId: input.workspaceId,
    userId: actorId,
    params,
    agentIds: input.agentIds,
    subjectId: input.subjectId ?? null,
  });

  // 2. Create the run channel per channelSpec, OR reuse an existing channel when
  // the caller specifies targetChannelId (e.g. to route output to a client entity's
  // team channel instead of a throwaway playbook channel).
  // TODO(P3): full channelSpec member wiring (channel_members rows + per-member
  // caps from spec.members) — for now we create the channel and seed agentIds
  // onto the session; explicit member rows are a follow-up.
  let channel: typeof channels.$inferSelect;
  if (input.targetChannelId) {
    const existing = await db.query.channels.findFirst({
      where: eq(channels.id, input.targetChannelId),
    });
    if (!existing) {
      throw new Error(
        `targetChannelId ${input.targetChannelId} not found — cannot run playbook against a non-existent channel`
      );
    }
    channel = existing;
  } else {
    const spec = (playbook.channelSpec ?? {}) as ChannelSpec;
    const channelType = channelTypeFromSpec(spec);
    const [created] = await db
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
    channel = created;
  }

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
      input: params,
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
  const capabilities = await resolveGrantedCapabilities(playbookLinks, {
    linkType: "grants",
    fromType: "playbook",
  });

  // Resolve the subject's name + profile so the executor can tell the agent WHAT
  // it is working on (subjectId alone is opaque). Visibility was already enforced
  // by the caller (resolveVisibleSubjectId) before this runs.
  let subjectName: string | undefined;
  let subjectProfile: string | undefined;
  if (input.subjectId) {
    const subj = await db.query.entities.findFirst({
      columns: { title: true, type: true },
      where: eq(entities.id, input.subjectId),
    });
    subjectName = subj?.title ?? undefined;
    subjectProfile = subj?.type ?? undefined;
  }

  let result: RunResult;
  try {
    result = await resolveExecutor(playbook.executor).run({
      workspaceId: input.workspaceId,
      userId: actorId,
      playbookId: playbook.id,
      sessionId: session.id,
      channelId: channel.id,
      goal: session.goal,
      subjectId: input.subjectId,
      subjectName,
      subjectProfile,
      // First-class stages: the playbook's declared stages + the session's active
      // stage key (both empty/null for a stageless, progress-only playbook).
      stages: (playbook.stages as PlaybookStage[]) ?? [],
      currentStage: session.currentStage,
      // Thread the run id so an external agent knows which run to capture back
      // against (POST /api/hub/runs/{runId}/capture); webhookUrl rides params.
      input: { ...params, runId: run.id },
      capabilities,
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, channelId: channel.id },
      "Executor run failed"
    );

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
