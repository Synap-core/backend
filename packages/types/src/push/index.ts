/**
 * PUSH — what earns a phone interruption, where its tap lands, and what can be
 * answered from the lock screen. ONE contract: the pod classifies and builds
 * the payload with it, relay registers its OS categories and routes taps with
 * it, and any settings surface lists the person's toggles from it.
 *
 * THE RULE (design-relay §5.2): a push is earned only by "an agent is blocked
 * on you" or "something you own broke". Everything else lives in the in-app
 * tray and on Home. `proposal.created` used to push on EVERY proposal — the
 * single biggest noise source — so a proposal pushes only when it blocks an
 * open session or run (`proposalBlocksOpenSession`, a fact the pod computes).
 *
 * THREE DECISIONS, kept apart on purpose:
 *   1. `classifyPush(type, facts)` — is this notification push-WORTHY at all,
 *      and under which category? `null` = never push (in-app only).
 *   2. `isPushCategoryEnabled(prefs, category)` — did the PERSON turn that
 *      category off? Defaults come from {@link PUSH_CATEGORY_POLICY}.
 *   3. The pod's existing routing (mute / quiet hours / per-type rules) — the
 *      transport, unchanged; this leaf does not restate it.
 *
 * An UNKNOWN notification type classifies to `null`. A new type therefore
 * never rings a phone until someone decides it should — the pod's tripwire
 * (`push-classification-covers-os-types.test.ts`) requires every registry type
 * that defaults to the `os` channel to be named in {@link PUSH_TYPE_RULES}.
 *
 * Pure and dependency-free apart from sibling leaves.
 */

import {
  askAnswersInline,
  askCardView,
  askFingerprint,
  askTextRestates,
  resolveAskResolution,
  stripAskVerbPrefix,
  type Ask,
  type AskAnswerValue,
} from "../ask/index.js";
import { humanizeToken } from "../vocabulary/index.js";
import { isUuid } from "../property-render/structured-value.js";

// ─── Categories ─────────────────────────────────────────────────────────────

export const PUSH_CATEGORIES = [
  "blocking-ask",
  "decision-blocking",
  "work-broke",
  "late-or-stuck",
  "mention",
  "morning-brief",
  "delivered-digest",
  "sent-by-you",
  "system",
] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export function isPushCategory(v: unknown): v is PushCategory {
  return (
    typeof v === "string" && (PUSH_CATEGORIES as readonly string[]).includes(v)
  );
}

/**
 * How hard a push interrupts.
 *   `interruptive` — sound, banner, breaks through Focus when time-sensitive.
 *   `passive`      — lands silently in the notification list.
 */
export type PushLevel = "interruptive" | "passive";

/** The iOS `interruptionLevel` Expo forwards (Expo push message field). */
export type PushInterruptionLevel = "time-sensitive" | "active" | "passive";

export interface PushCategoryPolicy {
  /** On unless the person turns it off (`true`), or opt-in (`false`). */
  defaultOn: boolean;
  level: PushLevel;
  interruptionLevel: PushInterruptionLevel;
}

/**
 * Defaults follow design-relay §5.2's table. `system` (storage, degraded
 * intelligence, issuer approval) belongs on the Settings health mark, so it
 * is opt-in.
 *
 * `morning-brief` ("3 need you", one PASSIVE push a day at the person's
 * chosen time) joined with its producer (`api/src/services/morning-brief/`,
 * W0 of the status-flow plan, 2026-10-29). Passive: it lands silently in the
 * notification list and never breaks through, so it costs no interruption.
 *
 * `delivered-digest` ("what agents delivered since your last digest", plan
 * d679e92c C9, wave 065982de W3-notify) is raised by the same daily pass as
 * the brief, at most once a day and only when something was delivered.
 * Passive, and OUTSIDE the interruption budget
 * ({@link PUSH_CAP_EXEMPT_CATEGORIES}): it is news the person asked for by
 * keeping it on, never an agent waiting on them.
 */
export const PUSH_CATEGORY_POLICY: Readonly<
  Record<PushCategory, PushCategoryPolicy>
