/**
 * Notification type → event type — the ONE table where the notification
 * vocabulary and the event-spine grammar (`<domain>.<action>.<phase>`) are
 * kept in sync for alerts that are raised by a live probe or a boot report
 * rather than derived from an ordinary `.validated` mutation event.
 *
 * Why this exists: `NotificationService.create()` already appends a generic
 * `notification.created` event for every notification (the row id is the
 * subject, `data.notificationType` carries the real type as a string field).
 * That means these alerts were never literally invisible to the event
 * spine — but a `notification.created` event carries no DOMAIN-SPECIFIC
 * type, so nothing that filters, correlates, or projects BY event type
 * (the history lens, a future materializer, an automation trigger) can ever
 * recognize one of these occurrences AS a `connector.auth.expired` or an
 * `issuer.approval.requested` — only as an opaque wrapper. This table lets a
 * producer additionally append a properly-typed event alongside the
 * notification, carrying the real domain grammar.
 *
 * Rules for entries here:
 * - The mapped type must NOT end in `.validated` — that suffix triggers the
 *   materializer's async DB-write hook (`setup-event-broadcasting.ts`), which
 *   is for entity mutations, not alert occurrences. Use `.completed` (a
 *   probe observed a terminal state) or `.requested` (something now awaits
 *   a human) — never `.validated`.
 * - Only a notification type with an ACTUAL producer belongs here. Two
 *   registry types this task investigated (`pod.storage_warning`,
 *   `workspace.invite`) have ZERO call sites anywhere in the codebase — they
 *   are dead registry entries, not live alerts — so they are NOT mapped
 *   here; they are tracked instead in the producer-less allowlist next to
 *   `registry.ts` (`notification-producer-allowlist.test.ts`).
 */
export const NOTIFICATION_EVENT_TYPE_MAP: Record<string, string> = {
  // notify-connector-unhealthy.ts / notify-service-unhealthy.ts — a
  // live health probe found a dead connection. "auth_expire" because the
  // default cause this helper asserts is an expired/invalid credential.
  "connector.auth.expired": "connector.auth_expire.completed",

  // notify-service-unhealthy.ts → notifyConnectorUnhealthy() with an
  // overridden notificationType — an intelligence service's /health probe
  // came back degraded or unhealthy.
  "system.intelligence_degraded": "intelligence.degrade.completed",

  // notify-capability-updates.ts — the boot reconcile found capabilities
  // whose CP template drifted under `updatePolicy:"notify"`.
  "system.capability_update_available": "capability.update.completed",

  // hub-protocol/rest/setup.ts — an unrecognized JWT issuer registered
  // itself as pending; a pod admin must approve it. "requested" (not
  // "completed") because approval is exactly the step still outstanding.
  "system.issuer_pending_approval": "issuer.approval.requested",
};

/** Event source for every mapped alert — a probe/boot report, not a user request. */
export const NOTIFICATION_EVENT_SOURCE = "system" as const;
