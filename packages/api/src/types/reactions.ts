/**
 * Reaction projection types — the read-only "Reactions" / Pulse data model.
 *
 * This is a PROJECTION over the existing event spine + reactive primitives
 * (automation runs, webhook deliveries, notifications, downstream events).
 * There is NO `reactions` write table — these shapes are derived at query
 * time by `subscriptionsRouter` (see `routers/subscriptions.ts`).
 *
 * The frontend Reactions UI is built EXACTLY to these shapes; do not rename
 * fields without updating the consuming surface.
 */

/** The category of a single fan-out reaction. */
export type ReactionKind =
  "automation" | "ai_feed" | "ai_react" | "notify" | "webhook" | "message_out";

/** Lens used to filter reactions by direction (internal vs external). */
export type ReactionLens = "all" | "internal" | "external";

/** Kinds that flow internally (stay inside the pod). */
export const INTERNAL_REACTION_KINDS: ReactionKind[] = [
  "automation",
  "ai_feed",
  "ai_react",
  "notify",
];

/** Kinds that flow externally (leave the pod). */
export const EXTERNAL_REACTION_KINDS: ReactionKind[] = [
  "webhook",
  "message_out",
];

/** A single fan-out reaction triggered by a source event. */
export interface Reaction {
  kind: ReactionKind;
  label: string;
  status?: "success" | "pending" | "failed";
  /** e.g. "200", "504", "pending" */
  responseStatus?: string;
  detail?: string;
}

/** A source event in the Pulse feed, with its fan-out reactions. */
export interface ReactionEvent {
  id: string;
  /** e.g. "deal.update.completed" */
  type: string;
  /** ISO timestamp */
  timestamp: string;
  /** human summary, e.g. "Helix Robotics · closeDate → Jun 3" */
  subject: string;
  subjectId?: string;
  subjectType?: string;
  /**
   * The resolved real display name of the subject object (e.g. "Helix Robotics",
   * "Person", "Weekly digest"), looked up server-side from the owning table.
   * Set ONLY when resolution succeeded — absent when the id matched no visible
   * row, so the client can render a named chip vs. the opaque `subject` fallback
   * WITHOUT string-sniffing.
   */
  subjectName?: string;
  /** "Hestia" | "Maya Chen" | "cron:0 7 * * *" | "feed:rss" */
  actor: string;
  actorAI: boolean;
  correlationId?: string;
  /** event itself represents a failure (e.g. webhook.delivery.failed) */
  failed?: boolean;
  /** trigger flowing IN (cron.fired, feed.item.received) */
  inbound?: boolean;
  /**
   * A `.requested` event whose linked proposal is still awaiting a decision.
   * This is the decision-inbox signal — the user must approve or reject.
   */
  pending?: boolean;
  /** The proposal awaiting decision, when `pending` (for inline approve/reject). */
  proposalId?: string;
  note?: string;
  /** the fan-out */
  reactions: Reaction[];
}

/** Webhook delivery row for the Health tab + Replay. */
export interface WebhookDeliveryItem {
  id: string;
  status: "success" | "failed" | "pending";
  responseStatus?: string;
  attempt: number;
  deliveredAt?: string;
  /** Row creation time; the UI falls back to this when deliveredAt is null. */
  createdAt?: string;
}