> = {
  "blocking-ask": {
    defaultOn: true,
    level: "interruptive",
    interruptionLevel: "time-sensitive",
  },
  "decision-blocking": {
    defaultOn: true,
    level: "interruptive",
    interruptionLevel: "time-sensitive",
  },
  "work-broke": {
    defaultOn: true,
    level: "interruptive",
    interruptionLevel: "active",
  },
  // A status signal (status-flow W6): on, but silent — it is news about a
  // thing you own, not an agent waiting on you.
  "late-or-stuck": {
    defaultOn: true,
    level: "passive",
    interruptionLevel: "passive",
  },
  mention: {
    defaultOn: true,
    level: "interruptive",
    interruptionLevel: "active",
  },
  "morning-brief": {
    defaultOn: true,
    level: "passive",
    interruptionLevel: "passive",
  },
  "delivered-digest": {
    defaultOn: true,
    level: "passive",
    interruptionLevel: "passive",
  },
  // The person pressed "Send to phone" on their desktop a moment ago: the
  // push is the delivery they asked for (decision D5, be431bee). On, with a
  // sound, never time-sensitive (they are holding the other device).
  "sent-by-you": {
    defaultOn: true,
    level: "interruptive",
    interruptionLevel: "active",
  },
  system: { defaultOn: false, level: "passive", interruptionLevel: "passive" },
};

// ─── Labels ─────────────────────────────────────────────────────────────────

/** What a settings row says for a category: a name and one line under it. */
export interface PushCategoryLabel {
  name: string;
  hint: string;
}

/**
 * The ONE wording of each push category. Lives beside the category list (not
 * in `../vocabulary`) so a new category cannot compile without its label —
 * the `Record<PushCategory, …>` type is the coverage floor. Read it through
 * {@link resolvePushCategoryLabel}; never humanize the token.
 */
export const PUSH_CATEGORY_LABELS: Readonly<
  Record<PushCategory, PushCategoryLabel>
> = {
  "blocking-ask": {
    name: "Questions that block your work",
    hint: "Work is stopped until you answer",
  },
  "decision-blocking": {
    name: "Decisions that block your work",
    hint: "Work is stopped until you decide",
  },
  "work-broke": {
    name: "When something breaks",
    hint: "A task failed, a session fell short, or a connection expired",
  },
  "late-or-stuck": {
    name: "When something is late or stuck",
    hint: "A date passed or is close, a step took too long, or a pause is due for review",
  },
  mention: {
    name: "When you're mentioned",
    hint: "Someone names you or invites you to a space",
  },
  "morning-brief": {
    name: "Your morning brief",
    hint: "One quiet summary a day of what waits on you",
  },
  "delivered-digest": {
    name: "What got delivered",
    hint: "One quiet summary a day of what agents finished for you",
  },
  "sent-by-you": {
    name: "What you send to this phone",
    hint: "Things you send from your desktop with Send to phone",
  },
  system: {
    name: "System notices",
    hint: "Storage, intelligence and pod health",
  },
};

/**
 * The label for a category. An unknown value (a newer pod) humanizes rather
 * than leaking the raw token, with no hint.
 */
