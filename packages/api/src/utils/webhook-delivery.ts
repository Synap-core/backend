/**
 * Webhook fan-out for API-side events — resolves WHO may receive an event,
 * then hands delivery to THE ONE webhook door (the `webhook-delivery` queue in
 * `@synap/jobs/workers/webhook-worker`), which owns the HTTP POST, the
 * signature, the delivery log and pg-boss retries. Nothing here sends HTTP.
 *
 * Called from `emitChatEvent` after the socket broadcast, and from entity
 * property updates.
 *
 * Wire format `chat.v1` (unchanged for existing subscribers): body
 * `{ event, data, timestamp }`, `X-Synap-Event`, and — when the subscription
 * has a secret — `X-Synap-Signature: sha256=<hmac-hex>`. The door adds
 * `X-Synap-Webhook-Format: chat.v1` and a stable `X-Synap-Delivery-Id`.
 * Match rule: `subscriptionWantsEvent` (empty list = all events).
 *
 * AUDIENCE — a subscription belongs to ONE user (`webhook_subscriptions.user_id`)
 * and receives an event only when that user may READ what the event is about.
 * The caller names the subject (`WebhookAudience`); the reader set comes from
 * the existing doors, never a rule invented here:
 *   - channel → `listChannelAudienceUserIds` (the channel read predicate). A
 *     channel named only in a caller-shaped payload is honoured only when the
 *     actor is one of its readers — the same trust rule `emitChatEvent` applies
 *     to its socket fan-out — otherwise only the actor's subscriptions match.
 *   - entity  → `scopedDb(AccessContext.operator({ userId: owner }))` over
 *     `entities` (the registered access-layer floor), per subscription owner.
 *   - user    → that user's subscriptions only.
 * A failed audience read delivers to NOBODY: a failed read is not "everyone".
 *
 * WORKSPACE — a subscription bound to a workspace (`workspace_id` set) gets
 * only events whose SUBJECT lives in that workspace (`subscriptionCoversWorkspace`,
 * the same rule producer 1 applies): the entity's / channel's own
 * `workspace_id`, read from the subject row. A pod-wide subject (NULL
 * workspace) and a `user` audience (no subject) reach unbound subscriptions
 * only. The subject's workspace is read only when a bound subscription is a
 * candidate, and a failed read of it is a failed audience read (nobody).
 *
 * KEY-BOUND (S2 + D7) — a subscription created by an API key (`api_key_id`)
 * is delivered only while that key is live (`liveApiKeyIds`, the jobs door's
 * one rule) and only when the key's GRANT reads the subject: the same owner
 * read floor as above (`ownerReadsRow`), entered under the key's grant
 * (`keyGrantReadsSubject` — which producer 1 calls too, through the jobs
 * `registerKeyGrantAudience` slot that apps/api fills at boot). A pod-wide
 * subject (a person) is then delivered exactly when the grant reads it; a
 * subject-less `user` event never reaches a key-bound
 * subscription (there is nothing for the grant to read). A subject type with
 * no table here is not delivered to key-bound subscriptions.
 *
 * Failures are console.warn'd, never thrown — this must never block the API.
 */

import { randomUUID } from "node:crypto";
import {
  db,
  webhookSubscriptions,
  eq,
  GrantRepository,
  runWithGrant,
} from "@synap/database";
import {
  channels,
  documents,
  entities,
  focusSessions,
  links,
  projectTracks,
  projects,
  proposals,
  relations,
  views,
} from "@synap/database/schema";
import { getBoss } from "@synap/events";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  buildWebhookBody,
  enqueueWebhookDeliveries,
  liveApiKeyIds,
  subscriptionCoversWorkspace,
  subscriptionKeyLive,
  subscriptionWantsEvent,
  type KeyGrantSubject,
} from "@synap/jobs/workers/webhook-worker.js";
import { listChannelAudienceUserIds } from "./channel-visibility.js";
import { AccessContext, scopedDb } from "../access/index.js";

