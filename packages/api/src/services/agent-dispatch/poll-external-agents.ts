/**
 * THE STATUS POLL — for every live run handed to an external agent, ask the
 * binding's `status` verb where the task stands, and put what changed in the
 * room.
 *
 * Status in v1 is AGNOSTIC (no provider webhooks): the agent may post in the
 * room itself through Synap MCP, and this poll reads the binding's `status`
 * verb while the run is active, normalized to
 *
 *   { state: 'running' | 'needs_input' | 'done' | 'failed',
 *     url?, prUrl?, branch?, previewUrl?, summary? }
 *
 * and maps it:
 *   running      ⇒ a short room line when the state or an output changed
 *                  (a summary-only change updates the section, not the room);
 *   needs_input  ⇒ a QUESTION card posted AS the agent (the owner's reply
 *                  answers it and wakes the agent through `send`);
 *   done/failed  ⇒ the run capture (`applyRunCapture`, the same write as
 *                  `POST /runs/:id/capture`) + a room update; polling stops.
 *
 * IDEMPOTENT: each normalized state is fingerprinted; the run's
 * `external_agent.lastStateKey` is CLAIMED atomically (a conditional UPDATE),
 * and only the claimer posts — with a deterministic message id from the same
 * fingerprint. Two overlapping ticks post once; an unchanged state posts
 * nothing.
 *
 * A binding with no `status` verb is not polled (its agent reports through the
 * room) — its run is only stamped, so it sorts behind every other live run. A status read that governance PROPOSES pauses polling for that run
 * until the proposal is decided (`pollBlockedBy`) — never a proposal per tick.
 *
 * This is the pod's own bookkeeping of a run it dispatched, so it applies the
 * capture directly (no agent-attributed proposal): the agent's provider is the
 * reporter, the run row is the pod's ledger.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  playbookRuns,
  proposals,
  liveRunStatusWhere,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type {
  ExternalAgentState,
  PlaybookRun,
  PlaybookRunExternalAgent,
} from "@synap/database/schema";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { AgentBindingError, resolveAgentBinding } from "./agent-binding.js";
import {
  asOptionalString,
  asRecord,
  callBindingVerb,
  loadSessionRoom,
  postDispatchNotice,
} from "./binding-call.js";
import { applyRunCapture } from "../runs/apply-run-capture.js";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import { updateExpectedOutputsLocked } from "../focus-sessions/delegate-output.js";

const logger = createLogger({ module: "agent-dispatch/poll" });

export const EXTERNAL_AGENT_STATES = [
  "running",
  "needs_input",
  "done",
  "failed",
] as const satisfies readonly ExternalAgentState[];

/** The normalized `status` verb result. */
export interface ExternalAgentStatus {
  state: ExternalAgentState;
  url?: string;
  prUrl?: string;
  branch?: string;
  previewUrl?: string;
  summary?: string;
  /**
   * `needs_input` only: the ONE provider tool call waiting for a person's
   * approval (e.g. a Managed Agents `always_ask` push). It rides on the
   * approval card; only a typed approve / reject of that card settles it.
   */
  confirmationId?: string;
}

/** A provider event id — an opaque token, never free text. */
const CONFIRMATION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Normalize a provider's `status` result. `null` = unreadable (no recognized
 * `state`) — the caller logs it and changes nothing; it is never guessed.
 */
export function normalizeExternalAgentStatus(
  raw: unknown
): ExternalAgentStatus | null {
  const r = asRecord(raw);
  const state = r.state;
  if (
    typeof state !== "string" ||
    !(EXTERNAL_AGENT_STATES as readonly string[]).includes(state)
  ) {
    return null;
  }
  const out: ExternalAgentStatus = { state: state as ExternalAgentState };
  for (const key of [
    "url",
    "prUrl",
    "branch",
    "previewUrl",
    "summary",
  ] as const) {
    const v = asOptionalString(r[key]);
    if (v) out[key] = key === "summary" ? v.slice(0, 4000) : v.slice(0, 2000);
  }
  const confirmationId = asOptionalString(r.confirmationId);
  if (
    out.state === "needs_input" &&
    confirmationId &&
    CONFIRMATION_ID_RE.test(confirmationId)
  ) {
    out.confirmationId = confirmationId;
  }
  return out;
}

