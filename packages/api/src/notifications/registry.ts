/**
 * Notification Type Registry
 *
 * Maps notification type keys to their definition.
 * Adding a new notification type = add one entry here. Zero code.
 *
 * Templates support simple {{variable}} interpolation.
 * Variables come from the `data` object passed to NotificationService.create().
 * Interpolation covers `titleTemplate` and `bodyTemplate` ONLY — `actions` are
 * persisted and emitted verbatim.
 *
 * NOT unified here (deliberately, and still open): `notifications.workspaceUrl`
 * and `navigation/deep-links.ts` are two further address vocabularies for the
 * same destinations. Only the inline ACTION vocabulary is folded into the ONE
 * route table by `navigate-object` below.
 */

import type { ConnectionNoticeClass } from "./connection-prefs.js";

export type DeliveryChannel = "in_app" | "os" | "telegram" | "email_digest";

export interface NotificationActionDef {
  id: string;
  label: string;
  variant: "primary" | "secondary" | "destructive";
  handler:
    | NotificationNavigateHandler
    | NotificationNavigateObjectHandler
    | { type: "mutation"; procedure: string; inputKey?: string };
}

/**
 * A destination that is NOT an object — a settings tab, the vault, a listing.
 * These have no id and no route-table row, so they name an app directly.
 *
 * Anything whose destination IS an object must use `navigate-object` below;
 * an app+params pair for an object is a second, hand-rolled routing vocabulary
 * that drifts from the ONE route table the moment either side changes.
 */
export interface NotificationNavigateHandler {
  type: "navigate";
  app: string;
  params?: Record<string, unknown>;
}

/**
 * A destination that IS an object. The client resolves `{kind, id}` through the
 * ONE route table — `objectNavTarget()` in
 * `browser/electron/renderer/src/navigation/object-nav.ts` (its `fallbackNavTarget`
 * switch lists every routable kind) — so this registry never restates where a
 * kind lives.
 *
 * `kind` is typed as a plain string on purpose: the route table is a browser
 * module and the kind vocabulary (`OBJECT_KINDS` in
 * `@synap-core/types/vocabulary`) is an open `Record<string, …>`, not a union.
 *
 * `id` is OMITTED for the common case, and then means "this notification's own
 * `sourceId`" — which is the object id for every action migrated so far
 * (chat.mention → channelId, automation.broken → automationId, proposal.created
 * → proposalId). Nothing interpolates `{{tokens}}` inside a handler: `create()`
 * stores `def.actions` VERBATIM and the persisted row does not carry `data`, so
 * a templated id would reach the client as the literal `{{…}}` text. That was
 * already true of the `chat.mention` action this replaces.
 *
 * `kind` is OMITTED only by a type whose rows each point at a different KIND of
 * object (the handoff types: any `HANDOFF_KINDS` member). It then means "this
 * notification's own object" — the producer's `target`, else its
 * `sourceType` — and `create()` writes it in (`materializeActions`), so a
 * persisted row and the socket payload always carry a literal kind: no client
 * ever reads a handler without one.
 */
export interface NotificationNavigateObjectHandler {
  type: "navigate-object";
  /**
   * Object-nav kind — see `fallbackNavTarget` in object-nav.ts. Omit ⇒ the
   * row's own object, written in at create (see above).
   */
  kind?: string;
  /** Literal object id. Omit ⇒ the notification's own `sourceId`. */
  id?: string;
  /**
   * Optional object-nav VIEW reading (`OBJECT_NAV_VIEWS` in
   * `@synap-core/types/navigation` — `'room'` opens a session's Intake Room).
   * Literal, never templated; the client re-validates it with
   * `isObjectNavView` and drops an unknown one.
   */
  view?: string;
}

export interface NotificationDef {
  type: string;
  category: "governance" | "data" | "ai" | "system" | "inbox";
  label: string;
  icon: string; // lucide icon name
  priority: "low" | "normal" | "high" | "urgent";
  /** Mustache-style template: {{variable}} */
  titleTemplate: string;
  bodyTemplate: string;
  /** Default delivery channels (user prefs can override) */
  defaultChannels: DeliveryChannel[];
  /**
   * The channels this type may EVER go out on, whatever a routing rule says.
   * Omit ⇒ no ceiling. Exists for a type whose audience is fixed by what it IS:
   * a phone→desktop handoff pushed back to the phone that sent it is noise.
   */
  channelCeiling?: DeliveryChannel[];
  /** Inline action buttons */
  actions?: NotificationActionDef[];
  /** Auto-dismiss after ms. 0 = persistent. */
  ttl?: number;
  /**
   * SERVER expiry, in ms. Declared ⇒ `NotificationService.create()` stamps
   * `expiresAt = now + expiresAfterMs` (unless the producer passes its own),
   * and the daily `notification-cleanup` worker dismisses the row once it
   * passes — read or not. Omit ⇒ the row never expires.
   *
   * Not `ttl`: no server code reads `ttl` (its finite values are toast-length,
   * 4–6 s), so stamping it would expire those rows the next day. Declare this
   * on news that goes stale on its own — a failed update a week later, a
   * closed session's flag — never on an ask.
   */
  expiresAfterMs?: number;
  /** Group notifications sharing the same resolved groupBy field */
  groupBy?: string;
  /**
   * SUPPRESSION window, in ms. Declared ⇒ `NotificationService.create()` looks
   * for an existing row with the SAME `(userId, type, groupKey)` created within
   * this window and, finding one, writes NOTHING and interrupts nobody.
   *
   * This is not `groupBy`. `groupBy` is DISPLAY collapsing — N rows exist and
   * the bell stacks them, which is fine for a bell and wrong for a phone: N
   * rows means N pushes. A type that can be emitted repeatedly for the same
   * subject (a second criterion escalating in the same session, a redelivered
   * close event) needs the row itself not to be written a second time.
   *
   * Opt-IN on purpose. Applying a window to every type would silently swallow
   * `proposal.created`, which groups by AGENT and legitimately fires once per
   * proposal — the second proposal from the same agent is real news, not a
   * duplicate. Only a type whose groupKey IS its identity may declare one.
   *
   * WHAT IT DOES NOT COVER, measured: it is keyed on the resolved `groupKey`,
   * so two notifications that differ in any way the groupKey does not encode
   * (a DIFFERENT criterion in the same session) are the same key and the second
   * is suppressed — that is the intent here, not a gap. Conversely it cannot
   * coalesce two events whose groupKeys differ, however similar they read. A
   * type with no resolvable groupKey is never deduped (and says so in the log).
   */
  dedupeWindowMs?: number;
  /**
   * How an UNREAD row of this type takes part in the needs-you union
   * (`services/signals/needs-you-union.ts`). Omit ⇒ `"item"`.
   *
   * - `"item"` — the row is its own needs-you entry until it is read.
   * - `"informational"` — the row NEVER counts as needing you. It stays in the
   *   bell; it is not an ask. Use it for news that does not wait on the person.
   * - `"session-pointer"` — the row POINTS AT a session's live need rather than
   *   being one. The union decides from the session's state, not from the row:
   *   the row folds into the session's owed-slot row when there is one, counts
   *   once when the session has an open room question, and counts ZERO when
   *   neither is true, because whatever it announced has been resolved. A
   *   pointer row's `sourceId` must be the session id.
   * - `"suggestion"` — something an AI offered on its own initiative (a nudge,
   *   an insight, a briefing). It NEVER counts toward needs-you. It goes to
   *   its own sibling bucket instead: `signals.list({ lens: "suggestions" })`
   *   and `signals.count().suggestions`, shown as "Suggestions".
   * - `"status"` — SYSTEM HEALTH (an AI service degraded, storage running
   *   out). Never a needs-you row and never a suggestion (founder, lens grammar
   *   2026-10-04): every unread row of these types folds into ONE deduplicated
   *   status banner (`signals.list` lens page, `status`). Health is a condition
   *   of the pod, not an ask of the person.
   *
   * Data on the row, never a list of type strings in the union. A new
   * informational type is left out of needs-you because its own row says so.
   */
  needsYou?: NotificationNeedsYouRole;
  /**
   * How unread rows of this type FOLD into one needs-you row. Omit ⇒ per
   * target (`(type, source)`, `foldNotifications`). `"groupKey"` ⇒ per the
   * producer's collapse key: the same agent failing on run after run is ONE
   * row ("and 8 more like it"), not nine rows each pointing at a different run (dogfood
   * 2026-10-05: "meta encountered an error" ×9 on the triage page). The row
   * carries the NEWEST instance, so its door is the latest failure.
   */
  foldBy?: "groupKey";
  /**
   * This type is news ABOUT ONE CONNECTION, and which kind: `"problem"` (it
   * stopped working / needs the person) or `"info"` (it worked). The producer
   * names the connection (`CreateNotificationInput.connection`) and
   * `NotificationService.create` gates the row on that connection's notify
   * level (`connection-prefs.ts`): `nothing` drops both, `problems` (default)
   * keeps `"problem"`, `everything` keeps both. Omit ⇒ not a connection notice,
   * never gated.
   */
  connectionNotice?: ConnectionNoticeClass;
}

