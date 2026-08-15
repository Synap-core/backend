/**
 * Message Observation Emitter
 *
 * The keystone additive fact-write: channel/external message activity has
 * always landed in `messages` and NOWHERE else — the `events` log (the thing
 * analyzers/replay actually read) never saw it. This closes that blind spot
 * by appending a governance-safe FACT alongside the existing `messages`
 * insert, at both write sites (inbound: `inbound-recorder.ts`, outbound:
 * `channels/send-message.ts`).
 *
 * ── Delegation ──────────────────────────────────────────────────────────────
 * The implementation now lives in `@synap/database`'s `emitMessageEvent`
 * (`packages/database/src/utils/emit-message-event.ts`) so shared writers in
 * that package (`insertChannelMessage`, `persistAssistantReply`) can call it
 * directly without duplicating the logic. This file keeps the api-side name
 * (`emitMessageObservation`) and signature stable for its existing callers
 * (send-message.ts, inbound-recorder.ts) — it is a thin re-export/delegate.
 *
 * ── Why NOT the hub-protocol/observations.ts door ──────────────────────────
 * That router is the KEY-AUTHENTICATED, EXTERNAL door: its
 * `OBSERVATION_NAMESPACES` allowlist + `RESERVED_PHASES` refuse exist to
 * bound an untrusted caller (a CLI, an agent key). This call site is
 * first-party server code recording its OWN write — there is no external
 * caller to bound, and the type this door needs (`message.received` /
 * `message.sent`, two segments, no lifecycle-phase suffix) does not fit
 * `auditLog()`'s `<subjectType>.<action>.<phase>` shape either (EVENT_ACTIONS
 * has no "received"/"sent", EVENT_PHASES has no phase-less form). So this
 * builds the row directly via `createSynapEvent` + `EventRepository.append`
 * — the same primitives `observations.ts` uses internally, minus the zod
 * gate, minus the automation-trigger hop, minus rate limiting: none of that
 * applies to a first-party fact write.
 *
 * ── Governance-safe, on purpose ─────────────────────────────────────────────
 *   • NO `isAgent` — this must never burn an agent's daily write-ceiling
 *     budget just for a message landing (mirrors observations.ts's stance).
 *   • NO proposal, NO automation-trigger enqueue — a pure fact pointer, never
 *     a command. Wiring these into automations is a SEPARATE, deliberate
 *     decision for a later change, not a side effect of this one. NOTE the type
 *     strings `message.received`/`message.sent` string-COINCIDE with
 *     `MESSAGE_ALIAS_PATTERNS` (types/events/unified.ts), which the automation
 *     matcher binds to the PHYSICAL types `external_message.received.completed`
 *     / `channel_message.created.completed` — NOT to these rows. This write does
 *     not feed that matcher; a future wave that wants automations to trigger on
 *     these must register them explicitly (and `message.sent` fails
 *     `validateEventPattern` today — "sent" is not a CRUD EventAction).
 *   • NO message body copied in — `subjectId`/`subjectType` point at the real
 *     channel (and the bound entity, when one exists); `data` carries only
 *     small fact fields the caller passes in.
 *
 * ── Failure isolation ───────────────────────────────────────────────────────
 * Message landing is the critical path; this is a side observation of it.
 * Never throws — a failure is logged and swallowed, exactly like the
 * `search-index` / attachment-ingest side effects next to it at both call
 * sites.
 */

import { emitMessageEvent, type EmitMessageEventArgs } from "@synap/database";

export type MessageObservationArgs = EmitMessageEventArgs;

/**
 * Append one `message.received` / `message.sent` fact into the `events` log.
 *
 * Call ONLY after confirming the `messages` insert actually landed a NEW row
 * (the caller must check the idempotency-insert result itself — this
 * function does not know about `onConflictDoNothing` / chat-turn dedup).
 */
export async function emitMessageObservation(
  args: MessageObservationArgs
): Promise<void> {
  await emitMessageEvent(args);
}