export function resolvePushCategoryLabel(category: string): PushCategoryLabel {
  return isPushCategory(category)
    ? PUSH_CATEGORY_LABELS[category]
    : { name: humanizeToken(category), hint: "" };
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Facts only the pod can know, computed per notification. Every field is
 * optional: an absent fact reads as the QUIET answer (no push), never the loud
 * one — a producer that forgot to compute it costs an interruption, not a
 * 3am false alarm.
 */
export interface PushFacts {
  /**
   * `proposal.created`: the proposal was filed from an OPEN session or run the
   * agent was explicitly working in (not the receipt bucket the pod mints for
   * a stray agent write), so that work waits on the decision.
   */
  proposalBlocksOpenSession?: boolean;
}

/**
 * `PushCategory` — always this category. `"blocking-proposal"` — the
 * `decision-blocking` category ONLY when {@link PushFacts.proposalBlocksOpenSession}.
 * `null` — named on purpose: this type never pushes (in-app / Home only).
 */
export type PushTypeRule = PushCategory | "blocking-proposal" | null;

/**
 * Every notification type that decides a push, named. Keys are the pod's
 * registry type strings. A `null` entry is a DECISION (design-relay §5.2 "NO"
 * row), not an omission — the pod tripwire tells the two apart.
 */
export const PUSH_TYPE_RULES: Readonly<Record<string, PushTypeRule>> = {
  // An agent is stopped until you answer.
  "session.needs_you": "blocking-ask",
  // The grade is now the person's to make and the work waits on it. Its
  // producer files the owed slot WITHOUT a `session.needs_you`, so this row IS
  // that ask's only push (design-relay §5.2 wants it folded into the ask; until
  // the producer does that, dropping it would leave the escalation silent).
  "session.criterion_escalated": "blocking-ask",
  // A goal's loop stopped on a criterion that failed twice (W4): it proposes
  // nothing more until its owner answers.
  "track.loop_stopped": "blocking-ask",
  "proposal.created": "blocking-proposal",
  "ai_request.vault_access": "decision-blocking",
  "ai_request.terminal_exec": "decision-blocking",
  // A goal is in review: every required criterion is claimed and the work
  // waits on its judge's verdict (W5, 2026-10-23).
  "track.review_ready": "decision-blocking",
  // One claimed criterion waits on the goal's judge (in-app only).
  "track.criterion_claimed": "decision-blocking",
  // An agent proposed to end a goal; only its judge's (or owner's) approval
  // applies (code-core F12).
  "track.close_proposed": "decision-blocking",
  // Something you own broke; the fix needs you.
  "agent.task_failed": "work-broke",
  "session.closed.criteria_unmet": "work-broke",
  // A delegate said part of your goal cannot be done and nobody acknowledged
  // it for 48 h (R10, W3): the goal's plan broke and waits on the owner.
  "track.report_unacknowledged": "work-broke",
  "connector.auth.expired": "work-broke",
  // The status watcher noticed a thing you own is late, close to its date,
  // stuck in its step, or its pause is due for review (status-flow W6).
  "entity.signal": "late-or-stuck",
  "track.signal": "late-or-stuck",
  "session.signal": "late-or-stuck",
  // A person addressed you by name.
  "chat.mention": "mention",
  "workspace.invite": "mention",
  // The once-a-day summary of what waits on you (passive, never rings).
  "ai.proactive.morning_briefing": "morning-brief",
  // What agents delivered since the last digest (passive, at most once a day,
  // outside the daily cap).
  "ai.proactive.delivered_digest": "delivered-digest",
  // The person sent it from their desktop ("Send to phone", decision D5).
  "handoff.to_phone": "sent-by-you",
  // Health — the Settings mark carries it; a push only if opted in.
  "pod.storage_warning": "system",
  "system.intelligence_degraded": "system",
  "system.issuer_pending_approval": "system",
  // Not a 10-second decision: in-app / Home only.
  "connector.sync.failed": null,
  "inbox.mention": null,
  "chat.room_member_added": null,
};

// ─── The interruption budget ────────────────────────────────────────────────

/**
 * At most this many pushes a day per person (plan Q4.1, founder 2026-10-29):
 * the push past it is not sent — the notification still lands in-app and in
 * needs-you, where the morning brief carries it. The day is the person's own.
 */
export const PUSH_DAILY_CAP = 3;

/**
 * Categories the cap never holds back and never counts: "something you own
 * broke" (incidents and failures, plan Q5.2) always reaches the phone, and
 * so does what the person sent to it themselves (`sent-by-you`): the budget
 * limits how often the POD interrupts, never the person's own ask. The
 * delivered digest is its own class (plan d679e92c C9): passive, at most one a
 * day by its producer, so it neither spends nor is held back by the budget.
 */
export const PUSH_CAP_EXEMPT_CATEGORIES: readonly PushCategory[] = [
  "work-broke",
  "sent-by-you",
  "delivered-digest",
];

/** The notification types whose push the cap never counts (derived, never listed). */
export function pushCapExemptTypes(): string[] {
  return Object.entries(PUSH_TYPE_RULES)
    .filter(
      ([, rule]) =>
        rule !== null &&
        rule !== "blocking-proposal" &&
        PUSH_CAP_EXEMPT_CATEGORIES.includes(rule)
    )
    .map(([type]) => type);
}

/** The category a notification pushes under, or `null` (do not push). */
export function classifyPush(
  notificationType: string,
  facts: PushFacts = {}
): PushCategory | null {
  const rule = Object.prototype.hasOwnProperty.call(
    PUSH_TYPE_RULES,
    notificationType
  )
    ? PUSH_TYPE_RULES[notificationType]
    : null;
  if (rule === "blocking-proposal") {
    return facts.proposalBlocksOpenSession === true
      ? "decision-blocking"
      : null;
  }
  return rule ?? null;
}

// ─── The person's preferences ───────────────────────────────────────────────

/**
 * The stored shape (`notification_preferences.push_prefs`). SPARSE: a category
 * the person never touched is absent and reads as its default — never as off.
 */
export interface PushPrefs {
  categories?: Partial<Record<PushCategory, boolean>>;
  /**
   * Sessions whose pushes the person muted (plan d679e92c C9): every push
   * ABOUT one of them is held back — devbox jobs, dev signals, room activity,
   * and its asks too. Nothing is hidden: the row still lands in the bell and
   * an owed ask stays in needs-you; only the phone stops ringing
   * ({@link isSessionPushMuted}). Absent = none muted.
   */
  mutedSessions?: string[];
}

/** At most this many muted sessions are kept (the oldest mute drops first). */
export const PUSH_MUTED_SESSIONS_MAX = 200;

/**
 * Categories a session mute never holds back: what the person sent to their
 * phone themselves is their own ask, not the session's noise.
 */
export const PUSH_MUTE_EXEMPT_CATEGORIES: readonly PushCategory[] = [
  "sent-by-you",
];

/** Has the person muted this session's pushes? */
export function isSessionPushMuted(
  prefs: PushPrefs | null | undefined,
  sessionId: string | null | undefined
): boolean {
  if (!sessionId) return false;
  const id = sessionId.toLowerCase();
  return (prefs?.mutedSessions ?? []).includes(id);
}

/**
 * Parse whatever the column holds into a `PushPrefs`, dropping anything that
 * is not a known category with a boolean. A malformed
 * value degrades to defaults for THAT key only.
 */
export function normalizePushPrefs(raw: unknown): PushPrefs {
  const out: PushPrefs = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const cats = r.categories;
  if (cats && typeof cats === "object" && !Array.isArray(cats)) {
    const kept: Partial<Record<PushCategory, boolean>> = {};
    for (const [k, v] of Object.entries(cats as Record<string, unknown>)) {
      if (isPushCategory(k) && typeof v === "boolean") kept[k] = v;
    }
    if (Object.keys(kept).length > 0) out.categories = kept;
  }
  const muted = r.mutedSessions;
  if (Array.isArray(muted)) {
    const ids = [
      ...new Set(
        muted
          .filter((v): v is string => typeof v === "string")
          .filter((v) => isUuid(v))
          .map((v) => v.toLowerCase())
      ),
    ].slice(-PUSH_MUTED_SESSIONS_MAX);
    if (ids.length > 0) out.mutedSessions = ids;
  }
  return out;
}

export function isPushCategoryEnabled(
  prefs: PushPrefs | null | undefined,
  category: PushCategory
): boolean {
  const set = prefs?.categories?.[category];
  return typeof set === "boolean"
    ? set
    : PUSH_CATEGORY_POLICY[category].defaultOn;
}

export interface EffectivePushCategory extends PushCategoryPolicy {
  category: PushCategory;
  enabled: boolean;
  /** `true` when the person set it; `false` when it is the default. */
  explicit: boolean;
}

/** Every category with its effective state — what a settings list renders. */
export function effectivePushCategories(
  prefs: PushPrefs | null | undefined
): EffectivePushCategory[] {
  return PUSH_CATEGORIES.map((category) => {
    const set = prefs?.categories?.[category];
    return {
      category,
      ...PUSH_CATEGORY_POLICY[category],
      enabled: isPushCategoryEnabled(prefs, category),
      explicit: typeof set === "boolean",
    };
  });
}

// ─── Where a tap lands ──────────────────────────────────────────────────────

/**
 * The tap target, in the `{kind, id, view?}` vocabulary both clients' ONE
 * route table already speaks, plus `slot` for the owed page's query param.
 */
export type PushTarget =
  | { kind: "owed"; id: string; slot: string }
  | { kind: "session"; id: string; view?: "room" }
  | { kind: "proposal"; id: string };

/**
 * A blocking ask lands ON THE ASK (`/owed/<sessionId>?slot=<label>`), not on
 * the session page. Without exactly one slot to name it lands on the session —
 * an honest fallback, never a guessed slot.
 */
export function blockingAskTarget(
  sessionId: string,
  slotLabels: readonly string[]
): PushTarget {
  const [only, ...rest] = slotLabels;
  return only && rest.length === 0
    ? { kind: "owed", id: sessionId, slot: only }
    : { kind: "session", id: sessionId };
}

// ─── Quick answers from the lock screen ─────────────────────────────────────

/**
 * The OS action categories relay registers (`setNotificationCategoryAsync`).
 * Button titles are STATIC on iOS — a category is registered before any push
 * arrives and cannot carry an option's label — so a `choose` ask is
 * answerable from the lock screen only through its ONE recommended option
 * ("Use recommended"; the push body names it). Every action requires device
 * authentication (Face ID): an answer is a governance act.
 *
 * NO DESTRUCTIVENESS CHECK, knowingly. design-relay §5.3 offers Yes/No "only
 * when the answer is not destructive", but an ask carries no signal of what
 * its answer will cause: a slot answer hands input BACK to the agent, it
 * never executes a write itself (every write the agent then makes is still
 * governed). So no ask is refused a quick answer for being destructive; if
 * asks ever gain a consequence field, gate `quickAnswerFor` on it here.
 */
export const PUSH_QUICK_ANSWER_CATEGORIES = {
  "ask-confirm": [
    { id: "yes", title: "Yes" },
    { id: "no", title: "No" },
  ],
  "ask-choose-recommended": [{ id: "recommended", title: "Use recommended" }],
  "ask-act": [{ id: "done", title: "I did it" }],
} as const;
export type PushQuickAnswerCategory = keyof typeof PUSH_QUICK_ANSWER_CATEGORIES;
export type PushQuickActionId =
  (typeof PUSH_QUICK_ANSWER_CATEGORIES)[PushQuickAnswerCategory][number]["id"];

/** Every quick action requires the device to be unlocked (Face ID). */
export const PUSH_QUICK_ACTION_REQUIRES_AUTH = true;

export interface PushQuickAction {
  id: PushQuickActionId;
  /**
   * The typed answer sent to `focusSessions.answerOutput` as `value`. Absent
   * for `done`, which goes through `focusSessions.attestOutput`.
   */
  value?: AskAnswerValue;
}

/**
 * Everything a notification action handler needs to answer WITHOUT reading the
 * pod first: the slot coordinate, the door, the fingerprint of the ask the
 * push showed (so the pod refuses with `ask_changed:` if the agent re-asked),
 * and one prebuilt answer per action.
 */
export interface PushQuickAnswer {
  category: PushQuickAnswerCategory;
  /** `answer` ⇒ `focusSessions.answerOutput`; `attest` ⇒ `attestOutput`. */
  door: "answer" | "attest";
  sessionId: string;
  expectedLabel: string;
  askFingerprint: string;
  actions: PushQuickAction[];
}

/**
 * The quick answer for one owed slot's ask, or `null` (tap opens the ask).
 *   confirm                                   → Yes / No
 *   choose, inline-answerable (≤ 3 options, no "Other…"), ONE recommended
 *                                             → Use recommended
 *   act                                       → I did it
 * Everything else — form, provide, a free-text slot, a choose without a
 * recommendation — needs a screen.
 */
export function quickAnswerFor(
  slot: { sessionId: string; label: string },
  ask: Ask | null | undefined
): PushQuickAnswer | null {
  if (!ask) return null;
  const base = {
    sessionId: slot.sessionId,
    expectedLabel: slot.label,
    askFingerprint: askFingerprint(ask),
  };
  if (ask.mode === "confirm") {
    return {
      ...base,
      category: "ask-confirm",
      door: "answer",
      actions: [
        { id: "yes", value: { type: "confirm", confirmed: true } },
        { id: "no", value: { type: "confirm", confirmed: false } },
      ],
    };
  }
  if (ask.mode === "choose" && askAnswersInline(ask)) {
    const recommended = ask.options.filter((o) => o.recommended === true);
    if (recommended.length !== 1) return null;
    return {
      ...base,
      category: "ask-choose-recommended",
      door: "answer",
      actions: [
        { id: "recommended", value: { type: "chip", chip: recommended[0]! } },
      ],
    };
  }
  if (ask.mode === "act" && resolveAskResolution(ask) === "attest") {
    return {
      ...base,
      category: "ask-act",
      door: "attest",
      actions: [{ id: "done" }],
    };
  }
  return null;
}

/** Longest single line the lock-screen body quotes (iOS shows ~4 lines). */
const PUSH_BODY_LINE_MAX = 160;

function clipLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > PUSH_BODY_LINE_MAX
    ? `${t.slice(0, PUSH_BODY_LINE_MAX - 1)}…`
    : t;
}

