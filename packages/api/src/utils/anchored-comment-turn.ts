/**
 * anchored-comment-turn — what an anchored HUMAN comment means for the agent
 * (founder decision D19 amended, intake plan §4.1 "Comments anywhere").
 *
 * A comment in a session's channel may carry `metadata.anchor` (contract:
 * `message-anchor.ts`). This module answers the two questions the send door
 * needs, from ONE read of the rows:
 *
 *   1. SHOULD the comment wake an agent even though no agent is assigned or
 *      mentioned? Yes when the channel belongs to an intake run
 *      (`metadata.run` / `metadata.intake` on a session bound to the channel),
 *      or when the anchor names a PENDING proposal of a session bound to the
 *      channel. Anything else keeps the channel's existing rule. The caller
 *      dispatches through `triggerAutoRespond` — the one door — and only for a
 *      HUMAN-authored message (an agent's anchored message never loops).
 *
 *   2. WHAT does the anchor point at, in words the agent can act on? The
 *      proposal id + status, the op named by `opRef` (kind / title / profile /
 *      field keys, read from `proposals.data`), the field, and whether the
 *      comment is STALE — `contentVersion` is the `revisionHistory.length` the
 *      commenter saw; a different current length means the proposal was revised
 *      after they looked, so the agent must say so rather than silently apply
 *      the comment to content the user never saw.
 *
 * The resolved context rides the EXISTING `turnContext` contract as the
 * `anchor` sibling (IS: `routes/chat-stream.ts` `TurnContextAnchorSchema`). It
 * is SERVER-OWNED: the client input schema (`channels/helpers.ts`) does not
 * accept it, so a caller can never forge "this comment is about proposal X".
 *
 * Every string is bounded here so the IS schema's caps can never reject a turn
 * the pod already persisted (the 2026-08-20 contract-fork failure mode).
 */

import { db as defaultDb, eq } from "@synap/database";
import { focusSessions, proposals, users } from "@synap/database/schema";
import {
  isCompositeProposalData,
  opRef as positionalOpRef,
  PRIMARY_REF,
} from "@synap-core/types/proposals";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import { askFingerprint } from "@synap-core/types/ask";
import { normalizeExpectedLabel } from "../services/focus-sessions/expected-label.js";
import type { MessageAnchor, SessionSlotAnchor } from "./message-anchor.js";

type Database = typeof defaultDb;

export const ANCHOR_TURN_CONTEXT_VERSION = 1 as const;
/** Caps — mirrored by `TurnContextAnchorSchema` in the IS. Keep in step. */
export const ANCHOR_COMMENT_MAX = 1_000;
export const ANCHOR_TITLE_MAX = 200;
export const ANCHOR_FIELD_KEYS_MAX = 20;
export const ANCHOR_FIELD_KEY_MAX = 64;

/** Why the anchor did (not) resolve — a failed lookup is never "resolved". */
export type AnchorResolution =
  | "resolved"
  | "no_proposal"
  | "proposal_not_found"
  | "op_not_found"
  // A `session_slot` anchor (`planSlotAnchorTurn`).
  | "slot_resolved"
  | "slot_not_found";

/** Caps for the slot half — mirrored by the IS `TurnContextAnchorSchema`. */
export const ANCHOR_SLOT_TEXT_MAX = 1_000;

/**
 * The slot a `session_slot` anchor names, in words the agent can act on.
 * Everything free-text here is AGENT- or person-authored reference data; the
 * IS renders it as untrusted context, never as instructions.
 */
export interface AnchorSlotContext {
  sessionId: string;
  label: string;
  kind: string;
  /** `human` = the person owes it; `agent` = it is (back) with an agent. */
  owner: "human" | "agent";
  status: string;
  blockedReason: string | null;
  /** The agent's own words for what it needs. */
  why: string | null;
  /** The ask, rendered to one bounded line (`describeAskForTurn`). */
  ask: { mode: string; text: string } | null;
  /** Where the slot points: an http(s) link or an in-pod `kind:id`. */
  ref: string | null;
  /** True iff the agent changed the ask since the person opened it. */
  askChanged: boolean;
}