export type NotificationNeedsYouRole =
  "item" | "informational" | "session-pointer" | "suggestion" | "status";

/**
 * The suppression window both session-attention types use: one notification per
 * session per six hours.
 *
 * Six hours, not "forever": a redelivered event, a retried evaluation pass, and
 * a second criterion escalating in the same run all land inside one working
 * block and are one piece of news ("this session needs you"). A session that
 * escalates again TOMORROW is genuinely news again, and a permanent key would
 * silence it forever with nothing to say so. Six hours is the smallest window
 * that covers a working block without making that claim.
 */
export const SESSION_ATTENTION_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The window for types that fire once per RUN or per SYNC about the same
 * target — `automation.notification`, `connector.sync.failed` (W2 calm,
 * census §3c): one row per (user, type, target) per day. A step that runs
 * every five minutes, or a sync that fails every hour, is one piece of news
 * until the person reads it; once the day has passed and the row is still
 * unread, the next one REFRESHES that row rather than stacking a second
 * (`NotificationService.create`, the 0281 guard).
 */
export const NOTIFICATION_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long informational news about a moment that has passed stays in the
 * bell (`expiresAfterMs`): a week — long enough to be seen after a weekend,
 * short enough that last month's failed update is not still news.
 */
export const STALE_NEWS_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A STATUS SIGNAL: the status watcher (`services/status/watcher.ts`) noticed
 * that a thing its owner owns is late, nearly due, stuck in its step, or
 * paused past its review date. One row per subject type, so the button opens
 * the right kind of object; the watcher writes the words. Raised once per
 * episode (no dedupe window), an item in needs-you folded per signal and
 * kind, stale after a week; pushes under `late-or-stuck`, inside the cap.
 */