/**
 * The push BODY for a quick-answerable ask: the lock-screen buttons must
 * answer a question the push SHOWS. `null` when the ask has no quick answer
 * (the notification's own body stands).
 *   confirm → the card's question (`askCardView`): "<label>: <prompt>", the
 *             label dropped when the prompt restates it; with no prompt,
 *             "<label>: <why>". A recommended answer adds "Recommended: …".
 *   choose  → "<label>: <why>" + a line "Recommended: <option>".
 *   act     → "<label>: <why, else the first step>".
 */
export function quickAnswerPushBody(
  slot: { label: string; why?: string | null },
  ask: Ask | null | undefined
): string | null {
  const q = quickAnswerFor({ sessionId: "", label: slot.label }, ask);
  if (!q || !ask) return null;
  const why = slot.why?.trim() || "";
  const head = (detail: string) =>
    clipLine(detail ? `${slot.label}: ${detail}` : slot.label);
  if (ask.mode === "confirm") {
    const card = askCardView({ label: slot.label, why: slot.why, ask });
    const label = stripAskVerbPrefix(slot.label) || slot.label.trim();
    const line = ask.prompt?.trim()
      ? askTextRestates(label, card.heading)
        ? card.heading
        : `${label}: ${card.heading}`
      : card.context
        ? `${card.heading}: ${card.context}`
        : card.heading;
    const rec = card.answers.find((a) => a.recommended);
    return rec
      ? `${clipLine(line)}\n${clipLine(`Recommended: ${rec.label}`)}`
      : clipLine(line);
  }
  if (ask.mode === "choose") {
    const chip = q.actions[0]?.value;
    const rec = chip?.type === "chip" ? chip.chip.label : "";
    return `${head(why)}\n${clipLine(`Recommended: ${rec}`)}`;
  }
  if (ask.mode === "act") return head(why || ask.steps?.[0]?.trim() || "");
  return null;
}