export interface AnchorTurnContext {
  version: typeof ANCHOR_TURN_CONTEXT_VERSION;
  resolution: AnchorResolution;
  proposalId: string | null;
  proposalStatus: string | null;
  opRef: string | null;
  op: {
    index: number;
    kind: string;
    title: string | null;
    profileSlug: string | null;
    fieldKeys: string[];
  } | null;
  field: string | null;
  /** The revision the commenter saw. */
  contentVersion: number;
  /** The proposal's revision now (`revisionHistory.length`); null when unknown. */
  currentVersion: number | null;
  /** True iff the proposal was revised since the commenter saw it. */
  stale: boolean;
  comment: string;
  /**
   * Present ONLY for a `session_slot` anchor — absent (not null) on a proposal
   * anchor, so every proposal turn stays byte-identical to before.
   */
  slot?: AnchorSlotContext | null;
}

export type AnchoredCommentTrigger =
  | { trigger: false; reason: "not_session_channel" | "not_run_or_pending" }
  | {
      trigger: true;
      reason: "intake_run" | "pending_proposal" | "session_slot";
      /** Agent type that produced the anchored proposal; undefined = default. */
      agentType?: string;
    };

export interface AnchoredCommentPlan {
  context: AnchorTurnContext;
  decision: AnchoredCommentTrigger;
}

const clip = (value: string, max: number) =>
  value.length > max ? value.slice(0, max) : value;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The op an `opRef` names: `$opN`, an op's own `ref`, or `$primary`. */
function findOp(data: unknown, ref: string): AnchorTurnContext["op"] {
  if (!isCompositeProposalData(data as never)) return null;
  const operations = (data as { operations: unknown[] }).operations;
  let firstEntityIndex = -1;
  for (let index = 0; index < operations.length; index++) {
    const op = asRecord(operations[index]);
    if (!op) continue;
    const isEntity = op.op === "create_entity";
    if (isEntity && firstEntityIndex === -1) firstEntityIndex = index;
    const matches =
      op.ref === ref ||
      (isEntity && positionalOpRef(index) === ref) ||
      (isEntity && ref === PRIMARY_REF && index === firstEntityIndex);
    if (!matches) continue;
    const titleSource =
      typeof op.title === "string"
        ? op.title
        : typeof op.name === "string"
          ? op.name
          : typeof op.type === "string"
            ? op.type
            : null;
    const properties = asRecord(op.properties);
    return {
      index,
      kind: typeof op.op === "string" ? op.op : "unknown",
      title: titleSource ? clip(titleSource, ANCHOR_TITLE_MAX) : null,
      profileSlug:
        typeof op.profileSlug === "string"
          ? clip(op.profileSlug, ANCHOR_FIELD_KEY_MAX)
          : null,
      fieldKeys: properties
        ? Object.keys(properties)
            .slice(0, ANCHOR_FIELD_KEYS_MAX)
            .map((key) => clip(key, ANCHOR_FIELD_KEY_MAX))
        : [],
    };
  }
  return null;
}

/** A string `agentType` recorded on a run/intake manifest, if any. */
function manifestAgentType(metadata: unknown): string | undefined {
  const bag = asRecord(metadata);
  for (const key of ["run", "intake"] as const) {
    const agentType = asRecord(bag?.[key])?.agentType;
    if (typeof agentType === "string" && agentType.trim()) {
      return agentType.trim();
    }
  }
  return undefined;
}

/**
 * Resolve an anchored comment against the rows. Reads THROWN errors through —
 * a failed read is not an unresolved anchor, and the send door decides what a
 * failure costs.
 */
