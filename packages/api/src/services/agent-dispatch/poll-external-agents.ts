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
 *   running      ⇒ a room update when the links/summary changed;
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
 * room). A status read that governance PROPOSES pauses polling for that run
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
  focusSessions,
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
import { AgentBindingError, resolveAgentBinding } from "./agent-binding.js";
import {
  asOptionalString,
  asRecord,
  callBindingVerb,
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

/** The room line for a state — links named, state first. */
export function statusLine(provider: string, s: ExternalAgentStatus): string {
  const head =
    s.state === "needs_input"
      ? (s.summary ?? `The ${provider} agent needs your input.`)
      : s.state === "done"
        ? `The ${provider} agent finished.`
        : s.state === "failed"
          ? `The ${provider} agent stopped with an error.`
          : `The ${provider} agent is working.`;
  const parts = [head];
  if (s.state !== "needs_input" && s.summary) parts.push(s.summary);
  if (s.prUrl) parts.push(`PR: ${s.prUrl}`);
  if (s.branch) parts.push(`Branch: ${s.branch}`);
  if (s.previewUrl) parts.push(`Preview: ${s.previewUrl}`);
  if (s.url) parts.push(`Task: ${s.url}`);
  return parts.join("\n");
}

const ACTIVE = ["running", "needs_input"] as const;

/** The owed slot kind of an approval card for a provider tool call. */
export const AGENT_APPROVAL_SLOT_KIND = "agent_approval";

/** The approval card's slot label — one per provider, re-owed per call. */
export function agentApprovalSlotLabel(provider: string): string {
  return `Approve: ${provider} agent action`;
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
    p.status.summary ?? `The ${p.provider} agent is waiting for your approval.`
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

async function pollOne(
  run: PlaybookRun
): Promise<"changed" | "terminal" | "skipped" | "failed"> {
  const ext = run.externalAgent as PlaybookRunExternalAgent | null;
  if (!ext) return "skipped";
  const session = run.sessionId
    ? await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, run.sessionId),
        columns: { userId: true, channelId: true },
      })
    : null;
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
      content: `Cannot check on the ${ext.provider} agent: ${err.message}`,
      // Once per run per error code — a broken binding must not spam the room.
      idempotencyKey: `agent-poll:${run.id}:binding:${err.code}`,
    });
    logger.warn({ runId: run.id, code: err.code }, "poll: broken binding");
    return "failed";
  }
  if (!binding?.verbs.status) return "skipped";

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
      content: `Checking on the ${binding.provider} agent needs approval: ${res.reviewUrl}`,
      idempotencyKey: `agent-poll:${run.id}:proposed:${res.proposalId}`,
    });
    return "skipped";
  }
  if (res.status !== "ok") {
    logger.warn(
      { runId: run.id, message: res.message },
      "poll: the status verb failed — will retry next tick"
    );
    return "failed";
  }
  const status = normalizeExternalAgentStatus(res.result);
  if (!status) {
    logger.warn(
      { runId: run.id, result: res.result },
      "poll: unreadable status (no recognized state) — nothing changed"
    );
    return "failed";
  }

  const key = statusKey(status);
  const now = new Date().toISOString();
  const terminal = status.state === "done" || status.state === "failed";
  const next: PlaybookRunExternalAgent = {
    ...ext,
    status: status.state,
    lastState: status,
    lastStateKey: key,
    polledAt: now,
    ...(status.url && !ext.url ? { url: status.url } : {}),
  };
  delete next.pollBlockedBy;

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
  if (claimed.length === 0) {
    await db
      .update(playbookRuns)
      .set({
        externalAgent: drizzleSql`jsonb_set(${playbookRuns.externalAgent}, '{polledAt}', to_jsonb(${now}::text))`,
      })
      .where(eq(playbookRuns.id, run.id));
    return "skipped";
  }

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
  await postDispatchNotice({
    channelId,
    ownerId,
    content: statusLine(binding.provider, status),
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

  if (terminal) {
    await applyRunCapture({
      run,
      status: status.state === "done" ? "completed" : "failed",
      ...(status.state === "done" && status.summary
        ? { summary: status.summary }
        : {}),
      ...(status.state === "failed"
        ? { error: status.summary ?? `${binding.provider} reported a failure` }
        : {}),
    });
    return "terminal";
  }
  return "changed";
}