// ─── The payload on the wire ────────────────────────────────────────────────

/**
 * What the pod puts in the Expo message's `data`, beyond the fields it has
 * always sent (`notificationId`, `type`, `category`, `sourceType`, `sourceId`,
 * `deepLink`, and the flat `kind`/`id`/`view` route-table target). Additive:
 * an older relay ignores these and keeps routing on `kind`/`id`.
 */
export interface PushPayloadExtras {
  pushCategory: PushCategory;
  /**
   * The sending pod's public origin (`https://pod.example.com`). A quick
   * answer is sent ONLY when it equals the signed-in pod's origin; absent
   * (PUBLIC_URL unset, or an older pod) ⇒ answer as before.
   */
  podUrl?: string;
  /** The owed page's slot, beside the flat `kind: "owed"` / `id`. */
  slot?: string;
  quickAnswer?: PushQuickAnswer;
}

/** Expo message fields the pod sets from the category (Expo push API names). */
export interface PushEnvelope {
  interruptionLevel: PushInterruptionLevel;
  /** iOS stacks pushes sharing one thread (a session's asks). */
  threadId?: string;
  /** Registered OS action category, when the push is quick-answerable. */
  categoryId?: PushQuickAnswerCategory;
  /** A passive push makes no sound. */
  sound: "default" | null;
}