export async function planAnchoredCommentTurn(params: {
  anchor: MessageAnchor;
  channelId: string;
  comment: string;
  db?: Database;
}): Promise<AnchoredCommentPlan> {
  const { anchor, channelId } = params;
  const database = params.db ?? defaultDb;

  const sessions = await database
    .select({ id: focusSessions.id, metadata: focusSessions.metadata })
    .from(focusSessions)
    .where(eq(focusSessions.channelId, channelId));

  const proposal = anchor.proposalId
    ? ((
        await database
          .select({
            status: proposals.status,
            data: proposals.data,
            sessionId: proposals.sessionId,
            agentUserId: proposals.agentUserId,
            revisionHistory: proposals.revisionHistory,
          })
          .from(proposals)
          .where(eq(proposals.id, anchor.proposalId))
          .limit(1)
      )[0] ?? null)
    : null;

  const currentVersion = proposal
    ? Array.isArray(proposal.revisionHistory)
      ? proposal.revisionHistory.length
      : 0
    : null;
  const op =
    proposal && anchor.opRef ? findOp(proposal.data, anchor.opRef) : null;

  const resolution: AnchorResolution = !anchor.proposalId
    ? "no_proposal"
    : !proposal
      ? "proposal_not_found"
      : anchor.opRef && !op
        ? "op_not_found"
        : "resolved";

  const context: AnchorTurnContext = {
    version: ANCHOR_TURN_CONTEXT_VERSION,
    resolution,
    proposalId: anchor.proposalId ?? null,
    proposalStatus: proposal?.status ?? null,
    opRef: anchor.opRef ?? null,
    op,
    field: anchor.field ?? null,
    contentVersion: anchor.contentVersion,
    currentVersion,
    stale: currentVersion !== null && currentVersion !== anchor.contentVersion,
    comment: clip(params.comment, ANCHOR_COMMENT_MAX),
  };

  if (sessions.length === 0) {
    return {
      context,
      decision: { trigger: false, reason: "not_session_channel" },
    };
  }

  const runSession = sessions.find((s) => {
    const bag = asRecord(s.metadata);
    return bag?.run !== undefined || bag?.intake !== undefined;
  });
  const sessionIds = new Set(sessions.map((s) => s.id));
  const anchorsPendingProposal =
    proposal?.status === "pending" &&
    !!proposal.sessionId &&
    sessionIds.has(proposal.sessionId);

  if (!runSession && !anchorsPendingProposal) {
    return {
      context,
      decision: { trigger: false, reason: "not_run_or_pending" },
    };
  }

  // The agent that produced the anchored work answers for it; otherwise a type
  // the run recorded; otherwise the default orchestrator (undefined).
  let agentType: string | undefined;
  if (proposal?.agentUserId) {
    const [agent] = await database
      .select({ agentType: users.agentType })
      .from(users)
      .where(eq(users.id, proposal.agentUserId))
      .limit(1);
    if (agent?.agentType) agentType = agent.agentType;
  }
  agentType ??= sessions
    .map((s) => manifestAgentType(s.metadata))
    .find(Boolean);

  return {
    context,
    decision: {
      trigger: true,
      reason: runSession ? "intake_run" : "pending_proposal",
      ...(agentType ? { agentType } : {}),
    },
  };
}

const SLOT_LABEL_MAX = 200;

