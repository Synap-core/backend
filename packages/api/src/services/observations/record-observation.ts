/**
 * recordObservation — the ONE writer of an observation: "something happened
 * outside" recorded as an event of a registered namespace (`dev.*`, `ci.*`),
 * then the automations that trigger on it, then the pod's own consumers.
 *
 * Two callers: the key-authenticated door (`routers/hub-protocol/
 * observations.ts`, which validates the input and resolves the workspace and
 * grant first) and the pod itself (`dev.deployed` after a successful update,
 * `notifications/pod-deployed.ts`). Extracted from the door so the pod's own
 * fact is recorded, triggers and is consumed EXACTLY as a producer's is —
 * never a second spelling of the event, the hop or the provenance.
 *
 * The caller has already validated the type (namespace, reserved phases) and
 * the dev-loop payload contract (`checkDevLoopPayload`); this function trusts
 * them. See the door's header for why observations set `agentUserId` but not
 * `isAgent`.
 */

import { createHash } from "crypto";

import { createLogger, createSynapEvent } from "@synap-core/core";
import { DEV_LOOP_EVENT_TYPES, isDevLoopEventType } from "@synap-core/types";
import { getEventRepository, getRequestGrant } from "@synap/database";
import { getBoss } from "@synap/events";
import {
  DEV_LOOP_OBSERVATION_QUEUE,
  DEV_LOOP_SEND_OPTIONS,
  type DevLoopObservationJobData,
} from "@synap/jobs/workers/dev-loop-worker.js";

import { apiKeyService } from "../api-keys.js";
import { sessionForDevLoopFact } from "../dev-loop/pr-session-resolver.js";
import { PG_UUID_RE } from "../../routers/hub-protocol/rest/_codecs/_openapi.js";

const logger = createLogger({ module: "observations/record" });

/**
 * The dev-loop types the pod itself ACTS on (beyond firing automations):
 * `dev.pr_merged` / `dev.pr_closed` → the PR sweeper
 * (`services/dev-loop/merge-sweeper.ts`).
 */
const DEV_LOOP_ACTED_ON: ReadonlySet<string> = new Set([
  DEV_LOOP_EVENT_TYPES.prMerged,
  DEV_LOOP_EVENT_TYPES.prClosed,
]);

/**
 * The session a dev-loop fact is about, stamped on its data when the producer
 * named none (`sessionForDevLoopFact`). A failed lookup never costs the FACT:
 * it is logged and the fact is recorded unstamped (the sweeper resolves again
 * on its own).
 */
async function withResolvedSession(
  input: RecordObservationInput
): Promise<Record<string, unknown>> {
  if (!isDevLoopEventType(input.type)) return input.data;
  try {
    const sessionId = await sessionForDevLoopFact({
      userId: input.userId,
      type: input.type,
      data: input.data,
    });
    return sessionId ? { ...input.data, sessionId } : input.data;
  } catch (err) {
    logger.warn(
      { err, type: input.type, subjectRef: input.subjectRef },
      "observation: resolving the session of a dev-loop fact failed — recorded unstamped"
    );
    return input.data;
  }
}

/**
 * Stable namespace for observation subject refs. Any fixed UUID works; this one
 * must never change or previously-recorded subjects stop matching.
 */
const OBSERVATION_SUBJECT_NAMESPACE = "6f1e5b7a-3c2d-4e8f-9a0b-1d2c3e4f5a6b";

/**
 * Derive a deterministic UUID from an arbitrary subject reference.
 *
 * `SynapEvent.subjectId` is `z.string().uuid()` and `createSynapEvent` ends in
 * `SynapEventSchema.parse`, so a raw ref like `repo:backend` or a git SHA
 * THROWS. Observations are about things the pod may never have modelled, so
 * requiring a real entity UUID would defeat the point of the door.
 *
 * RFC-4122 v5 (SHA-1, name-based) gives the same UUID for the same ref forever,
 * so a subject stays queryable across batches and machines. The human-readable
 * original is preserved in `data.subjectRef` — never lose the real identifier.
 *
 * Implemented here rather than via the `uuid` package: that package only
 * resolves as a hoisted transitive dependency, which pnpm may stop providing.
 */