export function pushEnvelope(
  category: PushCategory,
  opts: { threadId?: string; quickAnswer?: PushQuickAnswer | null } = {}
): PushEnvelope {
  const policy = PUSH_CATEGORY_POLICY[category];
  return {
    interruptionLevel: policy.interruptionLevel,
    sound: policy.level === "passive" ? null : "default",
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
    ...(opts.quickAnswer ? { categoryId: opts.quickAnswer.category } : {}),
  };
}

// ─── Phones ─────────────────────────────────────────────────────────────────

/**
 * A phone's push row (`messaging_accounts`, provider `expo`), by status:
 *   `connected`    — gets pushes.
 *   `disconnected` — the app signed out, Expo said the token is dead, or it
 *                    went unused for {@link PUSH_DEVICE_STOP_DAYS}. The next
 *                    registration from that phone turns it back on.
 *   `revoked`      — the person turned it off from ANOTHER device. A plain
 *                    re-registration leaves it off; only a re-enable sent by
 *                    that phone itself turns it back on.
 */
export const PUSH_DEVICE_STATUSES = [
  "connected",
  "disconnected",
  "revoked",
] as const;
export type PushDeviceStatus = (typeof PUSH_DEVICE_STATUSES)[number];

/** A phone unused this long reads "Not seen lately". */
export const PUSH_DEVICE_NOT_SEEN_DAYS = 30;
/** A phone unused this long stops getting pushes (`disconnected`). */
export const PUSH_DEVICE_STOP_DAYS = 90;

