/**
 * agent-wake — the ONE jobs-side door that lets an automation hand work to an
 * agent in a channel, plus THE BUDGET that bounds the causal cycle doing so
 * creates.
 *
 * WHY THIS FILE EXISTS AT ALL (the IoC slot). Waking an agent means enqueuing the
 * A2AI trigger, and the ONE door for that is `triggerAutoRespond`
 * (api/src/utils/trigger-auto-respond.ts) — it owns the IS-eligible channel-type
 * gate, the focus-session resolution and the per-workspace IS routing. @synap/jobs
 * cannot import @synap/api (circular dep), and BOTH tripwires forbid re-inlining
 * the enqueue here (`api/src/__tripwires__/a2ai-one-door.test.ts` and
 * `workers/__tests__/playbook-run-one-door.test.ts`). So this is the SAME
 * inversion `registerPlaybookRunner` / `registerCapabilityExecutor` use
 * (workers/capability-dispatch.ts): jobs declares the slot, apps/api fills it at
 * boot with a thunk that calls the real door. No second copy of the pipeline.
 *
 * WHAT WAKING CLOSES. Until now an automation's `channel_message` was a terminal
 * leaf: `insertChannelMessage` writes the row and appends a `message.sent` FACT
 * (emit-message-event.ts) — it never touches the reactor bus, so no channel
 * message has ever fired an automation. Waking an agent closes a real cycle for
 * the first time:
 *
 *   automation posts → agent wakes → agent's Hub writes emit governed events →
 *   `emitSideEffects` → automation-trigger-match → another automation posts → …
 *
 * That is CrewAI's delegation ping-pong, and this repo has a recorded incident of
 * 41M tokens burned while the cost alarm read $0.00. Hence the budget below.
 */