/** What the event is ABOUT — decides whose subscriptions may receive it. */
export type WebhookAudience =
  | {
      kind: "channel";
      channelId: string;
      /**
       * `true` when the channel id came from an internal door that already
       * authorized it; `false` when it was only found in the payload.
       */
      trusted: boolean;
      actorUserId?: string | null;
    }
  | { kind: "entity"; entityId: string }
  | { kind: "user"; userId: string | null | undefined };

/**
 * Does `owner` read the row `id` of `table`? THE webhook read check: the
 * table's registered access-layer floor (`scopedDb`), plus — when called under
 * `runWithGrant` — the key grant's read clause.
 */
async function ownerReadsRow(
  owner: string,
  table: { id: AnyPgColumn },
  id: string
): Promise<boolean> {
  const rows = await scopedDb(
    AccessContext.operator({ userId: owner })
  ).findMany(table, {
    where: eq(table.id, id),
    columns: { id: true },
    limit: 1,
  });
  return rows.length > 0;
}

/**
 * Event subject type → its scoped table, for key-bound subscriptions (D7).
 * Producer 1 names `SideEffectPayload.subjectType`; producer 2 its audience
 * kind. Unlisted = the grant cannot be asked = not delivered (fail closed).
 */
const KEY_SUBJECT_TABLES: Readonly<Record<string, { id: AnyPgColumn }>> = {
  entity: entities,
  document: documents,
  relation: relations,
  channel: channels,
  proposal: proposals,
  project: projects,
  view: views,
  focus_session: focusSessions,
  link: links,
  track: projectTracks,
};

/**
 * D7 — does the key's grant read this subject? The owner's read floor
 * (`ownerReadsRow`) entered under the key's live grant (`resolveForKey`: a
 * revoked/expired grant is deny-all), as every door sees it
 * (`effectiveKeyGrant`). Used by BOTH producers.
 */
export async function keyGrantReadsSubject(
  subject: KeyGrantSubject
): Promise<boolean> {
  const table = KEY_SUBJECT_TABLES[subject.subjectType];
  if (!table) return false;
  const stored = await new GrantRepository(db).resolveForKey(subject.apiKeyId);
  // The SAME grant the request doors see: a person's app sign-in token is
  // re-judged now (dead → deny-all, else narrowed), never its stored copy
  // (PR #29 re-review N1). Loaded on use: only app-named grants need it.
  const { effectiveKeyGrant } = await import("../services/app-person-token.js");
  const grant = await effectiveKeyGrant(subject.apiKeyId, stored);
  return runWithGrant(grant, () =>
    ownerReadsRow(subject.ownerUserId, table, subject.subjectId)
  );
}

/** The subset of `ownerIds` allowed to read the event's subject. */
async function readersAmong(
  audience: WebhookAudience,
  ownerIds: string[]
): Promise<Set<string>> {
  switch (audience.kind) {
    case "user":
      return new Set(audience.userId ? [audience.userId] : []);
    case "channel": {
      const readers = await listChannelAudienceUserIds(db, audience.channelId);
      const actor = audience.actorUserId ?? null;
      if (!audience.trusted && !(actor && readers.includes(actor))) {
        return new Set(actor ? [actor] : []);
      }
      return new Set(readers);
    }
    case "entity": {
      const allowed = new Set<string>();
      for (const owner of ownerIds) {
        if (await ownerReadsRow(owner, entities, audience.entityId)) {
          allowed.add(owner);
        }
      }
      return allowed;
    }
  }
}

/**
 * The workspace the event's SUBJECT lives in (`null` = pod-wide / no subject).
 * Read from the subject row itself — never from the payload, which a caller
 * may shape. A subject row that is not found is pod-wide for this rule: a
 * bound subscription then receives nothing, the narrow side.
 */