/** One row of `notifCenter.listDevices` (dates are ISO strings over JSON). */
export interface PushDeviceRow {
  id: string;
  /** The name the phone reported (`Constants.deviceName`), if any. */
  name: string | null;
  platform: string | null;
  appVersion: string | null;
  status: string;
  /**
   * The last time the app registered. `null` for a phone whose app does not
   * register on every launch: its last registration says nothing about use,
   * so it is never shown as last seen and never stopped for being unused.
   */
  lastSeenAt: Date | string | null;
  createdAt: Date | string;
  revokedAt: Date | string | null;
  /** True only when the caller passed this phone's own token. */
  isThisDevice: boolean;
}

/** What a phone row shows, in order of how much it needs the person. */
export type PushDeviceState = "on" | "not-seen" | "off" | "turned-off";
/** The status pill's tone (the console's `StatusKind` names). */
export type PushDeviceTone = "healthy" | "stale" | "unknown";

export interface PushDeviceView {
  id: string;
  label: string;
  /** "iOS" / "Android", or null when the phone did not say. */
  platform: string | null;
  appVersion: string | null;
  state: PushDeviceState;
  tone: PushDeviceTone;
  statusLabel: string;
  /** One plain sentence: what this state means for the person. */
  explain: string;
  lastSeenAt: Date | null;
  addedAt: Date | null;
  /** Whether "Stop notifications" applies (everything but already turned off). */
  canTurnOff: boolean;
  isThisDevice: boolean;
}

const PLATFORM_WORDS: Readonly<Record<string, string>> = {
  ios: "iOS",
  android: "Android",
};

const STATE_COPY: Readonly<
  Record<
    PushDeviceState,
    { tone: PushDeviceTone; statusLabel: string; explain: string }
  >