import {
  db,
  and,
  eq,
  drizzleSql,
  agents,
  automationRuns,
  focusSessions,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { PolicyBlockedError } from "./automation-governance.js";

const logger = createLogger({ module: "agent-wake" });

// ── The IoC slot ────────────────────────────────────────────────────────────

/** Structurally mirrors api's `triggerAutoRespond` params (not imported — circular dep). */
export interface AgentWakeRequest {
  channelId: string;
  userMessageId: string;
  content: string;
  sourceUserId?: string | null;
  focusSessionId?: string | null;
  agentType?: string | null;
}

export type AgentWaker = (req: AgentWakeRequest) => Promise<boolean>;

let agentWaker: AgentWaker | null = null;

/**
 * Fill the slot at boot: `registerAgentWaker(triggerAutoRespond)`. Until this is
 * called the `wakeAgent` opt-in below THROWS rather than silently no-opping — an
 * unregistered slot is a severance, and a severance that reports success is the
 * defect class this repo suffers from most.
 */
export function registerAgentWaker(fn: AgentWaker): void {
  agentWaker = fn;
}

export function getAgentWaker(): AgentWaker | null {
  return agentWaker;
}

// ── The budget ──────────────────────────────────────────────────────────────

/**
 * WHAT ALREADY GUARDS THIS, AND WHY IT IS NOT ENOUGH ON ITS OWN.
 *
 * `automation-trigger-matcher.ts` already owns two chain guards, both keyed on
 * the causal chain (NOT per-automation), which is exactly the shape required:
 *   - `MAX_CHAIN_DEPTH = 3` — `if (currentDepth >= MAX_CHAIN_DEPTH) return;`
 *   - the self-cycle guard — `chainAutomationIds` already containing the
 *     automation id skips the match.
 * Both read `automationContext`, which `emitSideEffects` forwards verbatim.
 *
 * THE HOLE: an agent's Hub writes carry a focus session but NO
 * `automationContext`, so the chain would restart at depth 0 across the agent
 * boundary and loop unbounded. The matcher's own F2 fix already closes that —
 * `deriveSessionChainContext` re-derives the chain from
 * `focus_sessions.metadata.automationChainContext` when an event has a session
 * and no explicit context — but TODAY only `run-playbook.ts` ever writes that
 * stamp (verified: `rg automationChainContext` hits run-playbook.ts and the
 * matcher, nothing else). An automation-run session carries no stamp.
 *
 * So this module does NOT add a second counter. It (1) writes the stamp the
 * EXISTING guard already reads, so `MAX_CHAIN_DEPTH` + the cycle guard become
 * load-bearing across the agent boundary, and (2) adds the one thing the
 * existing guard genuinely lacks — a WALL-CLOCK bound, and a wake-specific hop
 * ceiling strictly INSIDE the matcher's, because an agent turn is orders of
 * magnitude more expensive than an automation hop.
 *
 * COST CEILING — deliberately absent, and this is not an oversight.
 * `automation_step_runs.cost_usd` "stays NULL until a provider reports a price —
 * honest-by-design, never a fabricated 0" (schema/automations.ts), and the token
 * columns are drained from the collector of THIS step's own IS generations. An
 * agent turn woken here is spent by the `a2ai-response-trigger` worker against
 * `chat_turns`, which the automation chain never reads. There is therefore NO
 * telemetry from which a per-chain cost ceiling could be read, and inventing one
 * would be the same fabrication the token-guard incident was about. Hops +
 * wall-clock are the two bounds that can be enforced honestly.
 */

/**
 * Maximum `chainDepth` at which a wake is still permitted. Deliberately BELOW
 * the matcher's `MAX_CHAIN_DEPTH` (3): the stamp written below records the agent
 * turn as its own hop (depth + 1), so a chain that starts at depth 0 gets ONE
 * agent wake, its consequent automation runs at depth 2, and a wake there is
 * refused. A chain is thus bounded at one — at most two — agent turns total,
 * whatever the fan-out.
 */
export const AGENT_WAKE_MAX_CHAIN_DEPTH = 2;

/**
 * Wall-clock ceiling for the WHOLE causal chain, measured from the ROOT run's
 * `started_at` (real telemetry, no new column). Bounds a chain that stays within
 * the hop ceiling but trades turns slowly — a long agent turn plus a `delay`
 * node can keep a chain alive far longer than its depth suggests.
 */
export const AGENT_WAKE_MAX_CHAIN_AGE_MS = 15 * 60 * 1000;

/**
 * A wake refused because the causal chain ran out of budget.
 *
 * Extends `PolicyBlockedError` ON PURPOSE, so it inherits the two behaviours a
 * cap MUST have here: `decideStepRetry` treats a policy block as
 * `non-retryable` (retrying a deterministic refusal only burns budget for an
 * identical verdict), and the executor finalizes the step AND the run as
 * `blocked_by_policy` — a DISTINCT terminal state, never `completed`. n8n
 * #22771 shipped the opposite (a cap that reported success); a cap that reports
 * success is a false receipt and worse than no cap.
 */
export class AgentWakeBudgetExhaustedError extends PolicyBlockedError {
  constructor(
    public readonly exhausted: "hops" | "wall_clock" | "unmeasurable",
    detail: string
  ) {
    super("deny", `agent-wake budget exhausted (${exhausted}): ${detail}`);
    this.name = "AgentWakeBudgetExhaustedError";
  }
}

export interface AgentWakeChain {
  /** Hop counter maintained along the whole causal chain by the matcher. */
  chainDepth: number;
  /** Correlation id of the causal chain — the ROOT `automation_runs.id`. */
  rootRunId: string;
  /** This run — the wall-clock fallback when the root row is unreadable. */
  automationRunId: string;
  automationId: string;
  chainAutomationIds?: string[];
}

/**
 * Resolve the requested agent selector to a real, ACTIVE agent slug — or throw.
 *
 * The sibling door for the same vocabulary, `is-agent-executor.ts`, resolves the
 * slug and FAILS the run on an unknown one, with the comment "falling back to
 * 'meta' here is the one thing this must never do — the user would read a
 * completed run and believe the specialist they named had answered it". This
 * path used to forward `config.agentType` verbatim to `triggerAutoRespond`,
 * which trims it and otherwise defaults to "meta". So a typo'd `agentType` on a
 * `channel_message` node produced exactly the outcome the sibling door refuses.
 * One vocabulary, two doors, and now one behaviour.
 *
 * Called from the PRE-FLIGHT, before the message is posted: an unknown selector
 * is knowable in advance, so it must not cost a handoff message first.
 *
 * Absent selector ⇒ `null` ⇒ `triggerAutoRespond`'s own "meta" default, which is
 * the unchanged pre-existing behaviour and NOT a fallback from a named agent.
 */
export async function resolveWakeAgentType(
  requested?: string | null
): Promise<string | null> {
  const slug = requested?.trim();
  if (!slug) return null;
  const [row] = await db
    .select({ slug: agents.slug })
    .from(agents)
    .where(and(eq(agents.slug, slug), eq(agents.active, true)))
    .limit(1);
  if (!row) {
    throw new AgentWakeBudgetExhaustedError(
      "unmeasurable",
      `unknown agent "${slug}" — no active agents row with that slug (the IS syncs its roster via POST /api/hub/agents/sync). Refusing to post a handoff that would be answered by a different agent than the one named.`
    );
  }
  return row.slug;
}

/**
 * Throw unless this causal chain may still spend an agent turn. Call BEFORE any
 * effect: an exhausted chain must post no message at all, so the step's only
 * outcome is the distinct failure.
 *
 * EVERY precondition for a wake lives here, and that is the point. Two of them
 * used to be checked inside `wakeAgentAtMessage` — i.e. AFTER
 * `insertChannelMessage` — so a run with no registered waker, or no focus
 * session, posted the handoff and only then refused to wake it: the exact false
 * receipt the paragraph above forbids, one branch over. A precondition that can
 * be evaluated before the effect must be evaluated before the effect.
 */
export async function assertAgentWakeBudget(
  chain: AgentWakeChain,
  /**
   * The run's focus session. Absent ⇒ refused HERE: without a session there is
   * nowhere to stamp the chain, so the matcher's depth guard would restart at 0
   * across the agent boundary and the cycle would be unbounded.
   */
  focusSessionId?: string | null
): Promise<void> {
  // The slot must already be filled. An unregistered waker is a boot-time
  // severance, not a per-run condition — but it is knowable before the effect,
  // so it is refused before the effect.
  if (!getAgentWaker()) {
    throw new AgentWakeBudgetExhaustedError(
      "unmeasurable",
      "no agent waker is registered — apps/api must call registerAgentWaker(triggerAutoRespond) at boot. Refusing to post a handoff that nothing could answer."
    );
  }

  if (!focusSessionId) {
    throw new AgentWakeBudgetExhaustedError(
      "unmeasurable",
      "this run has no focus session, so the causal chain cannot be carried across the agent boundary (the matcher's depth guard would restart at 0) — refusing to wake an agent on an untrackable chain."
    );
  }

  if (chain.chainDepth >= AGENT_WAKE_MAX_CHAIN_DEPTH) {
    throw new AgentWakeBudgetExhaustedError(
      "hops",
      `causal chain ${chain.rootRunId} is at hop ${chain.chainDepth} (ceiling ${AGENT_WAKE_MAX_CHAIN_DEPTH}) — refusing to wake another agent. An automation may hand work to an agent, but the handoff may not ping-pong.`
    );
  }

  // Wall clock, measured on the chain's ROOT run. Falls back to THIS run when
  // the root row is gone (a cascade-deleted automation), and FAILS CLOSED when
  // neither is readable: a wake whose chain age cannot be measured has no
  // enforceable budget, and failing open is how a guard becomes decoration.
  const startedAt = await chainStartedAt(chain);
  if (!startedAt) {
    throw new AgentWakeBudgetExhaustedError(
      "unmeasurable",
      `neither the root run (${chain.rootRunId}) nor this run (${chain.automationRunId}) could be read, so the chain's age is unknown — refusing to wake an agent on an unbounded chain.`
    );
  }
  const ageMs = Date.now() - startedAt.getTime();
  if (ageMs >= AGENT_WAKE_MAX_CHAIN_AGE_MS) {
    throw new AgentWakeBudgetExhaustedError(
      "wall_clock",
      `causal chain ${chain.rootRunId} started ${Math.round(ageMs / 1000)}s ago (ceiling ${Math.round(AGENT_WAKE_MAX_CHAIN_AGE_MS / 1000)}s) — refusing to wake another agent.`
    );
  }
}

async function chainStartedAt(chain: AgentWakeChain): Promise<Date | null> {
  for (const runId of [chain.rootRunId, chain.automationRunId]) {
    if (!runId) continue;
    const row = await db.query.automationRuns.findFirst({
      where: eq(automationRuns.id, runId),
      columns: { startedAt: true },
    });
    if (row?.startedAt) return row.startedAt;
  }
  return null;
}

/**
 * Stamp the causal chain onto the focus session the agent will run in, in the
 * EXACT shape `deriveSessionChainContext` (automation-trigger-matcher.ts) reads.
 * This is what makes the existing `MAX_CHAIN_DEPTH` + self-cycle guards survive
 * the agent boundary instead of resetting to depth 0.
 *
 *  - `chainDepth: chainDepth + 1` — the agent turn IS a hop, so whatever the
 *    agent's writes fire runs one deeper than this automation did.
 *  - `chainAutomationIds` gains THIS automation, so the agent's writes can never
 *    re-fire the automation that woke it (the matcher's self-cycle guard).
 *
 * Merged with jsonb `||` so it cannot clobber the rest of the session metadata
 * (grantStatus etc.). Non-throwing is NOT an option here: without the stamp the
 * budget is severed, so a failure propagates and the wake does not happen.
 */
export async function stampChainContextOnSession(
  focusSessionId: string,
  chain: AgentWakeChain
): Promise<void> {
  const automationChainContext = {
    automationRunId: chain.automationRunId,
    automationId: chain.automationId,
    chainDepth: chain.chainDepth + 1,
    rootRunId: chain.rootRunId,
    chainAutomationIds: Array.from(
      new Set([...(chain.chainAutomationIds ?? []), chain.automationId])
    ),
  };
  await db
    .update(focusSessions)
    .set({
      // postgres.js `sql.json()` is broken on the pod image — JSON.stringify +
      // an explicit ::jsonb cast is the house pattern (see session_update).
      metadata: drizzleSql`coalesce(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
        { automationChainContext }
      )}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(focusSessions.id, focusSessionId));
}

/**
 * Wake an agent at an already-posted message. Budget must ALREADY have been
 * asserted (before the message was posted) — this re-asserts nothing, it only
 * stamps and dispatches.
 *
 * Returns nothing: it either woke an agent or threw. A wake that could not be
 * dispatched must never be reported as a delivered handoff.
 */
export async function wakeAgentAtMessage(input: {
  channelId: string;
  messageId: string;
  content: string;
  /** The automation's owning principal — the message's author. */
  ownerId: string;
  /** The automation run's focus session, when it has one. */
  focusSessionId?: string | null;
  agentType?: string | null;
  chain: AgentWakeChain;
}): Promise<void> {
  // Both of these were PROVEN by `assertAgentWakeBudget` before the message was
  // posted. They remain as internal invariants — reaching either means a caller
  // skipped the pre-flight, which is a bug in the caller, not a runtime
  // condition to handle gracefully.
  const waker = getAgentWaker();
  if (!waker || !input.focusSessionId) {
    throw new Error(
      "channel_message wakeAgent: reached wakeAgentAtMessage without a registered waker or a focus session — assertAgentWakeBudget must be called BEFORE the message is posted."
    );
  }

  await stampChainContextOnSession(input.focusSessionId, input.chain);

  const woke = await waker({
    channelId: input.channelId,
    userMessageId: input.messageId,
    content: input.content,
    sourceUserId: input.ownerId,
    focusSessionId: input.focusSessionId,
    agentType: input.agentType ?? null,
  });
  if (!woke) {
    // triggerAutoRespond returns false for a non-IS-eligible channel type or a
    // failed enqueue. Both mean the handoff is sitting unanswered — a step
    // failure, exactly as IsAgentExecutor treats the same false.
    throw new Error(
      `channel_message wakeAgent: IS auto-respond could not be triggered for channel ${input.channelId} (channel not IS-eligible, or the IS could not be resolved) — the message was posted but no agent will answer it.`
    );
  }
  logger.info(
    {
      channelId: input.channelId,
      messageId: input.messageId,
      rootRunId: input.chain.rootRunId,
      chainDepth: input.chain.chainDepth,
    },
    "automation channel_message woke an agent"
  );
}