async function subjectWorkspaceId(
  audience: WebhookAudience
): Promise<string | null> {
  switch (audience.kind) {
    case "user":
      return null;
    case "channel": {
      const [row] = await db
        .select({ workspaceId: channels.workspaceId })
        .from(channels)
        .where(eq(channels.id, audience.channelId))
        .limit(1);
      return row?.workspaceId ?? null;
    }
    case "entity": {
      const [row] = await db
        .select({ workspaceId: entities.workspaceId })
        .from(entities)
        .where(eq(entities.id, audience.entityId))
        .limit(1);
      return row?.workspaceId ?? null;
    }
  }
}

/** Awaitable core of {@link dispatchWebhooksForEvent} (exported for tests). */
export async function deliverWebhooksForEvent(
  eventType: string,
  data: Record<string, unknown>,
  audience: WebhookAudience
): Promise<void> {
  try {
    const active = await db
      .select({
        id: webhookSubscriptions.id,
        userId: webhookSubscriptions.userId,
        apiKeyId: webhookSubscriptions.apiKeyId,
        workspaceId: webhookSubscriptions.workspaceId,
        eventTypes: webhookSubscriptions.eventTypes,
        retryConfig: webhookSubscriptions.retryConfig,
      })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.active, true));
    const wanted = active.filter((s) =>
      subscriptionWantsEvent(s.eventTypes, eventType)
    );
    if (wanted.length === 0) return;

    let readers: Set<string>;
    let eventWorkspaceId: string | null = null;
    let candidates: typeof wanted;
    try {
      // S2: a dead key's subscription is not a candidate.
      const live = await liveApiKeyIds(wanted.map((s) => s.apiKeyId));
      candidates = wanted.filter((s) => subscriptionKeyLive(s.apiKeyId, live));
      if (candidates.length === 0) return;
      readers = await readersAmong(audience, [
        ...new Set(candidates.map((s) => s.userId)),
      ]);
      // Only a bound candidate needs the subject's workspace.
      if (candidates.some((s) => s.workspaceId)) {
        eventWorkspaceId = await subjectWorkspaceId(audience);
      }
    } catch (err) {
      console.warn(
        `[webhook] audience read failed for '${eventType}'; delivering to nobody:`,
        err
      );
      return;
    }

    const owned = candidates.filter(
      (s) =>
        readers.has(s.userId) &&
        subscriptionCoversWorkspace(s.workspaceId, eventWorkspaceId)
    );
    // D7: a key-bound subscription also needs its grant to read the subject.
    const subscribers: typeof owned = [];
    for (const s of owned) {
      if (!s.apiKeyId) {
        subscribers.push(s);
        continue;
      }
      const subjectId =
        audience.kind === "entity"
          ? audience.entityId
          : audience.kind === "channel"
            ? audience.channelId
            : null;
      if (!subjectId) continue; // a `user` event: nothing for a grant to read
      try {
        const reads = await keyGrantReadsSubject({
          apiKeyId: s.apiKeyId,
          ownerUserId: s.userId,
          subjectType: audience.kind,
          subjectId,
        });
        if (reads) subscribers.push(s);
      } catch (err) {
        console.warn(
          `[webhook] key-grant read failed for subscription ${s.id}; not delivered:`,
          err
        );
      }
    }
    if (subscribers.length === 0) return;

    // ONE fan-out id for this call (not one per subscription / attempt), so
    // each subscriber's delivery id is derived from it.
    await enqueueWebhookDeliveries(
      getBoss(),
      subscribers,
      {
        eventType,
        format: "chat.v1",
        body: buildWebhookBody("chat.v1", { eventType, data }),
      },
      randomUUID()
    );
  } catch (err) {
    console.warn("[webhook] fanout failed:", err);
  }
}

export function dispatchWebhooksForEvent(
  eventType: string,
  data: Record<string, unknown>,
  audience: WebhookAudience
): void {
  void deliverWebhooksForEvent(eventType, data, audience);
}