export function deriveSubjectUuid(ref: string): string {
  const nsHex = OBSERVATION_SUBJECT_NAMESPACE.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(ref, "utf8")]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const UUID_RE = PG_UUID_RE; // the ONE Postgres-uuid shape (rest/_codecs/_openapi.ts)

export interface RecordObservationInput {
  /** A validated observation type (`dev.pr_merged`). */
  type: string;
  /** What it is about, as the producer named it (`owner/name#12`, a sha). */
  subjectRef: string;
  subjectType: string;
  data: Record<string, unknown>;
  /** The person whose key (or pod) recorded it. */
  userId: string;
  /** The agent that recorded it — attribution only, never `isAgent`. */
  agentUserId?: string;
  /** A workspace the caller RESOLVED (visible, confined); never raw input. */
  workspaceId?: string;
  occurredAt?: Date;
  correlationId?: string;
}

/** Record one observation; returns its event row id. A failed write throws. */
export async function recordObservation(
  input: RecordObservationInput
): Promise<{ id: string }> {
  const { userId, agentUserId, workspaceId } = input;
  const eventRepo = getEventRepository();
  const payload = await withResolvedSession(input);
  const event = createSynapEvent({
    type: input.type,
    userId,
    // Hashed, because SynapEvent.subjectId must be a UUID. The real ref
    // rides in data.subjectRef so nothing is lost.
    subjectId: UUID_RE.test(input.subjectRef)
      ? input.subjectRef
      : deriveSubjectUuid(input.subjectRef),
    subjectType: input.subjectType,
    data: {
      ...payload,
      subjectRef: input.subjectRef,
      // When we HEARD about it, kept only when the producer told us when
      // it actually happened (the row `timestamp` is that occurrence
      // time). This lives in `data`, NOT `metadata`, because
      // `EventRepository.append` REPLACES the event's metadata with
      // `{version, requestId}` and silently drops everything else —
      // verified against a live pod, where a metadata field written here
      // came back null. `data` is the only caller-controlled payload
      // that survives.
      ...(input.occurredAt ? { ingestedAt: new Date().toISOString() } : {}),
      // Kept for back-compat with readers that COALESCE the two; the
      // indexable column is set on append below.
      ...(workspaceId ? { workspaceId } : {}),
    },
    source: "api",
    correlationId: input.correlationId,
    // Attribution WITHOUT `isAgent` — see the file header. Filling
    // `agentUserId` alone is safe: every governance predicate that
    // matters (including the daily-write-ceiling count) ANDs on
    // `is_agent = true`, so this pollutes no metric while keeping the
    // existing `GET /api/hub/events?agentUserId=` reader able to see
    // what an agent recorded.
    ...(agentUserId ? { agentUserId } : {}),
    // NOTE: no `metadata` — see the `ingestedAt` comment above.
    // `append` discards caller metadata, so writing any here would be a
    // field that reads back null. The type namespace already identifies
    // an observation; nothing else needs a marker.
  });

  const row = await eventRepo.append({
    ...event,
    // `occurredAt` must drive the ROW timestamp, not a metadata field.
    // Everything that orders, filters, partitions or expires an event
    // keys on `timestamp`; a metadata copy is read by nothing. Without
    // this, a CLI flushing a week of commits lands them all as "now" —
    // precisely the case this field exists for.
    ...(input.occurredAt ? { timestamp: input.occurredAt } : {}),
    // The real, indexable `workspace_id` column (0223). `createSynapEvent`
    // has no workspaceId parameter, which is why the canonical writer
    // (utils/audit-log.ts) also passes it separately here. Leaving it in
    // `data` only forces readers onto an unindexed JSONB fallback.
    workspaceId,
  });

  // ── UNIFIED TRIGGER HOP (additive) ────────────────────────────────
  // A recorded observation can now fire automations, exactly like a
  // governed event does via emitSideEffects' automation-trigger-match
  // reactor. Enqueue the SAME queue in the SAME payload shape — but with
  // `eventType = input.type` (raw, e.g. "dev.commit"), which the matcher's
  // `matchPattern` already handles (dotted + trailing-wildcard:
  // "dev.commit" / "dev.*"). We deliberately do NOT route through
  // `emitSideEffects`: it would synthesize `<subjectType>.<action>.
  // completed` (the wrong eventType) and fire every unrelated reactor
  // (search-index, webhook-delivery, …) for a row that is not a
  // first-party domain event. The matcher's exactly-once
  // (automation_claims), owner-floor, cycle/depth guard and workspace
  // fan-out all apply unchanged (additive).
  //
  // RATE/VOLUME BOUND (Part C): consume a per-(producer, namespace)
  // token from the shared key rate limiter BEFORE enqueuing. The FACT is
  // already recorded above; only the trigger side-effect is gated, so a
  // noisy/malicious key floods neither the trigger queue nor the
  // proposals it would spawn — while never losing the fact. Bucketed on
  // the producing PRINCIPAL (agent user id if present, else the human)
  // × the coarse namespace, so varying the type suffix cannot bypass it.
  //
  // Best-effort: a boss / limiter error must never flip a RECORDED fact
  // to `ok:false`. The row exists; the trigger is a side-effect — so a
  // failure is LOGGED, never swallowed silently.
  //
  // EXACTLY-ONCE: the trigger's `data` leaves out `ingestedAt` (when WE
  // heard it, unique per delivery). The matcher's claim fingerprint falls
  // back to a hash of `data` (a PR fact has no native id), so with it a
  // re-run producer job re-posting the same fact fired every automation
  // twice. The recorded row keeps it.
  const { ingestedAt: _heardAt, ...triggerData } = event.data as Record<
    string,
    unknown
  >;
  try {
    const dot = input.type.indexOf(".");
    const namespace = dot > 0 ? input.type.slice(0, dot) : input.type;
    const triggerProducer = agentUserId ?? userId;
    const withinTriggerBudget = apiKeyService.checkRateLimit(
      `obs-trigger:${triggerProducer}:${namespace}`,
      "observation-trigger"
    );
    if (withinTriggerBudget) {
      await getBoss().send("automation-trigger-match", {
        eventType: input.type,
        subjectId: event.subjectId,
        userId,
        workspaceId: workspaceId ?? null,
        data: triggerData,
        // PROVENANCE — the recorded observation's own row. It was
        // already in hand here (`row.id`, returned by the insert above)
        // and was dropped, which is why a run fired by an observation
        // could not name the fact that fired it. Top-level, never
        // inside `data`: `resolveAutomationEventFingerprintId` reads
        // `data.eventId` first, and a unique id there would give every
        // observation a unique fingerprint and disable the
        // exactly-once claim.
        eventId: row.id,
        // The producing agent, so a fired automation's THEN-actions are
        // governed against it (proposal, never an ungoverned effect).
        // Null for a human producer → owner-only governance, unchanged.
        producerAgentUserId: agentUserId ?? null,
      });
    } else {
      logger.warn(
        { type: input.type, eventId: row.id, producer: triggerProducer },
        "observation: trigger budget spent — recorded, automations not fired"
      );
    }
  } catch (err) {
    logger.error(
      { err, type: input.type, eventId: row.id },
      "observation: enqueueing the automation trigger failed — recorded, automations not fired"
    );
  }

  // The pod's OWN consumers of a dev-loop fact (the PR sweeper): a job, so
  // the door answers at once and a batch of merges is not swept inline.
  // OUTSIDE the trigger budget: it is the pod's own, idempotent, cheap
  // consumer, and a burst (a poller draining after a pause) must not drop a
  // merge silently. It carries the posting key's GRANT (founder F1): the job
  // runs after the request is gone, and re-enters it around the sweep.
  if (DEV_LOOP_ACTED_ON.has(input.type)) {
    const grant = getRequestGrant();
    try {
      await getBoss().send(
        DEV_LOOP_OBSERVATION_QUEUE,
        {
          eventType: input.type,
          data: event.data,
          userId,
          producerAgentUserId: agentUserId ?? null,
          eventId: row.id,
          grant: grant
            ? {
                scopes: [...grant.scopes] as unknown[],
                clientId: grant.clientId,
              }
            : null,
        } satisfies DevLoopObservationJobData,
        DEV_LOOP_SEND_OPTIONS
      );
    } catch (err) {
      logger.error(
        { err, type: input.type, eventId: row.id },
        "observation: enqueueing the dev-loop sweep failed — recorded, the session did not move"
      );
    }
  }

  return { id: row.id };
}