> = {
  on: {
    tone: "healthy",
    statusLabel: "On",
    explain: "Gets your notifications.",
  },
  "not-seen": {
    tone: "stale",
    statusLabel: "Not seen lately",
    explain: `Not used in over ${PUSH_DEVICE_NOT_SEEN_DAYS} days. Notifications to it stop after ${PUSH_DEVICE_STOP_DAYS} days without use, and start again when it opens the app.`,
  },
  off: {
    tone: "unknown",
    statusLabel: "Off",
    explain:
      "Gets no notifications. They start again the next time it opens the app signed in.",
  },
  "turned-off": {
    tone: "unknown",
    statusLabel: "Turned off",
    explain:
      "Turned off from another device. Only this phone can turn notifications back on, from its own settings.",
  },
};

/** The words every surface uses around a phone. */
export const PUSH_DEVICE_COPY = {
  turnOffAction: "Stop notifications",
  turnOffTitle: (label: string) => `Stop notifications to ${label}?`,
  turnOffConsequence:
    "This phone stops getting notifications from this pod right away, and stays off when the app opens again. To get them back, turn notifications on from that phone.",
  /** Shown ON a phone that was turned off from elsewhere. */
  thisDeviceTurnedOff: {
    title: "Notifications are off for this phone",
    body: "They were turned off from another device.",
    action: "Turn back on",
  },
  empty:
    "No phone gets your notifications yet. Sign in to the Synap app on your phone and allow notifications.",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The state a row reads as. An unknown status (a newer pod) reads as `off`:
 * the quiet answer, never a promise that pushes arrive.
 */
export function pushDeviceState(
  row: Pick<PushDeviceRow, "status" | "lastSeenAt">,
  now: Date = new Date()
): PushDeviceState {
  if (row.status === "revoked") return "turned-off";
  if (row.status !== "connected") return "off";
  const seen = toDate(row.lastSeenAt);
  return seen &&
    now.getTime() - seen.getTime() > PUSH_DEVICE_NOT_SEEN_DAYS * DAY_MS
    ? "not-seen"
    : "on";
}

/** One phone, ready to render. Dates stay dates: each surface formats them. */
export function pushDeviceView(
  row: PushDeviceRow,
  now: Date = new Date()
): PushDeviceView {
  const state = pushDeviceState(row, now);
  const platform = row.platform
    ? (PLATFORM_WORDS[row.platform] ?? humanizeToken(row.platform))
    : null;
  const name = row.name?.trim();
  return {
    id: row.id,
    label: name || (platform ? `${platform} device` : "Phone"),
    platform,
    appVersion: row.appVersion?.trim() || null,
    state,
    ...STATE_COPY[state],
    lastSeenAt: toDate(row.lastSeenAt),
    addedAt: toDate(row.createdAt),
    canTurnOff: state !== "turned-off",
    isThisDevice: row.isThisDevice,
  };
}

const STATE_ORDER: Readonly<Record<PushDeviceState, number>> = {
  on: 0,
  "not-seen": 1,
  off: 2,
  "turned-off": 3,
};

/**
 * List order: this phone first, then phones that get pushes, then the rest;
 * within a state, the most recently seen (else added) first.
 */
export function comparePushDevices(
  a: PushDeviceView,
  b: PushDeviceView
): number {
  if (a.isThisDevice !== b.isThisDevice) return a.isThisDevice ? -1 : 1;
  const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (byState !== 0) return byState;
  const at = (v: PushDeviceView) => (v.lastSeenAt ?? v.addedAt)?.getTime() ?? 0;
  return at(b) - at(a);
}

/**
 * A phone's facts line, the parts that are known: "This phone · iOS · app
 * 1.4.0 · seen 2d ago" (or "added …" for an app that does not report each
 * launch). Each surface formats the relative time its own way.
 */
export function pushDeviceFacts(
  view: Pick<
    PushDeviceView,
    "isThisDevice" | "platform" | "appVersion" | "lastSeenAt" | "addedAt"
  >,
  formatRelative: (at: Date) => string
): string {
  const seen = view.lastSeenAt
    ? `seen ${formatRelative(view.lastSeenAt)}`
    : view.addedAt
      ? `added ${formatRelative(view.addedAt)}`
      : null;
  return [
    view.isThisDevice ? "This phone" : null,
    view.platform,
    view.appVersion ? `app ${view.appVersion}` : null,
    seen,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}