/** Stable fingerprint of a normalized status (key order fixed). */
export function statusKey(s: ExternalAgentStatus): string {
  const canonical = JSON.stringify([
    s.state,
    s.url ?? null,
    s.prUrl ?? null,
    s.branch ?? null,
    s.previewUrl ?? null,
    s.summary ?? null,
    // Appended only when present, so a state without one keeps its old key.
    ...(s.confirmationId ? [s.confirmationId] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/**
 * What a room line is posted FOR: the state, the outputs (PR, branch,
 * preview) and a waiting tool call. A summary-only change is stored for the
 * session section (the source of truth) but never posted.
 */
function postKeyOf(s: ExternalAgentStatus | undefined | null): string | null {
  if (!s) return null;
  return JSON.stringify([
    s.state,
    s.prUrl ?? null,
    s.branch ?? null,
    s.previewUrl ?? null,
    s.confirmationId ?? null,
  ]);
}

/** One line, no links in prose (the section carries every door), capped. */
function oneLine(text: string | undefined, max: number): string | null {
  const line = (text ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .split(/[\r\n]+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * The room line for a status change — short, state first, never a link dump.
 * `null` ⇒ post nothing: neither the state nor an output changed since the
 * last read (`prev`), so the section alone says it.
 *   needs_input ⇒ the agent's question (one line), else "Needs your answer";
 *   done        ⇒ "Finished";
 *   failed      ⇒ "Failed: <one-line reason>";
 *   running     ⇒ what it newly produced ("Opened pull request", …), else
 *                 "Working" (back to work after a question).
 */
export function statusLine(
  s: ExternalAgentStatus,
  prev?: ExternalAgentStatus | null
): string | null {
  if (postKeyOf(s) === postKeyOf(prev)) return null;
  switch (s.state) {
    case "needs_input":
      return oneLine(s.summary, 280) ?? "Needs your answer";
    case "done":
      return "Finished";
    case "failed": {
      const why = oneLine(s.summary, 160);
      return why ? `Failed: ${why}` : "Failed";
    }
    case "running":
      if (s.prUrl && s.prUrl !== prev?.prUrl) return "Opened pull request";
      if (s.previewUrl && s.previewUrl !== prev?.previewUrl)
        return "Posted a preview";
      if (s.branch && s.branch !== prev?.branch) return "Pushed a branch";
      return "Working";
  }
}

/** Fields an output is reported under, on `lastState` and `reportedAt`. */
const OUTPUT_FIELDS = ["prUrl", "branch", "previewUrl"] as const;

/**
 * When the agent FIRST reported each output it reports now: kept while the
 * value is unchanged, `now` for a new or changed one, dropped once it is gone.
 */
export function outputsReportedAt(
  ext: Pick<PlaybookRunExternalAgent, "lastState" | "reportedAt">,
  s: ExternalAgentStatus,
  now: string
): NonNullable<PlaybookRunExternalAgent["reportedAt"]> {
  const out: NonNullable<PlaybookRunExternalAgent["reportedAt"]> = {};
  for (const k of OUTPUT_FIELDS) {
    const v = s[k];
    if (!v) continue;
    const kept = ext.lastState?.[k] === v ? ext.reportedAt?.[k] : undefined;
    out[k] = kept ?? now;
  }
  return out;
}

const ACTIVE = ["running", "needs_input"] as const;

/** The owed slot kind of an approval card for a provider tool call. */
export const AGENT_APPROVAL_SLOT_KIND = "agent_approval";

/** The approval card's slot label — one per provider, re-owed per call. */
export function agentApprovalSlotLabel(provider: string): string {
  return `Approve: ${resolveServiceName(provider)} agent action`;
}

/**
 * Owe the person the approval card's confirm slot. Re-owed FRESH for each
 * call (any earlier card of this provider — answered or stale — is replaced),
 * so the ask the person answers is always the call the agent is waiting on.
 */
async function oweAgentApprovalSlot(p: {
  sessionId: string;
  provider: string;
  status: ExternalAgentStatus;
}): Promise<{ label: string; ask: SlotAsk } | null> {
  const label = agentApprovalSlotLabel(p.provider);
  const why = (
    p.status.summary ??
    `The ${resolveServiceName(p.provider)} agent is waiting for your approval.`
  ).slice(0, 500);
  const ask: SlotAsk = { mode: "confirm", prompt: why };
  const slot: ExpectedOutput = {
    kind: AGENT_APPROVAL_SLOT_KIND,
    label,
    owner: "human",
    blockedReason: "decision",
    why,
    owedSince: new Date().toISOString(),
    ask,
  };
  const wanted = normalizeExpectedLabel(label);
  const written = await updateExpectedOutputsLocked(p.sessionId, (current) => [
    ...current.filter((o) => normalizeExpectedLabel(o?.label) !== wanted),
    slot,
  ]);
  return written ? { label, ask } : null;
}

export interface PollSummary {
  scanned: number;
  changed: number;
  terminal: number;
  skipped: number;
  failed: number;
}

/** Poll every live dispatched run once. */
export async function pollExternalAgentRuns(
  opts: { limit?: number } = {}
): Promise<PollSummary> {
  const rows = await db
    .select()
    .from(playbookRuns)
    .where(
      and(
        liveRunStatusWhere(playbookRuns.status),
        drizzleSql`${playbookRuns.externalAgent} IS NOT NULL`,
        inArray(drizzleSql<string>`${playbookRuns.externalAgent}->>'status'`, [
          ...ACTIVE,
        ])
      )
    )
    // Least-recently polled first: every selected run is stamped below, so a
    // tick never re-reads the same 100 while newer runs wait (a run whose
    // binding has no status verb, or whose read keeps failing, goes to the
    // back like any other).
    .orderBy(
      drizzleSql`${playbookRuns.externalAgent}->>'polledAt' ASC NULLS FIRST`
    )
    .limit(opts.limit ?? 100);
  const summary: PollSummary = {
    scanned: rows.length,
    changed: 0,
    terminal: 0,
    skipped: 0,
    failed: 0,
  };
  for (const run of rows) {
    try {
      const out = await pollOne(run as PlaybookRun);
      summary[out] += 1;
    } catch (err) {
      summary.failed += 1;
      logger.error({ err, runId: run.id }, "external agent poll: run threw");
    }
  }
  return summary;
}

/**
 * A status read that failed: count it on the run (first seen, how many in a
 * row, the last reason) — the view's "Can't reach <service>" reads it. Atomic,
 * and only on a LIVE run (never written over a verdict).
 */
async function recordPollError(
  runId: string,
  message: string,
  now: string
): Promise<void> {
  const col = playbookRuns.externalAgent;
  await db
    .update(playbookRuns)
    .set({
      externalAgent: drizzleSql`jsonb_set(${col}, '{pollError}', jsonb_build_object(
        'firstSeenAt', coalesce(${col}->'pollError'->>'firstSeenAt', ${now}::text),
        'count', coalesce((${col}->'pollError'->>'count')::int, 0) + 1,
        'message', ${message.slice(0, 500)}::text))`,
    })
    .where(
      and(eq(playbookRuns.id, runId), liveRunStatusWhere(playbookRuns.status))
    );
}

async function pollOne(
  run: PlaybookRun
): Promise<"changed" | "terminal" | "skipped" | "failed"> {
  const ext = run.externalAgent as PlaybookRunExternalAgent | null;
  if (!ext) return "skipped";
  // Stamp the visit FIRST, whatever happens below (no status verb, a pending
  // proposal, a failed read): the selection orders on it.
  const now = new Date().toISOString();
  await db
    .update(playbookRuns)
    .set({
      externalAgent: drizzleSql`jsonb_set(${playbookRuns.externalAgent}, '{polledAt}', to_jsonb(${now}::text))`,
    })
    .where(
      and(eq(playbookRuns.id, run.id), liveRunStatusWhere(playbookRuns.status))
    );
  const session = await loadSessionRoom(run.sessionId);
  const ownerId = session?.userId ?? run.createdBy;
  const channelId = session?.channelId ?? null;

  // A proposed status read pauses polling until it is decided.
  if (ext.pollBlockedBy) {
    const [p] = await db
      .select({ status: proposals.status })
      .from(proposals)
      .where(eq(proposals.id, ext.pollBlockedBy))
      .limit(1);
    if (p?.status === ProposalStatus.PENDING) return "skipped";
  }

  let binding;
  try {
    binding = await resolveAgentBinding(ext.agentUserId);
  } catch (err) {
    if (!(err instanceof AgentBindingError)) throw err;
    await postDispatchNotice({
      channelId,
      ownerId,
      content: `Cannot check on the ${resolveServiceName(ext.provider)} agent: ${err.message}`,
      // Once per run per error code — a broken binding must not spam the room.
      idempotencyKey: `agent-poll:${run.id}:binding:${err.code}`,
    });
    logger.warn({ runId: run.id, code: err.code }, "poll: broken binding");
    return "failed";
  }
  if (!binding?.verbs.status) return "skipped";
  const service = resolveServiceName(binding.provider);

  const res = await callBindingVerb({
    binding,
    verb: "status",
    agentUserId: ext.agentUserId,
    ownerId,
    parameters: {
      externalId: ext.externalId,
      runId: run.id,
      sessionId: run.sessionId,
    },
    sessionId: run.sessionId,
    channelId,
  });
  if (res.status === "proposed") {
    await db
      .update(playbookRuns)
      .set({
        externalAgent: { ...ext, pollBlockedBy: res.proposalId },
      })
      .where(
        and(
          eq(playbookRuns.id, run.id),
          liveRunStatusWhere(playbookRuns.status)
        )
      );
    await postDispatchNotice({
      channelId,
      ownerId,
      content: `Checking on the ${service} agent needs approval: ${res.reviewUrl}`,
      idempotencyKey: `agent-poll:${run.id}:proposed:${res.proposalId}`,
    });
    return "skipped";
  }
  if (res.status !== "ok") {
    logger.warn(
      { runId: run.id, message: res.message },
      "poll: the status verb failed — will retry next tick"
    );
    await recordPollError(run.id, res.message, now);
    return "failed";
  }
  const status = normalizeExternalAgentStatus(res.result);
  if (!status) {
    logger.warn(
      { runId: run.id, result: res.result },
      "poll: unreadable status (no recognized state) — nothing changed"
    );
    await recordPollError(run.id, "unreadable status", now);
    return "failed";
  }
  // A good read clears the failure streak — even when nothing else changed
  // (an unchanged state never reaches the claim below).
  if (ext.pollError) {
    await db
      .update(playbookRuns)
      .set({
        externalAgent: drizzleSql`${playbookRuns.externalAgent} - 'pollError'`,
      })
      .where(
        and(
          eq(playbookRuns.id, run.id),
          liveRunStatusWhere(playbookRuns.status)
        )
      );
  }

  const key = statusKey(status);
  const terminal = status.state === "done" || status.state === "failed";
  const next: PlaybookRunExternalAgent = {
    ...ext,
    status: status.state,
    lastState: status,
    lastStateKey: key,
    polledAt: now,
    reportedAt: outputsReportedAt(ext, status, now),
    ...(status.url && !ext.url ? { url: status.url } : {}),
  };
  delete next.pollBlockedBy;
  delete next.pollError;

  // CLAIM the state change atomically — only the claimer posts. `next` is
  // built from the copy this tick READ, so the claim also requires the run to
  // be still LIVE: a cancel that landed in between keeps its `cancelled`
  // (the read copy would otherwise write `running`/`done` back over it).
  const claimed = await db
    .update(playbookRuns)
    .set({ externalAgent: next })
    .where(
      and(
        eq(playbookRuns.id, run.id),
        liveRunStatusWhere(playbookRuns.status),
        drizzleSql`(${playbookRuns.externalAgent}->>'lastStateKey') IS DISTINCT FROM ${key}`
      )
    )
    .returning({ id: playbookRuns.id });
  if (claimed.length === 0) return "skipped";

  // Everything below must land for the claim to be true. If it throws (a DB
  // error mid-capture), RELEASE the claim — back to the copy this tick read —
  // so the next tick retries: the selection only re-reads a `running` /
  // `needs_input` run whose key differs, so a kept claim would strand a
  // terminal run live forever. The notice and capture are idempotent, so the
  // retry repeats nothing.
  try {
    // A tool call waiting for approval is an APPROVAL CARD: an owed confirm
    // slot, and the question filed on it carries the call's id. Only a typed
    // approve / reject of that card settles the call (the answer door wakes the
    // agent with a decision naming it) — a reply in words never does.
    const approval =
      status.state === "needs_input" && status.confirmationId && run.sessionId
        ? await oweAgentApprovalSlot({
            sessionId: run.sessionId,
            provider: binding.provider,
            status,
          })
        : null;
    const line = statusLine(status, ext.lastState);
    if (line) {
      await postDispatchNotice({
        channelId,
        ownerId,
        content: line,
        idempotencyKey: `agent-poll:${run.id}:${key}`,
        asAgentUserId: ext.agentUserId,
        kind: status.state === "needs_input" ? "question" : "update",
        ...(approval
          ? {
              slotLabel: approval.label,
              ask: approval.ask,
              confirmationId: status.confirmationId,
            }
          : {}),
      });
    }

    if (terminal) {
      await applyRunCapture({
        run,
        status: status.state === "done" ? "completed" : "failed",
        ...(status.state === "done" && status.summary
          ? { summary: status.summary }
          : {}),
        ...(status.state === "failed"
          ? {
              error: status.summary ?? `${service} reported a failure`,
            }
          : {}),
      });
      return "terminal";
    }
    return "changed";
  } catch (err) {
    await db
      .update(playbookRuns)
      .set({ externalAgent: ext })
      .where(
        and(
          eq(playbookRuns.id, run.id),
          // Never over a verdict: a cancel that landed after the claim keeps it.
          liveRunStatusWhere(playbookRuns.status),
          drizzleSql`(${playbookRuns.externalAgent}->>'lastStateKey') = ${key}`
        )
      );
    throw err;
  }
}
