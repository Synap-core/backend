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
  askFingerprint,
  resolveAskResolution,
  type Ask,
  type AskAnswerValue,
} from "../ask/index.js";

// ─── Categories ─────────────────────────────────────────────────────────────

export const PUSH_CATEGORIES = [
  "blocking-ask",
  "decision-blocking",
  "work-broke",
  "mention",
  "system",
  "morning-brief",
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
 * is opt-in. The morning brief is the ONE passive push that replaces every
 * per-event push for non-blocking work, so it is on.
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
  mention: {
    defaultOn: true,
    level: "interruptive",
    interruptionLevel: "active",
  },
  system: { defaultOn: false, level: "passive", interruptionLevel: "passive" },
  "morning-brief": {
    defaultOn: true,
    level: "passive",
    interruptionLevel: "passive",
  },
};

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
  "proposal.created": "blocking-proposal",
  "ai_request.vault_access": "decision-blocking",
  "ai_request.terminal_exec": "decision-blocking",
  // Something you own broke; the fix needs you.
  "agent.task_failed": "work-broke",
  "session.closed.criteria_unmet": "work-broke",
  "connector.auth.expired": "work-broke",
  // A person addressed you by name.
  "chat.mention": "mention",
  "workspace.invite": "mention",
  // Health — the Settings mark carries it; a push only if opted in.
  "pod.storage_warning": "system",
  "system.intelligence_degraded": "system",
  "system.issuer_pending_approval": "system",
  // The daily ritual door.
  "push.morning_brief": "morning-brief",
  // Not a 10-second decision: in-app / Home only.
  "connector.sync.failed": null,
  "inbox.mention": null,
  "chat.room_member_added": null,
};

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

/** `HH:MM`, 24h, the person's own clock (`users.timezone`). */
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isPushClockTime(v: unknown): v is string {
  return typeof v === "string" && HH_MM.test(v);
}

/** Default morning-brief time, the person's local clock. */
export const MORNING_BRIEF_DEFAULT_AT = "08:00";

/**
 * The stored shape (`notification_preferences.push_prefs`). SPARSE: a category
 * the person never touched is absent and reads as its default — never as off.
 */
export interface PushPrefs {
  categories?: Partial<Record<PushCategory, boolean>>;
  /** `HH:MM` local; absent ⇒ {@link MORNING_BRIEF_DEFAULT_AT}. */
  morningBriefAt?: string;
}

/**
 * Parse whatever the column holds into a `PushPrefs`, dropping anything that
 * is not a known category with a boolean or a valid clock time. A malformed
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
  if (isPushClockTime(r.morningBriefAt)) out.morningBriefAt = r.morningBriefAt;
  return out;
}

export function isPushCategoryEnabled(
  prefs: PushPrefs | null | undefined,
  category: PushCategory
): boolean {
  const set = prefs?.categories?.[category];
  return typeof set === "boolean" ? set : PUSH_CATEGORY_POLICY[category].defaultOn;
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

/** The morning-brief local time in effect. */
export function morningBriefAt(prefs: PushPrefs | null | undefined): string {
  return prefs?.morningBriefAt ?? MORNING_BRIEF_DEFAULT_AT;
}

// ─── Where a tap lands ──────────────────────────────────────────────────────

/**
 * The tap target, in the `{kind, id, view?}` vocabulary both clients' ONE
 * route table already speaks, plus `slot` for the owed page's query param.
 * `kind: "home"` has no object: it is the Home tab.
 */
export type PushTarget =
  | { kind: "owed"; id: string; slot: string }
  | { kind: "session"; id: string; view?: "room" }
  | { kind: "proposal"; id: string }
  | { kind: "home" };

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

/** The morning brief is the daily door to Home. */
export const MORNING_BRIEF_TARGET: PushTarget = { kind: "home" };

// ─── Quick answers from the lock screen ─────────────────────────────────────

/**
 * The OS action categories relay registers (`setNotificationCategoryAsync`).
 * Button titles are STATIC on iOS — a category is registered before any push
 * arrives and cannot carry an option's label — so a `choose` ask is
 * answerable from the lock screen only through its ONE recommended option
 * ("Use recommended"; the push body names it). Every action requires device
 * authentication (Face ID): an answer is a governance act.
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

// ─── The payload on the wire ────────────────────────────────────────────────

/**
 * What the pod puts in the Expo message's `data`, beyond the fields it has
 * always sent (`notificationId`, `type`, `category`, `sourceType`, `sourceId`,
 * `deepLink`, and the flat `kind`/`id`/`view` route-table target). Additive:
 * an older relay ignores these and keeps routing on `kind`/`id`.
 */
export interface PushPayloadExtras {
  pushCategory: PushCategory;
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

// ─── Morning brief copy ─────────────────────────────────────────────────────

/**
 * "3 need you · 4 landed overnight". `null` when both are zero: a brief with
 * nothing in it is not sent (Home already says "All clear").
 */
export function morningBriefBody(counts: {
  needsYou: number;
  landed: number;
}): string | null {
  const parts: string[] = [];
  if (counts.needsYou > 0)
    parts.push(`${counts.needsYou} ${counts.needsYou === 1 ? "needs" : "need"} you`);
  if (counts.landed > 0) parts.push(`${counts.landed} landed overnight`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
