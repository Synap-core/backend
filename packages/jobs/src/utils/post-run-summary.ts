/**
 * Run narration — the ONE door (Wave 3.N1 + 3.N2).
 *
 * Posts a single, calm summary message into an automation's run channel when a
 * run reaches a terminal state. Generalizes `proactive-post`'s message-post
 * pattern: BOT-authored, chain-root tamper hash, `/bridge/emit` realtime.
 *
 * Exactly-once: the `automation_runs.summary_message_id` column is the claim
 * slot. We generate the message id, then
 *   UPDATE automation_runs SET summary_message_id=$mid
 *   WHERE id=$runId AND summary_message_id IS NULL RETURNING id
 * and post ONLY when the claim wins — so the executor's genuine-finish,
 * no-nodes, and defensive-finalizer sites and the run reaper can all call this
 * for the same run and exactly one message is posted.
 *
 * Noise control (3.N2): per-automation `metadata.narrationMode`
 * (`always | changes | failures | off`, default `always`). `changes` posts
 * failures + the first success after a failure. Every post carries a
 * `groupKey` so feed UIs can collapse streaks.
 *
 * NEVER throws — a failure to narrate must never fail the run path. All callers
 * fire-and-forget; internal errors are logged at warn and swallowed.
 */

import { randomUUID } from "crypto";
import {
  db,
  eq,
  and,
  lt,
  ne,
  desc,
  isNull,
  automations,
  automationRuns,
  automationStepRuns,
  computeMessageHash,
  ChannelRepository,
} from "@synap/database";
import {
  messages,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import type {
  Automation,
  AutomationRun,
  AutomationStepRun,
  AutomationTriggerConfig,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { EventNames } from "@synap-core/types/events";

const logger = createLogger({ module: "post-run-summary" });

// ── Types ────────────────────────────────────────────────────────────────────

/** Per-automation narration verbosity, read from `automations.metadata.narrationMode`. */
export type NarrationMode = "always" | "changes" | "failures" | "off";

export const DEFAULT_NARRATION_MODE: NarrationMode = "always";

/** Terminal class used for copy, groupKey, and noise decisions. */
type SummaryStatus = "success" | "failure" | "timeout";

/**
 * The exactly-once claim guard: a summary posts only when this run's slot is
 * still empty. The claim UPDATE ANDs this with `id = runId`; whichever caller's
 * UPDATE returns a row wins and posts. Exported so its SHAPE is lockable in a
 * unit test (mirrors the reaper's `RUN_NOT_DELAY_SUSPENDED`).
 */
export const SUMMARY_MESSAGE_UNCLAIMED = isNull(
  automationRuns.summaryMessageId
);

export interface PostRunSummaryOptions {
  /**
   * Set by the reaper: this run never finalized itself (worker died/hung). The
   * run row reads `failed` by the time the reaper calls us, but the copy and
   * class must be "timeout", not a genuine step failure.
   */
  reason?: "timeout";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read narrationMode from an automation's metadata bag, safely defaulted. */
export function resolveNarrationMode(
  metadata: Automation["metadata"] | null | undefined
): NarrationMode {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[
    "narrationMode"
  ];
  if (raw === "changes" || raw === "failures" || raw === "off") return raw;
  return DEFAULT_NARRATION_MODE;
}

/** Fire-and-forget realtime emit via the bridge server (mirror of proactive-post). */
function emitRealtimeEvent(payload: {
  event: string;
  data: Record<string, unknown>;
  channelId: string;
  userId: string;
}): void {
  const realtimeUrl = process.env.REALTIME_URL || "http://localhost:4001";
  fetch(`${realtimeUrl}/bridge/emit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.BRIDGE_SECRET
        ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
        : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

/**
 * Resolve the channel a run's activity lands in — mirror of the executor's own
 * resolution (`executeAutomationFlow` ~L1942): an explicit trigger-bound channel
 * wins (e.g. a Discord-triggered automation posts back to its source channel),
 * otherwise the automation's durable run channel so every run lands in one room.
 */
async function resolveRunChannel(
  automation: Automation,
  run: AutomationRun
): Promise<string> {
  const triggerChannelId = (
    automation.triggerConfig as AutomationTriggerConfig | null
  )?.channelId;
  if (triggerChannelId) return triggerChannelId;

  const channel = await new ChannelRepository(db).ensureAutomationRunChannel(
    automation.id,
    automation.createdBy,
    run.workspaceId ?? undefined,
    automation.name ?? undefined
  );
  return channel.id;
}

/** Strip chip-delimiter characters so a label can never break `[[kind:id|label]]`. */
function safeLabel(text: string): string {
  return text.replace(/[[\]|]/g, "").trim() || "Automation";
}

/** Canonical entity/automation chip (message-parser `[[kind:id|label]]` form). */
function chip(
  kind: "entity" | "automation",
  id: string,
  label: string
): string {
  return `[[${kind}:${id}|${safeLabel(label)}]]`;
}

/** First non-empty line of a possibly-multiline error, trimmed. */
function firstErrorLine(err: string | null | undefined): string | null {
  if (!err) return null;
  const line = err
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? null;
}

/** Human duration between start and finish, e.g. "2.1s" — null if not derivable. */
function formatDuration(run: AutomationRun): string | null {
  if (!run.startedAt || !run.completedAt) return null;
  const ms = run.completedAt.getTime() - run.startedAt.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Harvest created-entity chips from a run's step outputs. Entity-creating output
 * nodes return `{ status: "created", entityId, title }`, persisted verbatim in
 * `automation_step_runs.output` — we scan for exactly that shape. Cap the list
 * so a fan-out loop can't produce a wall of chips.
 */
function harvestCreatedChips(steps: AutomationStepRun[], max = 5): string[] {
  const chips: string[] = [];
  for (const step of steps) {
    const out = step.output as Record<string, unknown> | null;
    if (!out || out.status !== "created") continue;
    const entityId = out.entityId;
    if (typeof entityId !== "string") continue;
    const title = typeof out.title === "string" ? out.title : "entity";
    chips.push(chip("entity", entityId, title));
    if (chips.length >= max) break;
  }
  return chips;
}

/** Compact, calm markdown for a terminal run. Exported for unit tests. */
export function renderSummary(input: {
  automation: Automation;
  run: AutomationRun;
  steps: AutomationStepRun[];
  status: SummaryStatus;
}): string {
  const { automation, run, steps, status } = input;
  const name = chip(
    "automation",
    automation.id,
    automation.name ?? "Automation"
  );

  if (status === "timeout") {
    return `⏱️ ${name} timed out — worker died or hung, no steps recorded`;
  }

  if (status === "failure") {
    const failedStep = steps.find((s) => s.status === "failed");
    const total = steps.length || run.stepsCompleted + run.stepsFailed;
    const stepName = failedStep?.nodeId ? `"${failedStep.nodeId}"` : "a step";
    const header = `⚠️ ${name} failed at step ${stepName} — ${run.stepsCompleted} of ${total} steps`;
    const error = firstErrorLine(failedStep?.errorMessage ?? run.errorMessage);
    return error ? `${header}\n${error}` : header;
  }

  // success
  const duration = formatDuration(run);
  const stepLabel = `${run.stepsCompleted} ${run.stepsCompleted === 1 ? "step" : "steps"}`;
  const header = duration
    ? `✅ ${name} ran — ${stepLabel}, ${duration}`
    : `✅ ${name} ran — ${stepLabel}`;
  const created = harvestCreatedChips(steps);
  return created.length ? `${header}\nCreated ${created.join(", ")}` : header;
}

/**
 * `changes` mode gate: a success posts only when it is the FIRST success after a
 * failure. Peek the previous terminal run (started before this one) — post iff
 * that run did not itself succeed. A first-ever run with no prior run is not a
 * "change", so it stays quiet.
 */
async function isFirstSuccessAfterFailure(
  run: AutomationRun
): Promise<boolean> {
  const prev = await db.query.automationRuns.findFirst({
    where: and(
      eq(automationRuns.automationId, run.automationId),
      ne(automationRuns.id, run.id),
      ne(automationRuns.status, "running"),
      lt(automationRuns.startedAt, run.startedAt)
    ),
    orderBy: desc(automationRuns.startedAt),
    columns: { status: true },
  });
  return !!prev && prev.status !== "completed";
}

// ── The door ───────────────────────────────────────────────────────────────────

/**
 * Post the run-narration summary for a terminal run. Idempotent, non-throwing.
 * Self-loads the run, automation, and step rows; resolves the run channel; and
 * respects the automation's `narrationMode`.
 */
export async function postRunSummary(
  runId: string,
  opts: PostRunSummaryOptions = {}
): Promise<void> {
  try {
    const run = await db.query.automationRuns.findFirst({
      where: eq(automationRuns.id, runId),
    });
    if (!run) return;
    // Cheap short-circuit; the claim below is the real exactly-once guard.
    if (run.summaryMessageId) return;
    // Only narrate a TERMINAL run. The defensive-finalizer site calls us right
    // after a guarded UPDATE that is a no-op for a delay-suspended run (row stays
    // `running`) — never narrate that as a failure. The reaper always stamps the
    // row terminal before calling, so its `timeout` path still passes here.
    if (run.status === "running") return;

    const automation = await db.query.automations.findFirst({
      where: eq(automations.id, run.automationId),
    });
    if (!automation) return;

    // Classify the terminal event. The reaper's timeout stamps the row `failed`,
    // so the explicit `reason` — not the row status — decides the timeout class.
    const status: SummaryStatus =
      opts.reason === "timeout"
        ? "timeout"
        : run.status === "completed"
          ? "success"
          : "failure";
    const isFailureClass = status !== "success";

    // ── Noise control (3.N2) ──────────────────────────────────────────────
    const mode = resolveNarrationMode(automation.metadata);
    if (mode === "off") return;
    if (mode === "failures" && !isFailureClass) return;
    if (mode === "changes" && !isFailureClass) {
      if (!(await isFirstSuccessAfterFailure(run))) return;
    }

    // Load step rows once — used for entity harvest, failure detail, and counts.
    const steps = await db.query.automationStepRuns.findMany({
      where: eq(automationStepRuns.runId, runId),
      orderBy: (t, { asc }) => asc(t.startedAt),
    });

    const content = renderSummary({ automation, run, steps, status }).trim();
    if (!content) return;

    // ── Exactly-once claim ────────────────────────────────────────────────
    // Resolve the channel and render BEFORE claiming so a late throw can't burn
    // the idempotency slot without a post. Only the DB insert + emit follow.
    const channelId = await resolveRunChannel(automation, run);

    const messageId = randomUUID();
    const claimed = await db
      .update(automationRuns)
      .set({ summaryMessageId: messageId })
      .where(and(eq(automationRuns.id, runId), SUMMARY_MESSAGE_UNCLAIMED))
      .returning({ id: automationRuns.id });
    if (claimed.length === 0) return; // another site already narrated this run.

    const messageHash = computeMessageHash(messageId, content);
    const groupKey = `runsummary.${automation.id}.${status}`;
    const messageMetadata = {
      runSummary: true,
      automationRunId: runId,
      automationId: automation.id,
      status,
      groupKey,
    };

    await db.insert(messages).values({
      id: messageId,
      channelId,
      role: MessageRole.SYSTEM,
      authorType: MessageAuthorType.BOT,
      messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
      content,
      userId: automation.createdBy,
      previousHash: "",
      hash: messageHash,
      metadata: messageMetadata as (typeof messages.$inferInsert)["metadata"],
    });

    emitRealtimeEvent({
      event: EventNames.CHAT_MESSAGE,
      data: {
        threadId: channelId,
        message: {
          id: messageId,
          threadId: channelId,
          role: MessageRole.SYSTEM,
          authorType: MessageAuthorType.BOT,
          content,
          userId: automation.createdBy,
          timestamp: new Date(),
          previousHash: "",
          hash: messageHash,
          metadata: messageMetadata,
        },
        userId: automation.createdBy,
      },
      channelId,
      userId: automation.createdBy,
    });

    logger.info(
      { runId, automationId: automation.id, status, channelId, messageId },
      "Run summary posted"
    );
  } catch (err) {
    logger.warn({ err, runId }, "Failed to post run summary (non-fatal)");
  }
}