function statusSignalDef(
  type: string,
  objectKind: "entity" | "track" | "session"
): NotificationDef {
  return {
    type,
    category: "data",
    label: "Needs a look",
    icon: "alarm-clock",
    priority: "normal",
    titleTemplate: "{{headline}}",
    bodyTemplate: "{{detail}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    foldBy: "groupKey",
    expiresAfterMs: STALE_NEWS_EXPIRY_MS,
    actions: [
      {
        id: "view",
        label: "Open",
        variant: "primary",
        handler: { type: "navigate-object", kind: objectKind },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const NOTIFICATION_REGISTRY: NotificationDef[] = [
  // ── Status signals (status-flow W6) ───────────────────────────────────────
  statusSignalDef("entity.signal", "entity"),
  statusSignalDef("track.signal", "track"),
  statusSignalDef("session.signal", "session"),
  // ── Tracks ────────────────────────────────────────────────────────────────
  {
    /**
     * A track's KPI just reached its target (0302). Producer:
     * `applyTrackDirection` (services/tracks), on the CROSSING only
     * (`trackKpiJustReached`) — a re-statement of a reached value never
     * re-nudges. `sourceId` is the track id.
     *
     * A NUDGE, never an act: reaching the target asks the person to re-aim
     * it (a new target) or to close the goal with a verdict if its criteria
     * are met (work model D1, 2026-10-23) — a number reached never closes it.
     * It is an ITEM in needs-you because the decision is theirs to make; the
     * door opens the track.
     * The KPI value is STATED, so the body says "stated", never "measured".
     */
    type: "track.kpi_reached",
    category: "data",
    label: "Goal target reached",
    icon: "target",
    priority: "normal",
    titleTemplate: "{{trackName}} reached its target",
    bodyTemplate:
      "{{kpiLabel}}: {{kpiValue}} (stated). Re-aim the target, or close the goal with a verdict if its criteria are met.",
    defaultChannels: ["in_app"],
    ttl: 0,
    groupBy: "trackId",
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open goal",
        variant: "primary",
        handler: { type: "navigate-object", kind: "track" },
      },
    ],
  },
  {
    /**
     * A goal is IN REVIEW (decision 2, W5 2026-10-23; F1 2026-10-24): every
     * required criterion is met or claimed and at least one claim waits on
     * the judge. Never for an operation (R6). Producer:
     * `refreshGoalJudgements` (services/tracks/goal-review-notice.ts), after
     * a grade on a run filed into the goal, a judge's decision, or a change
     * of judge. To the goal's JUDGE (the owner when none is named).
     * `sourceId` is the goal; `groupKey` one per goal, so a goal in review is
     * ONE open row however many claims land.
     *
     * A JUDGEMENT (`JUDGEMENT_NOTIFICATION_TYPES`, @synap-core/types/lens):
     * a `decision` in the Inbox, ranked first. Settled only when no claim is
     * left (never on a single decision while others wait), when the judge
     * changes, or when the goal leaves the active category.
     */
    type: "track.review_ready",
    category: "data",
    label: "Goal ready for your verdict",
    icon: "scale",
    priority: "high",
    titleTemplate: "{{trackName}} is ready for your verdict",
    bodyTemplate:
      "Every required criterion is met or claimed. Accept the claims, send one back, or close the goal with a verdict.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open goal",
        variant: "primary",
        handler: { type: "navigate-object", kind: "track" },
      },
    ],
  },
  {
    /**
     * ONE CLAIMED CRITERION waits on the goal's judge (2026-10-24): a run
     * passed it and nobody with the judge's seat accepted it yet — an item on
     * its own, whether or not the whole goal is in review. Producer:
     * `refreshGoalJudgements` (services/tracks/goal-review-notice.ts). To the
     * JUDGE; `sourceId` the goal; `groupKey` one per goal and criterion.
     * Settled when the criterion stops being claimed (accepted, sent back,
     * rejected, regressed), when the judge changes, or when the goal leaves
     * the active category. A JUDGEMENT, ranked first.
     */
    type: "track.criterion_claimed",
    category: "data",
    label: "Claim waiting on your decision",
    icon: "scale",
    priority: "high",
    titleTemplate: "{{claimedBy}} claims “{{criterionStatement}}”",
    bodyTemplate:
      "On {{trackName}}. Accept it, send it back with what to change, or reject it.",
    defaultChannels: ["in_app"],
    ttl: 0,
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open goal",
        variant: "primary",
        handler: { type: "navigate-object", kind: "track" },
      },
    ],
  },
  {
    /**
     * An AGENT proposed to END a goal (code-core F12, 2026-10-24): a close
     * applies only when the goal's JUDGE approves it, a drop only when its
     * owner or judge does (`assertGoalEnder`) — so the proposal is put in
     * THEIR Needs you, not only in every reviewer's queue. Producer:
     * `noticeGoalEndProposed` (services/tracks/goal-review-notice.ts), from
     * the status door (`setTrackStatus`) when governance filed the move.
     * `sourceType: "proposal"`, `sourceId` the proposal: approving, rejecting
     * or expiring it settles the row (`markProposalNotificationsActioned`).
     *
     * A JUDGEMENT (`JUDGEMENT_NOTIFICATION_TYPES`): the goal's ending is
     * theirs to decide.
     */
    type: "track.close_proposed",
    category: "governance",
    label: "Goal end proposed",
    icon: "scale",
    priority: "high",
    titleTemplate: "{{proposerName}} proposes to {{endingVerb}} {{trackName}}",
    bodyTemplate:
      "Verdict: {{verdictLabel}}. Only your approval applies — review the proposal.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "review",
        label: "Review",
        variant: "primary",
        handler: { type: "navigate-object", kind: "proposal" },
      },
    ],
  },
  {
    /**
     * R10 (work model W3, 2026-10-23): a delegate reported their commitment
     * on a goal IMPOSSIBLE and neither the owner nor the judge acknowledged
     * it for 48 h. Producer: `escalateUnacknowledgedReports`
     * (jobs `workers/track-report-escalation.ts`, on the reaper's hourly
     * tick), ONCE per report (`track_participants.escalated_at`). `sourceId`
     * is the goal; `groupKey` the report (participant + when it reported).
     *
     * An ITEM in the owner's Needs you — the acknowledgement is theirs to
     * give; acknowledging the report marks the row actioned
     * (`services/tracks/track-participants.ts`). The report is never the
     * goal's verdict: the body says so.
     */
    type: "track.report_unacknowledged",
    category: "data",
    label: "Goal report waiting on you",
    icon: "alert-triangle",
    priority: "high",
    titleTemplate: "{{delegateName}} says part of {{trackName}} cannot be done",
    bodyTemplate:
      "“{{commitment}}” was reported impossible more than {{hours}} h ago: {{reason}}. Acknowledge it on the goal, ask again, or decide the goal.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open goal",
        variant: "primary",
        handler: { type: "navigate-object", kind: "track" },
      },
    ],
  },
  {
    /**
     * A delegate COUNTERED the commitment they were asked for (W3, review
     * fixes 2026-10-24): the goal's owner — and its judge, when that is
     * someone else — decides whether to ask again with the counter-offer or
     * keep the ask. Producer: `applyTrackParticipantChange`
     * (`services/tracks/track-participants.ts`), on the counter itself.
     * `sourceId` is the goal; `groupKey` the delegate on that goal
     * (`trackCounterGroupKey`). An ITEM in Needs you; settled when that
     * delegate's commitment changes again (asked again, answered, removed)
     * or the goal ends (`goal-end.ts`). Ranked with the JUDGEMENTS
     * (`JUDGEMENT_NOTIFICATION_TYPES`): that part of the goal waits on the
     * answer.
     */
    type: "track.commitment_countered",
    category: "data",
    label: "Counter-offer",
    icon: "message-square",
    priority: "normal",
    titleTemplate: "{{delegateName}} counters on {{trackName}}",
    bodyTemplate:
      "Asked for “{{commitment}}”, they would commit to: {{counterText}}. Ask again with it, or keep the ask.",
    defaultChannels: ["in_app"],
    ttl: 0,
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Review",
        variant: "primary",
        handler: { type: "navigate-object", kind: "track" },
      },
    ],
  },
  {
    /**
     * A PERSON was ASKED to commit to part of a goal by someone else (its
     * owner or judge, or an agent's approved proposal) — the delegate's half
     * of the counter-offer above. Producer: `applyTrackParticipantChange`
     * (`services/tracks/track-participants.ts`), on the ask itself; an agent
     * principal is not told (it answers through its own doors). `sourceId`
     * is the goal; `groupKey` the person on that goal (`trackAskGroupKey`).
     * An ITEM in Needs you, ranked with the JUDGEMENTS: that part of the goal
     * waits on the answer. Settled when they answer (accept, counter,
     * decline), are asked again, are removed, or the goal ends.
     */
    type: "track.commitment_asked",
    category: "data",
    label: "Asked to commit",
    icon: "message-square",
    priority: "normal",
    titleTemplate: "{{askerName}} asks you to commit on {{trackName}}",
    bodyTemplate:
      "“{{commitment}}”. Accept it, counter with what you can commit to, or decline.",
    defaultChannels: ["in_app"],
    ttl: 0,
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Review",
        variant: "primary",
        handler: { type: "navigate-object", kind: "track" },
      },
    ],
  },
  {
    /**
     * A goal this goal waited on (`blocked_by`) ENDED, and that is news:
     * closed and NOTHING else holds it now (the last-open-blocker rule), or
     * dropped (it did not deliver: the goal waits until its owner re-plans).
     * Producer: the `session-unblock-notify` reactor
     * (`notifications/session-unblock-reactor.ts`, code-core F6 — one rule
     * for "a blocker ended"), off the status door's `track.update` status
     * move; re-derived from the rows. `sourceId` is the WAITING goal — where
     * its owner acts.
     */
    type: "track.blocker_ended",
    category: "data",
    label: "Goal it waited on ended",
    icon: "unlink",
    priority: "normal",
    titleTemplate: "{{blockerTitle}} is {{endedWord}}",
    bodyTemplate: "{{dependentTitle}} was waiting on it — {{outcome}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open goal",
        variant: "primary",
        handler: { type: "navigate-object", kind: "track" },
      },
    ],
  },
  {
    /**
     * The goal's LOOP stopped (work model W4): a required criterion failed in
     * two runs of the goal since a person last graded it, so the goal stops
     * proposing its next run and asks its owner — grade it, change it, or
     * switch the loop on again to retry. Producer: `askOwnerLoopStopped`
     * (`services/tracks/goal-loop.ts`), ONCE per stop (its groupKey names the
     * goal, the criterion and the second failing run; the producer checks the
     * row exists — the hourly re-check re-reads a stopped goal). An ITEM in
     * the owner's Needs you: the loop waits on their call. `sourceId` is the
     * goal.
     */
    type: "track.loop_stopped",
    category: "ai",
    label: "Goal stopped proposing runs",
    icon: "user-check",
    priority: "high",
    titleTemplate: "Needs your call: {{trackName}}",
    bodyTemplate:
      "{{criterionStatement}} — failed in {{runs}} runs, so the goal stopped proposing new ones. Grade it, change it, or switch the loop on again to retry.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "Open goal",
        variant: "primary",
        handler: { type: "navigate-object", kind: "track" },
      },
    ],
  },
  // ── Governance ────────────────────────────────────────────────────────────
  {
    type: "proposal.created",
    category: "governance",
    label: "AI Proposal",
    icon: "bot",
    priority: "high",
    titleTemplate: "Review: {{proposalType}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "approve",
        label: "Approve",
        variant: "primary",
        handler: {
          type: "mutation",
          procedure: "proposals.approve",
          inputKey: "proposalId",
        },
      },
      {
        id: "reject",
        label: "Reject",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
      {
        id: "review",
        label: "Review",
        variant: "secondary",
        // Deciding without reading is the failure mode this row exists to
        // avoid. `sourceId` is the proposalId.
        handler: { type: "navigate-object", kind: "proposal" },
      },
    ],
    ttl: 0,
    groupBy: "agentUserId",
  },
  {
    type: "proposal.auto_approved",
    category: "governance",
    label: "Auto-Approved Action",
    icon: "check-circle",
    priority: "low",
    titleTemplate: "Auto-approved: {{proposalType}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    // Proactive twin of the approve-time preflight: a pending proposal whose
    // target workspace the owner can no longer reach will FAIL on approve. Surface
    // it before they try. Hygiene, not blocking → `normal` (reserve high/urgent for
    // live approvals + auth-expired). Deduped per workspace+reason via groupBy.
    type: "governance.proposal_stale",
    category: "governance",
    label: "Stale Proposal",
    icon: "clock-alert",
    priority: "normal",
    titleTemplate: "Can't be approved: {{proposalType}}",
    bodyTemplate: "Its {{reason}} — withdraw it or re-run fresh.",
    defaultChannels: ["in_app"],
    actions: [
      {
        id: "withdraw",
        label: "Withdraw",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
    groupBy: "reason",
  },
  {
    // A newer intake prompt version is rejected clearly more often than the one
    // before it (same engine + model, minimum sample on both sides). Producer:
    // `services/intake/prompt-version-regression.ts` (daily cron), once per
    // regression per pod admin. No action: the prompt lives in the IS and no
    // pod write reverts it.
    type: "intake.prompt_version_regression",
    category: "ai",
    label: "Prompt quality regression",
    icon: "trending-down",
    priority: "normal",
    titleTemplate: "Prompt {{promptVersion}} is rejected more often",
    bodyTemplate:
      "{{newerRejectPct}}% of {{newerDecided}} reviewed proposals rejected vs {{previousRejectPct}}% of {{previousDecided}} for {{previousPromptVersion}} ({{engine}} / {{model}}).",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai_request.vault_access",
    category: "governance",
    label: "Vault Access Request",
    icon: "shield",
    priority: "urgent",
    titleTemplate: "AI needs {{secretType}} for {{service}}",
    bodyTemplate: "{{purpose}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "open_vault",
        label: "Open Vault",
        variant: "primary",
        handler: { type: "navigate", app: "vault" },
      },
      {
        id: "deny",
        label: "Deny",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "ai_request.terminal_exec",
    category: "governance",
    label: "Terminal Command Request",
    icon: "terminal",
    priority: "urgent",
    titleTemplate: "AI wants to run: {{command}}",
    bodyTemplate: "In: {{cwd}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "allow",
        label: "Allow",
        variant: "primary",
        handler: {
          type: "mutation",
          procedure: "proposals.approve",
          inputKey: "proposalId",
        },
      },
      {
        id: "deny",
        label: "Deny",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  {
    type: "connector.sync.complete",
    category: "data",
    connectionNotice: "info",
    label: "Connector Sync Complete",
    icon: "refresh-cw",
    priority: "normal",
    titleTemplate: "{{connectorName}} sync complete",
    bodyTemplate: "{{itemCount}} items imported",
    defaultChannels: ["in_app"],
    ttl: 6_000,
  },
  {
    type: "connector.sync.failed",
    category: "data",
    connectionNotice: "problem",
    label: "Connector Sync Failed",
    icon: "alert-circle",
    priority: "high",
    titleTemplate: "{{connectorName}} sync failed",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app", "os"],
    // The producer keys the group on the connector (its target); a failing
    // sync is one row a day, not one per attempt.
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "settings",
        label: "Check Settings",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "connectors" },
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "connector.auth.expired",
    category: "data",
    connectionNotice: "problem",
    label: "Connector Auth Expired",
    icon: "key",
    priority: "high",
    titleTemplate: "{{connectorName}} needs re-authorization",
    bodyTemplate: "Your connection expired. Reconnect to resume syncing.",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "reconnect",
        label: "Reconnect",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "connectors" },
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "entity.created_by_ai",
    category: "data",
    label: "AI Created Entity",
    icon: "sparkles",
    priority: "low",
    titleTemplate: "{{agentName}} created {{entityType}}",
    bodyTemplate: "{{entityTitle}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },

  // ── AI ────────────────────────────────────────────────────────────────────
  {
    type: "skill.triggered",
    category: "ai",
    label: "Skill Activated",
    icon: "zap",
    priority: "normal",
    titleTemplate: "Skill triggered: {{skillName}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 4_000,
  },
  {
    type: "agent.task_complete",
    category: "ai",
    label: "Agent Task Complete",
    icon: "check",
    priority: "normal",
    titleTemplate: "{{agentName}} finished a task",
    bodyTemplate: "{{summary}}",
    defaultChannels: ["in_app"],
    ttl: 6_000,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        handler: { type: "navigate", app: "chat" },
      },
    ],
  },
  {
    type: "agent.task_failed",
    category: "ai",
    label: "Agent Task Failed",
    icon: "alert-triangle",
    priority: "high",
    titleTemplate: "{{agentName}} encountered an error",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app", "os"],
    // Needs-you folds the same agent's failures into ONE row with a count.
    foldBy: "groupKey",
    // Group repeated failures of the same agent in the bell. Producers pass an
    // explicit agentUserId-keyed groupKey; this declares the fallback grouping
    // for any other caller.
    groupBy: "agentName",
    // ONE HOUR, and it is a CONSOLIDATION, not a new rule. This exact cooldown
    // was hand-rolled twice — `AGENT_FAILURE_RENOTIFY_COOLDOWN_MS`, once in the
    // headless A2AI response worker in @synap/jobs and again in
    // `routers/hub-protocol/rest/events.ts`, each with its own pre-insert
    // SELECT over the same `(type, groupKey, createdAt)`. Two copies of a
    // suppression rule is two places for it to drift; declaring it on the type
    // puts it where every producer reaching the one door inherits it.
    // (The worker is named in prose rather than by filename on purpose: the
    // `a2ai-one-door` tripwire scans api/src for the queue-name literal and
    // does NOT strip comments, so spelling the filename here trips it.)
    dedupeWindowMs: 60 * 60 * 1000,
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        handler: { type: "navigate", app: "chat" },
      },
    ],
  },
  {
    type: "agent.insight",
    category: "ai",
    label: "AI Insight",
    icon: "lightbulb",
    priority: "normal",
    titleTemplate: "{{agentName}}: {{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    needsYou: "suggestion",
  },
  {
    // The generic `notification` automation output node (see `case "notification"`
    // in `packages/jobs/src/workers/steps/output.ts`) — an automation AUTHOR wrote
    // this title/body, so it is templated verbatim rather than composed from a
    // fixed sentence. `category`/`priority` used to be per-call config (default
    // 'ai'/'normal'); the service resolves both from the TYPE, not the call, same
    // as every other producer migrated onto this door (`ai.proactive.*`,
    // `agent.task_failed`) — so this entry fixes them at their prior defaults
    // rather than special-casing a per-call override.
    type: "automation.notification",
    category: "ai",
    label: "Automation Notification",
    icon: "bell",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    // The producer (`steps/output.ts`) always keys the group on the
    // automation + its target, so a step that fires every run is one row a
    // day per target, not one per run.
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
  },
  {
    // An automation the system flipped to status='error' has silently stopped
    // running — surface it so the user can fix/re-enable it (absence-is-invisible
    // otherwise). High (a dead automation means work isn't happening). Deduped per
    // automation via groupBy so a persistently-broken one collapses to one row.
    type: "automation.broken",
    category: "system",
    label: "Automation Broken",
    icon: "alert-octagon",
    priority: "high",
    titleTemplate: "Automation stopped: {{automationName}}",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    groupBy: "automationId",
    actions: [
      {
        id: "view",
        label: "View Automation",
        variant: "primary",
        // `sourceId` is the automation id (see `scan-broken-automations.ts`).
        handler: { type: "navigate-object", kind: "automation" },
      },
    ],
  },

  // ── Data: Entity Lifecycle ──────────────────────────────────────────────
  {
    type: "data.entity.deleted",
    category: "data",
    label: "Entity Deleted",
    icon: "trash-2",
    priority: "normal",
    titleTemplate: "Entity deleted: {{entityName}}",
    bodyTemplate: "{{entityType}} was removed",
    defaultChannels: ["in_app"],
    ttl: 6_000,
  },
  {
    type: "data.document.created",
    category: "data",
    label: "Document Created",
    icon: "file-text",
    priority: "low",
    titleTemplate: "New document: {{title}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    type: "data.view.created",
    category: "data",
    label: "View Created",
    icon: "layout-grid",
    priority: "low",
    titleTemplate: "New view: {{title}}",
    bodyTemplate: "{{viewType}} view created",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    type: "data.relation.created",
    category: "data",
    label: "Relation Created",
    icon: "link",
    priority: "low",
    titleTemplate: "New relation: {{sourceTitle}} → {{targetTitle}}",
    bodyTemplate: "{{relationType}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },

  // ── AI: Proactive Messages ──────────────────────────────────────────────
  {
    type: "ai.proactive.morning_briefing",
    category: "ai",
    label: "Morning Briefing",
    icon: "sunrise",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    // `os` joined with its producer (`services/morning-brief/`): one PASSIVE
    // push a day under the `morning-brief` category (`@synap-core/types/push`),
    // silent, never breaking through. Still a suggestion, never counted.
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    // One open brief per person-day: its producer's groupKey is the person's
    // local day (`morning-brief:<YYYY-MM-DD>`), so a racing second tick writes
    // nothing. A producer that passes no groupKey is not deduped.
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    needsYou: "suggestion",
  },
  {
    type: "ai.proactive.weekly_digest",
    category: "ai",
    label: "Weekly Digest",
    icon: "calendar-range",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    needsYou: "suggestion",
  },
  {
    type: "ai.proactive.health_check",
    category: "ai",
    label: "Health Check",
    icon: "heart-pulse",
    priority: "low",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    needsYou: "suggestion",
  },
  {
    type: "ai.proactive.insight",
    category: "ai",
    label: "AI Insight",
    icon: "lightbulb",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    needsYou: "suggestion",
  },
  {
    type: "ai.proactive.nudge",
    category: "ai",
    label: "AI Nudge",
    icon: "sparkles",
    priority: "low",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    needsYou: "suggestion",
  },
  /*
   * `suggestion` and `alert` complete the set. `ProactiveMessageType`
   * (`jobs/src/utils/proactive-post.ts`) has always had SEVEN members while this
   * registry declared five, so routing that producer through
   * `NotificationService.create()` without these two would have made them hit
   * "Unknown notification type — skipping" and stop writing rows ALTOGETHER —
   * trading a silent governance gap for a silent data loss.
   *
   * Both follow their five siblings exactly: `in_app` only, no push. These are
   * AI-INITIATED posts — the agent volunteering something — not a decision owed
   * by the founder, and the two session types in this wave push precisely
   * because work is stopped until they answer. Nothing is stopped here. `alert`
   * is the one that invites a push default and still does not get one: its
   * "alert" is the AI's own word for its message, not a severity this registry
   * can vouch for, and a type whose urgency is decided by the caller must not
   * be allowed to ring a phone by default. A founder who wants either on their
   * phone turns it on per type — which is exactly what the catalogue and the
   * per-type routing rule are for.
   */
  {
    type: "ai.proactive.suggestion",
    category: "ai",
    label: "AI Suggestion",
    icon: "lightbulb",
    priority: "low",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    needsYou: "suggestion",
  },
  {
    type: "ai.proactive.alert",
    category: "ai",
    label: "AI Alert",
    icon: "bell-ring",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    needsYou: "suggestion",
  },

  // ── Library: keep it alive (capture-vs-library decision, wave L5) ──────────────────────
  {
    /**
     * Weekly "Build one group" — the group that has waited longest, offered
     * ONCE a week (the 7-day window on `groupKey` = the person). Producer:
     * `runLibraryKeepAlive` (services/library/keep-alive.ts), daily; a pod
     * setting turns it off (`proactive.setLibraryKeepAlive`). A SUGGESTION,
     * never a pending proposal: a pending approval is Blocking, and nothing
     * here blocks anyone. `sourceId` is the `library_groups` id.
     */
    type: "library.build_suggestion",
    category: "data",
    label: "Build a Library group",
    icon: "library",
    priority: "low",
    titleTemplate: "Build {{groupName}}?",
    bodyTemplate:
      "{{waiting}} kept, the oldest {{waitDays}} days ago. Build it when you're ready.",
    defaultChannels: ["in_app"],
    ttl: 0,
    groupBy: "groupId",
    dedupeWindowMs: 7 * 24 * 60 * 60 * 1000,
    needsYou: "suggestion",
    actions: [
      {
        id: "open",
        label: "Open Library",
        variant: "primary",
        handler: { type: "navigate", app: "library" },
      },
    ],
  },
  {
    /**
     * "From your Library, for <project>" — kept items that match a project the
     * person is working in this week, resurfaced at most once a week per
     * project. Producer: `runLibraryKeepAlive`. A SUGGESTION (see above).
     * `sourceId` is the project id.
     */
    type: "library.resurface",
    category: "data",
    label: "From your Library",
    icon: "library",
    priority: "low",
    titleTemplate: "From your Library, for {{projectName}}",
    bodyTemplate: "{{count}} kept item(s) look related: {{titles}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    groupBy: "projectId",
    dedupeWindowMs: 7 * 24 * 60 * 60 * 1000,
    needsYou: "suggestion",
    actions: [
      {
        id: "open",
        label: "Open Library",
        variant: "primary",
        handler: { type: "navigate", app: "library" },
      },
    ],
  },

  // ── System ────────────────────────────────────────────────────────────────
  {
    type: "pod.update_available",
    category: "system",
    label: "Update Available",
    icon: "download",
    priority: "normal",
    titleTemplate: "Synap {{version}} is available",
    bodyTemplate: "Update when you're ready.",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "update",
        label: "Update Now",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "updates" },
        },
      },
    ],
  },
  {
    // U4: an update the host engine (`synap update`) could not land — rolled
    // back, or worse. Produced once per update id per admin at backend boot
    // (`pod-update-outcome.ts`). `headline`/`detail` are composed there from the
    // engine's own outcome record so the bell says what state the pod is in.
    type: "pod.update_failed",
    category: "system",
    label: "Update Failed",
    icon: "alert-triangle",
    priority: "high",
    titleTemplate: "Update to {{version}} {{headline}}",
    bodyTemplate: "{{detail}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    // News, not an ask: the engine rolled back (or the update failed before
    // changing anything) and nothing waits on the person — it never counts in
    // needs-you, and it goes stale (a later update supersedes it). A FAILED
    // ROLLBACK is the ask, and has its own type below.
    needsYou: "informational",
    expiresAfterMs: STALE_NEWS_EXPIRY_MS,
  },
  {
    // The ONE update outcome that is an ASK, not news: the update failed AND
    // the automatic rollback did not complete, so the pod may be half-upgraded
    // and only a person on the host can fix it ("Run `synap doctor`"). A
    // type of its own so the registry row can say so: the default needs-you
    // role (it counts until read) and no expiry — it is never stale while the
    // pod is broken. Same producer and copy as `pod.update_failed`.
    type: "pod.update_rollback_failed",
    category: "system",
    label: "Update Rollback Failed",
    icon: "alert-triangle",
    priority: "high",
    titleTemplate: "Update to {{version}} {{headline}}",
    bodyTemplate: "{{detail}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    // The invite was the consent: a member who joined by a Pod invite linked
    // their Synap account through a first-party app, and no owner was asked
    // (`services/application-connections/invite-consent.ts`). News for the
    // owners and admins, and a DOOR, never a button that acts from the bell:
    // the app's page in Pod Admin says what was approved and why, and holds
    // "Unlink {email}" (`applicationConnections.unlinkAccount`). `sourceId`
    // is the connection id. NB the browser and relay route tables have no
    // `application_connection` row yet, so the door resolves nowhere there
    // until one is added (it opens Pod Admin's `/applications/sign-in/<id>`).
    type: "application_connection.linked_by_invite",
    category: "governance",
    label: "Account Linked by Invite",
    icon: "user-check",
    priority: "normal",
    titleTemplate: "{{email}} can now sign in as {{memberName}}",
    bodyTemplate:
      "{{memberName}} joined this Pod by your invite, so {{appName}} linked their Synap account without asking you. If this wasn't them, unlink it from the app's page.",
    defaultChannels: ["in_app"],
    ttl: 0,
    needsYou: "informational",
    actions: [
      {
        id: "review",
        label: "Review",
        variant: "primary",
        handler: { type: "navigate-object", kind: "application_connection" },
      },
    ],
  },
  {
    type: "system.capability_update_available",
    category: "system",
    label: "Capability Updates Available",
    icon: "package",
    priority: "normal",
    // `count` + `names` come from the boot reconcile report (the caller). One
    // grouped bell item — never one-per-drifted-capability.
    titleTemplate: "{{count}} capability updates available",
    bodyTemplate: "Updated templates are ready to apply: {{names}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "review",
        label: "Review",
        variant: "primary",
        // Apply lives on the capabilities surface (tRPC applyUpdates), not here.
        handler: { type: "navigate", app: "capabilities" },
      },
    ],
  },
  {
    type: "pod.storage_warning",
    category: "system",
    label: "Storage Warning",
    icon: "hard-drive",
    priority: "high",
    titleTemplate: "Storage at {{percent}}% capacity",
    bodyTemplate: "Consider archiving or cleaning up unused data.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    needsYou: "status",
  },
  {
    // An intelligence service reporting degraded/unhealthy. NOT
    // `connector.auth.expired` — that template asserts an expired credential,
    // and an IS outage is usually something else entirely. The body carries
    // the health endpoint's own detail rather than a guessed cause.
    //
    // OPERATOR-ONLY (P4, founder 2026-10-06). Its one producer
    // (`notify-service-unhealthy.ts`) sends it to the pod OWNER — the pod's
    // admin — plus the operator's Discord notice channel; no other member
    // receives it. It is `informational`, not `status`: it stays in that
    // admin's bell and never becomes the lens STATUS BANNER, because what
    // users see about AI is the ONE availability model
    // (`@synap-core/types/ai-availability`: a calm "AI is offline" with no
    // CTA), not this operator diagnosis. The title never names the internal
    // service ("Intelligence Hub is degraded").
    type: "system.intelligence_degraded",
    category: "system",
    label: "AI Service Degraded",
    icon: "brain-circuit",
    priority: "high",
    titleTemplate: "Operator check: AI service {{healthStatus}}",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    needsYou: "informational",
  },
  {
    type: "system.issuer_pending_approval",
    category: "system",
    label: "Issuer Pending Approval",
    icon: "shield-alert",
    priority: "high",
    titleTemplate: "New external issuer needs approval",
    bodyTemplate: "{{displayName}} ({{issuerUrl}}) requested pod access.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    // News ABOUT an ask, not the ask: the pending issuer is read from
    // `trusted_issuers` as an `access-request` row (signals), which has a door
    // and leaves needs-you on the decision. Counting this row too drew the
    // same ask twice — and this one, with no door, never cleared (bug 1,
    // 2026-10-12). `TrustedIssuerService` actions it when the issuer is decided.
    needsYou: "informational",
  },
  {
    type: "workspace.invite",
    category: "system",
    label: "Workspace Invite",
    icon: "users",
    priority: "high",
    titleTemplate: "You've been invited to {{workspaceName}}",
    bodyTemplate: "by {{inviterName}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    actions: [
      {
        id: "accept",
        label: "Accept",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "workspaces" },
        },
      },
    ],
  },

  // ── Inbox ─────────────────────────────────────────────────────────────────
  {
    type: "inbox.email",
    category: "inbox",
    label: "New Email",
    icon: "mail",
    priority: "normal",
    titleTemplate: "{{subject}}",
    bodyTemplate: "From: {{sender}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "inbox.mention",
    category: "inbox",
    label: "Mention",
    icon: "at-sign",
    priority: "high",
    titleTemplate: "{{sender}} mentioned you",
    bodyTemplate: "{{preview}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
  },
  {
    type: "inbox.priority_item",
    category: "inbox",
    label: "Priority Item",
    icon: "star",
    priority: "high",
    titleTemplate: "{{subject}}",
    bodyTemplate: "AI scored this as high priority",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    // A HUMAN @mentioned another human in a channel/room. Distinct from
    // `inbox.mention` (imported inbox items) and from agent @handles (which route
    // to an AI, never notify a person). Clicking opens the channel in chat.
    type: "chat.mention",
    category: "inbox",
    label: "Mention",
    icon: "at-sign",
    priority: "high",
    titleTemplate: "{{sender}} mentioned you",
    bodyTemplate: "{{preview}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        // The channel IS the destination — routed through the ONE route table,
        // not an app+params pair. `sourceId` on this notification is the
        // channelId (see `channels/send-message.ts`), so no explicit id is
        // needed — and the `{{channelId}}` template that stood here never
        // interpolated (handlers are stored verbatim), so this also fixes a
        // link that shipped the literal braces to the client.
        handler: { type: "navigate-object", kind: "channel" },
      },
    ],
  },
  {
    // Someone replied to a comment thread this person started (Documents v2:
    // a comment is a message in the object's room). `sourceId` is the object
    // room's channelId — the room shows the thread with its jump door. A
    // reply that @mentions the author is a `chat.mention` instead, never both.
    type: "comment.reply",
    category: "inbox",
    label: "Reply to your comment",
    icon: "message-square",
    priority: "normal",
    titleTemplate: "{{sender}} replied to your comment",
    bodyTemplate: "{{preview}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        handler: { type: "navigate-object", kind: "channel" },
      },
    ],
  },
  {
    // The room's owner added this person to a SESSION room
    // (`chat.addRoomMember`). Session rooms are roster-only, so this is the
    // moment the room was shared with them — the notification is their door
    // into it. `sourceId` is the channelId. News, not an ask: it never counts
    // toward needs-you.
    type: "chat.room_member_added",
    category: "inbox",
    label: "Added to a room",
    icon: "user-plus",
    priority: "normal",
    titleTemplate: "{{inviterName}} added you to {{roomTitle}}",
    bodyTemplate: "Open the room to catch up on the work.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    needsYou: "informational",
    actions: [
      {
        id: "view",
        label: "Open room",
        variant: "primary",
        handler: { type: "navigate-object", kind: "channel" },
      },
    ],
  },

  // ── Sessions ──────────────────────────────────────────────────────────────
  {
    /**
     * The LAST open blocker of a session closed, so the work can resume.
     *
     * Fires once per unblocking, not once per closed blocker — a session
     * waiting on three things is not "unblocked" twice while two remain
     * (Asana's rule, and the reason the reactor re-derives `openBlockerIds`
     * instead of reacting to the close alone). A blocker is a session that
     * closed or a GOAL that closed (code-core F6). Producer: the
     * `session-unblock-notify` reactor (`session-unblock-reactor.ts`).
     */
    type: "session.unblocked",
    category: "system",
    label: "Session Unblocked",
    icon: "circle-play",
    priority: "normal",
    titleTemplate: "{{sessionTitle}} is unblocked",
    bodyTemplate: "{{blockerTitle}} closed — nothing else is blocking it.",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "Open Session",
        variant: "primary",
        // `sourceId` is the UNBLOCKED session's id (see the reactor), so no
        // explicit id is needed — the route table resolves it.
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
  {
    /**
     * A GOAL this session waited on (`blocked_by`) was DROPPED: it did not
     * deliver, so the session waits until its owner re-plans. A goal that
     * closed is `session.unblocked` instead, once nothing else holds the
     * session (code-core F6). Producer: the `session-unblock-notify` reactor
     * (`notifications/session-unblock-reactor.ts`). `sourceId` is the
     * waiting session.
     */
    type: "session.blocker_goal_ended",
    category: "system",
    label: "Goal it waited on ended",
    icon: "unlink",
    priority: "normal",
    titleTemplate: "{{blockerTitle}} is {{endedWord}}",
    bodyTemplate: "{{dependentTitle}} was waiting on it — {{outcome}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    dedupeWindowMs: NOTIFICATION_REPEAT_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open Session",
        variant: "primary",
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
  {
    /**
     * "Continue on desktop" — the person asked, from another device, for their
     * own desktop to pick up an object (decision D5, be431bee). Producer: the
     * ONE handoff door, `notifCenter.handoff` (`to: "desktop"`; the older
     * `requestHandoff` is a wrapper over it). `sourceType` is the object's
     * kind (any `HANDOFF_KINDS` member), `sourceId` its id, and the action's
     * kind and view are the row's own (`materializeActions`): a session sent
     * to its room opens the room.
     *
     * In-app ONLY, and capped there (`channelCeiling`): the request came FROM
     * the phone, so pushing it back to the phone is noise, whatever a routing
     * rule says. A running desktop receives it over the user room; a closed
     * one finds it unread in the inbox later. Opening is a click — never
     * automatic.
     */
    type: "handoff.continue",
    category: "system",
    label: "Continue on desktop",
    icon: "monitor",
    priority: "normal",
    titleTemplate: "Continue on desktop: {{title}}",
    // "another device", not "your phone": the door refuses agents, but any
    // human client (relay, CLI, a second desktop) can call it.
    bodyTemplate:
      "Sent from another device. Open it to pick up where you were.",
    defaultChannels: ["in_app"],
    channelCeiling: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "open",
        label: "Open",
        variant: "primary",
        handler: { type: "navigate-object" },
      },
    ],
  },
  {
    /**
     * "Send to phone" — the person asked, from their desktop, for their phone
     * to pick up an object (decision D5; where the verb shows: plan call 11,
     * d28ab079). Producer: `notifCenter.handoff` with `to: "phone"`. Same
     * pointer as `handoff.continue`: `sourceType` = the object's kind,
     * `sourceId` its id, the tap opens relay's own route for it.
     *
     * In-app AND push: the phone is the device that was asked, so the push IS
     * the delivery (a phone that gets no pushes finds it in its inbox). Its
     * push category, `sent-by-you`, is cap-exempt: the person's own ask never
     * spends the daily interruption budget (`@synap-core/types/push`).
     */
    type: "handoff.to_phone",
    category: "system",
    label: "Sent to your phone",
    icon: "smartphone",
    priority: "normal",
    titleTemplate: "From your desktop: {{title}}",
    bodyTemplate:
      "Sent from another device. Open it to pick up where you were.",
    defaultChannels: ["in_app", "os"],
    channelCeiling: ["in_app", "os"],
    ttl: 0,
    actions: [
      {
        id: "open",
        label: "Open",
        variant: "primary",
        handler: { type: "navigate-object" },
      },
    ],
  },
  {
    /**
     * An agent spent its allowed automatic attempts on a REQUIRED criterion and
     * still could not pass it, and the session was evaluated
     * (`evaluate_session`, founder decision E3), so the grade is now the
     * founder's to make.
     *
     * Producer: `escalateFailingCriteria` (`evaluations/record.ts`), in the
     * same branch that files the owed slots — so the slot in the needs-you
     * tray and the notification can never disagree about whether an
     * escalation happened.
     *
     * Category `ai`, not `governance`: nothing is being APPROVED here. The
     * governance category is the proposal lane (approve/reject an AI's write);
     * this is an AI handing back a judgement it could not make. `system` would
     * be a lie too — no component is unhealthy. Priority `high`, and BOTH
     * channels: the work is stopped until the founder answers, which is the
     * definition of an interrupt.
     *
     * ONE per session, not one per criterion — `dedupeWindowMs` on a
     * session-keyed groupKey. A second criterion escalating in the same run is
     * the same news and must not be a second push.
     */
    type: "session.criterion_escalated",
    category: "ai",
    label: "Criterion needs your call",
    icon: "user-check",
    priority: "high",
    titleTemplate: "Needs your call: {{sessionTitle}}",
    bodyTemplate:
      "{{criterionStatement}} — checked {{attempts}} times and still not passing. Mark it pass or fail.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    groupBy: "sessionId",
    dedupeWindowMs: SESSION_ATTENTION_DEDUPE_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open session",
        variant: "primary",
        // `sourceId` is the session id (see the producer), so the route table
        // resolves it — and `pushTarget()` reads THIS handler to give the push
        // its `{kind,id}`, so the tap and the button land on one screen.
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
  {
    /**
     * An AGENT handed the person work in a session, or asked them something in
     * its room — the work waits on them. Producer: `notifySessionNeedsYou`
     * (`services/focus-sessions/notify-needs-you.ts`), called by every door that
     * can newly hand a slot to the person (block_output, addOutput, a PATCH or
     * create declaring an `owner: 'human'` slot, a followed playbook's
     * unanswered param, a headless run's owed param) and by `post_message` with
     * `kind: 'question'` in a session room. The door set is pinned by
     * `__tripwires__/needs-you-every-handoff-door.test.ts`.
     *
     * Never for the person's OWN write (no acting agent ⇒ no row).
     *
     * `high` + BOTH channels: a hand-off is work that has stopped until they
     * answer — the same definition of an interrupt the escalation uses. ONE per
     * session per window (session-keyed `dedupeWindowMs`): three slots and a
     * question in one working block are one piece of news, one push.
     */
    type: "session.needs_you",
    category: "ai",
    label: "Session needs you",
    icon: "hand",
    priority: "high",
    titleTemplate: "Needs you: {{sessionTitle}}",
    bodyTemplate: "{{summary}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    groupBy: "sessionId",
    dedupeWindowMs: SESSION_ATTENTION_DEDUPE_WINDOW_MS,
    // The push is the interrupt; the live need is the owed slot or the open
    // question. Counting the row too would count one need twice, and would
    // keep counting it after the need was met.
    needsYou: "session-pointer",
    actions: [
      {
        id: "view",
        label: "Open session",
        variant: "primary",
        // `sourceId` is the session id (see the producer).
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
  {
    /**
     * A session closed with required criteria still unmet. Producer: the
     * `session-criteria-unmet-notify` reactor
     * (`session-criteria-unmet-reactor.ts`), off the close door's
     * `focus_session.closed` emit.
     *
     * PRIOR ART SAYS THIS SHOULD NOT PUSH, and the founder overrode it
     * knowingly. A finished-but-flagged result is not, by the usual rule, an
     * interrupt — the work is over; nothing is waiting on the person. The
     * founder's counter is that a session closing flagged is precisely the
     * moment a course correction is cheap, and that the override is safe
     * BECAUSE it is toggleable per type. That toggle is the load-bearing half:
     * do not remove the `os` default without also removing the setting, and do
     * not remove the setting while this default stands.
     *
     * Priority `normal`, not `high`: nothing is blocked. Category `ai` — same
     * lane as the escalation, and for the same reason (an AI's judgement about
     * work, not a governance approval).
     */
    type: "session.closed.criteria_unmet",
    category: "ai",
    label: "Closed with criteria unmet",
    icon: "flag",
    priority: "normal",
    titleTemplate: "Closed and flagged: {{sessionTitle}}",
    bodyTemplate:
      "{{statusLabel}} with {{unmetSummary}} — open the session to decide what to do.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    groupBy: "sessionId",
    dedupeWindowMs: SESSION_ATTENTION_DEDUPE_WINDOW_MS,
    // The push stays (above); the COUNT does not: the session is closed, so
    // nothing waits on the person — news about finished work, never an ask.
    // Its door still opens the session. It goes stale with the work.
    needsYou: "informational",
    expiresAfterMs: STALE_NEWS_EXPIRY_MS,
    actions: [
      {
        id: "view",
        label: "Open session",
        variant: "primary",
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
];

// Fast lookup map (built once at module init)
export const NOTIFICATION_REGISTRY_MAP = new Map<string, NotificationDef>(
  NOTIFICATION_REGISTRY.map((def) => [def.type, def])
);

export function getNotificationDef(type: string): NotificationDef | undefined {
  return NOTIFICATION_REGISTRY_MAP.get(type);
}

/**
 * Types whose producer was DELIBERATELY retired. Their legacy unread rows are
 * news nobody will ever act on, so they are `"informational"` — out of
 * needs-you, still in the bell's history. Named, never inferred: an unknown
 * type NOT on this list stays an `"item"` (below), because a type we cannot
 * classify might still be an ask.
 *
 * - `session.room_update` — an agent's plain room update produces no
 *   notification at all (founder decision F, 2026-09-25); migration 0281
 *   marks its open rows read.
 */
export const RETIRED_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "session.room_update",
]);

/**
 * The needs-you role of a notification type — its registry row's `needsYou`,
 * `"item"` when the row omits it. A RETIRED type
 * ({@link RETIRED_NOTIFICATION_TYPES}) is `"informational"`. Any other unknown
 * type is an `"item"`: an unread row nobody can classify stays visible rather
 * than silently dropping out of the count.
 */
/** How unread rows of `type` fold in needs-you (see `NotificationDef.foldBy`). */
export function needsYouFoldBy(type: string | undefined): "groupKey" | null {
  if (!type) return null;
  return NOTIFICATION_REGISTRY_MAP.get(type)?.foldBy ?? null;
}

export function needsYouRole(
  type: string | undefined
): NotificationNeedsYouRole {
  if (!type) return "item";
  const def = NOTIFICATION_REGISTRY_MAP.get(type);
  if (def) return def.needsYou ?? "item";
  return RETIRED_NOTIFICATION_TYPES.has(type) ? "informational" : "item";
}