/** One bounded line for an ask — the agent re-reads its OWN ask, not a new one. */
export function describeAskForTurn(ask: SlotAsk): {
  mode: string;
  text: string;
} {
  const parts: string[] = [];
  switch (ask.mode) {
    case "confirm":
      parts.push(ask.prompt ? `Yes/no: ${ask.prompt}` : "Yes/no");
      break;
    case "choose":
      parts.push(
        `Options: ${ask.options
          .map(
            (o) =>
              `${o.label}${o.recommended ? " (recommended)" : ""}${o.description ? ` — ${o.description}` : ""}`
          )
          .join("; ")}`
      );
      if (ask.allowOther) parts.push("Other answers allowed.");
      break;
    case "form":
      parts.push(
        `Fields: ${ask.form.fields
          .map(
            (f) =>
              `${f.label || f.key}${f.required ? " (required)" : ""}${f.constraints?.enum ? ` [${f.constraints.enum.join("/")}]` : ""}`
          )
          .join("; ")}`
      );
      break;
    case "act":
      if (ask.url) parts.push(`At: ${ask.url}`);
      if (ask.steps?.length) {
        parts.push(
          `Steps: ${ask.steps.map((st, i) => `${i + 1}. ${st}`).join(" ")}`
        );
      }
      if (parts.length === 0) parts.push("Do it, then say done");
      break;
    case "provide":
      parts.push(
        ask.provide.kind === "connection"
          ? `Connect: ${ask.provide.service}`
          : ask.provide.kind === "secret"
            ? `Secret (via the vault): ${ask.provide.name}`
            : `File${ask.provide.accept?.length ? ` (${ask.provide.accept.join(", ")})` : ""}`
      );
      break;
  }
  return {
    mode: ask.mode,
    text: clip(parts.join(" "), ANCHOR_SLOT_TEXT_MAX),
  };
}

/**
 * Resolve a `session_slot` anchor against the session row — the slot twin of
 * {@link planAnchoredCommentTurn}. Owner-floored by the CALLER (the
 * `askAboutSlot` door); a failed read throws through, never "not found".
 *
 * The decision is always to trigger: asking about a slot IS a summons of the
 * agent that owns the work (the door names it — a session room is a GROUP
 * room, which wakes only a named agent).
 */
export async function planSlotAnchorTurn(params: {
  anchor: SessionSlotAnchor;
  comment: string;
  db?: Database;
}): Promise<AnchoredCommentPlan> {
  const { anchor } = params;
  const database = params.db ?? defaultDb;
  const [row] = await database
    .select({ expectedOutputs: focusSessions.expectedOutputs })
    .from(focusSessions)
    .where(eq(focusSessions.id, anchor.sessionId))
    .limit(1);
  const outputs: ExpectedOutput[] = Array.isArray(row?.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[])
    : [];
  const wanted = normalizeExpectedLabel(anchor.label);
  const slot =
    outputs.find((o) => !!o && normalizeExpectedLabel(o.label) === wanted) ??
    null;
  const askChanged = slot
    ? askFingerprint(slot.ask ?? null) !== anchor.askFingerprint
    : false;
  const ref = slot?.ref
    ? "url" in slot.ref
      ? slot.ref.url
      : `${slot.ref.kind}:${slot.ref.id}`
    : null;

  const context: AnchorTurnContext = {
    version: ANCHOR_TURN_CONTEXT_VERSION,
    resolution: slot ? "slot_resolved" : "slot_not_found",
    proposalId: null,
    proposalStatus: null,
    opRef: null,
    op: null,
    field: null,
    contentVersion: 0,
    currentVersion: null,
    stale: askChanged,
    comment: clip(params.comment, ANCHOR_COMMENT_MAX),
    slot: slot
      ? {
          sessionId: anchor.sessionId,
          label: clip(slot.label, SLOT_LABEL_MAX),
          kind: clip(slot.kind, ANCHOR_FIELD_KEY_MAX),
          owner: slot.owner === "human" ? "human" : "agent",
          status: clip(slot.status ?? "pending", ANCHOR_FIELD_KEY_MAX),
          blockedReason: slot.blockedReason
            ? clip(slot.blockedReason, ANCHOR_FIELD_KEY_MAX)
            : null,
          why: slot.why ? clip(slot.why, ANCHOR_SLOT_TEXT_MAX) : null,
          ask: slot.ask ? describeAskForTurn(slot.ask) : null,
          ref: ref ? clip(ref, ANCHOR_SLOT_TEXT_MAX) : null,
          askChanged,
        }
      : null,
  };
  return { context, decision: { trigger: true, reason: "session_slot" } };
}
