/**
 * Signal union + dedupe — the PURE core behind `signals.list` / `signals.count`.
 *
 * ONE signal door, two lenses. `needs-you` is the union of three
 * ALREADY-EXISTING reads: the pending proposal CLUSTERS (`proposals.groups`),
 * the UNREAD notifications (`notifCenter.list`) and the OWED SLOTS
 * (`focusSessions.owed`) — deliverables an agent handed back to the human and
 * nobody has closed. None is re-implemented here — the
 * router calls both doors through their own routers and hands the rows to this
 * file, which is DB-free by construction and unit-testable without a database.
 *
 * THE DEDUPE RULE, and why it exists. Approving a proposal produces BOTH a
 * pending `proposals` row AND a `proposal.created` notification addressed to
 * the reviewer. Counting both is how one decision becomes two badges that never
 * agree. So a proposal is represented by its CLUSTER and only by its cluster:
 *
 *   1. every notification with `sourceType === "proposal"` is dropped, and
 *   2. every notification whose `sourceId` matches a proposal id already
 *      sampled by a cluster is dropped (belt-and-braces: it catches a
 *      proposal-backed notification stamped with some other sourceType).
 *
 * Rule 2 is a subset-check, not a guarantee: `sampleProposalIds` is capped
 * (`DEFAULT_SAMPLE_CAP` = 20 in fingerprint.ts), so a cluster larger than the
 * cap cannot expose every member id. Rule 1 is the load-bearing one and does
 * not depend on the sample at all.
 *
 * TITLES ARE NEVER GENERATED HERE. A notification's title is the column the
 * registry template already evaluated. A cluster's title goes through
 * `buildObjectActionTitle` — the vocabulary SSOT (`@synap-core/types/vocabulary`),
 * the same door every other proposal surface uses — so a signal card and a
 * proposal card can never render the same change with two different verbs.
 */

import type { RuleRunFacts } from "./rule-runs.js";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { ASK_COPY } from "@synap-core/types/ask";
import { needsYouTotal } from "@synap-core/types/units";
import {
  SUGGESTIONS_CAP,
  type GroupableSignal,
} from "@synap-core/types/needs-you";
import {
  isObjectNavView,
  type ObjectNavView,
} from "@synap-core/types/navigation";
import type { ActivityRow } from "@synap-core/types/activity";
import type { LandedObjectRow } from "@synap-core/types/landed";
import type { SessionActivityLive } from "@synap-core/types/run-activity";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import type { ExpectedOutput, OutputRef, SlotAsk } from "@synap/playbooks";
import type { OwedSlot } from "../focus-sessions/owed-outputs.js";
import type { ProposalCluster } from "../proposals/fingerprint.js";
import type { ProposalClass } from "../proposals/proposal-class.js";
import { needsYouFoldBy, needsYouRole } from "../../notifications/registry.js";

/** What a signal points AT — an object-nav address the browser can dispatch. */
export interface SignalTarget {
  /** An `objectNavTarget` kind: `proposal`, `channel`, `entity`, `automation`… */
  kind: string;
  id: string;
  /**
   * Optional view reading of that object (`'room'` = a session's Intake Room).
   * Only a member of `OBJECT_NAV_VIEWS` (`@synap-core/types/navigation`) — the
   * same allowlist the clients re-check with `isObjectNavView`.
   */
  view?: ObjectNavView;
}

export type SignalKind =
  /** A collapsed group of identical-shape pending proposals. */
  | "proposal-cluster"
  /** One unread, non-proposal notification. */
  | "notification"
  /** A past `events` row — a DATA change (history lens / Happened). */
  | "event"
  /**
   * One `activity.list` ledger row — a governed act, a decision, a run or a
   * session lifecycle (history lens / Happened). The ledger row itself rides
   * in `activity`, verbatim, so its actor / verb / outcome / Undo door are
   * never re-derived here. (Replaced `decided-proposal`: the ledger's
   * `decision` and `proposal` sources carry every decided proposal.)
   */
  | "activity"
  /**
   * A session an agent is working on RIGHT NOW (Happening) — the one rule,
   * `isSessionWorkingNow` over `loadSessionLiveness`. Its facts ride in `live`.
   */
  | "live-session"
  /**
   * A RULE whose runs opened no session, running inside the working window
   * (Happening) — one row per rule, its runs folded (`foldRuleRuns`,
   * `services/signals/rule-runs.ts`). Its facts ride in `ruleRun`.
   */
  | "rule-run"
  /**
   * One object a session PRODUCED (Produced) — an `outputs.landed` row,
   * verbatim, in `landed`.
   */
  | "output"
  /** One deliverable an agent handed to the human and nobody has closed. */
  | "owed-slot"
  /**
   * One undecided agent DRAFT that asks the person something — "<agent>
   * started <work> · asks you N things". Its asks are not listed one by one
   * (`excludeDrafts`) until the draft is accepted; answering any of them
   * accepts it (`accept-on-engagement.ts`). Proposals under a draft stay out.
   */
  | "draft-asks"
  /**
   * One session whose next move is the person's ACCEPTANCE (`needsYouReason`
   * = `"review"`, THE needs-you rule's third population). Emitted under a
   * bare PROJECT scope only — the one scope that counts it — so the project
   * badge and the project list are one number over one predicate (W2 review).
   */
  | "session-review";

/** One row in either lens. Deliberately identical in both, so the tray and the
 *  history feed render from ONE shape. */
export interface Signal {
  id: string;
  kind: SignalKind;
  /** Human title, taken from data on the row — never composed ad hoc. */
  title: string;
  /** How many underlying things this row stands for (1 unless a cluster). */
  count: number;
  occurredAt: Date;
  /** Object-nav address, or null when the source has no addressable target. */
  target: SignalTarget | null;
  /** Notification category vocabulary: governance | data | ai | system | inbox. */
  category: string;
  /**
   * The CLASS of thing that would unblock an `owed-slot` — one of the closed
   * six (`credential | permission | capability | policy | decision | physical`).
   * Absent on every other kind, the same way `class` is cluster-only.
   *
   * Carried on the SIGNAL rather than re-fetched, deliberately. The owed door
   * is reached through `floorLens`, which maps an ABSENT workspace to `[]`
   * because `resolveScope` would otherwise fall back to the request header —
   * a rule whose own comment records that it "has shipped broken twice". A
   * surface that fetched the reason itself would have to reproduce that
   * mapping, which is the fork the lens helper exists to prevent.
   */
  blockedReason?: ExpectedOutput["blockedReason"];
  /** One line naming WHICH thing is missing — the resumption cue. `owed-slot` only. */
  why?: string;
  /** The agent's own (unverified) claim it produced this after all. `owed-slot` only. */
  claimedDone?: boolean;
  /**
   * The session's declared goal — WHAT WORK this slot came from. Absent on
   * every other kind, the same way `why`/`blockedReason` are owed-slot-only.
   * Without it a blocked row can say a reason and an age but not the work it
   * blocks, which is the single most useful context for deciding whether to
   * act on it now.
   */
  sessionGoal?: string | null;
  /**
   * The session's DISPLAY NAME (`resolveSessionTitle`: its title, else the
   * goal's first line) — what a needs-you card names a session that owes
   * several things by. `owed-slot` / `draft-asks` / `session-review`, and a
   * `proposal-cluster` filed under a session the viewer can read, only;
   * absent on an older pod, where a reader falls back to `sessionGoal`.
   */
  sessionTitle?: string | null;
  /**
   * The owning session's project — the card's rail colour. `owed-slot` /
   * `draft-asks` / a session-filed `proposal-cluster` only; `null` when the session is in no project. Named
   * `sessionProjectId` because it is the SESSION's scope, not the signal's:
   * no other kind carries a scope, and a surface must guard it.
   */
  sessionProjectId?: string | null;
  /**
   * The owed slot's OWN `kind` (`ExpectedOutput.kind`) — NOT this signal's
   * `kind`, which is the union's discriminator and is already `"owed-slot"`.
   * Named `slotKind` for exactly that reason.
   *
   * It is here because one slot kind takes a DIFFERENT VERB: an escalated
   * criterion (`CRITERION_SLOT_KIND`) is a grade the human owes, so a tray
   * offering "I did this" / attest on it marks the slot done while the
   * criterion stays failing and the verdict never moves. Without this field a
   * tray cannot tell the two apart — and the previous classification withheld
   * `kind` on the reasoning that renderers draw icons from `category`, which
   * was true of ICONS and wrong about VERBS.
   */
  slotKind?: string;
  /**
   * For a criterion slot, the `SessionCriterion.key` it stands for — the exact
   * companion to `slotKind`, and it travels for the same reason: `slotKind`
   * tells a tray this row takes the GRADE verb, and this tells it WHICH
   * criterion to open the scorecard on.
   *
   * It is a key, never the prose label: the label is `Check: <statement>`
   * clipped at 120 chars, and matching it back in a UI would fork the
   * backend's label format into every surface. Absent on ordinary slots and on
   * criterion slots filed before the field existed — absence means "open the
   * scorecard without highlighting", never an error, and never a licence to
   * fall back to label matching.
   */
  criterionKey?: string;
  /**
   * WHERE the agent pointed the person for an `owed-slot` (its
   * `ExpectedOutput.ref`) — named `slotRef` because `target` is already this
   * signal's own door (the session). Carried so a tray row can open the thing
   * the blocker is about without re-reading the session. Absent when the slot
   * declared no pointer, and on every other kind.
   */
  slotRef?: OutputRef;
  /**
   * HOW the person can answer an `owed-slot` (its `ExpectedOutput.ask`) —
   * carried so the tray can quick-answer a confirm / choose in place instead of
   * opening the session. Absent ⇒ today's verbs (free text / I did this).
   */
  ask?: SlotAsk;
  /**
   * Decision CLASS of a `proposal-cluster` signal, carried straight off the
   * cluster (which derives it through `proposalClassFields`, the one door).
   * Absent on every other kind — a notification, an event or an owed slot has
   * no class. In particular an owed slot does NOT get a sixth `ProposalClass`
   * invented for it: `class` is a PROPOSAL's decision class, consumed as an
   * ordering over proposals, and an obligation is not a decision. Its absent
   * `lifetimeHours` already carries the only thing a surface needs to know —
   * that it never expires.
   *
   * (This paragraph sat above `blockedReason`, thirty lines up, where two
   * docblocks had been stacked back to back. Whoever edited `blockedReason`
   * read an argument about proposals; whoever edited `class` found it
   * undocumented.)
   */
  class?: ProposalClass;
  /**
   * Hours this class stays answerable; `null` when it never expires. Carried
   * WITH `class` and only with it, for the same reason `ProposalClassFields`
   * returns the pair: a surface that shows the ephemeral countdown must never
   * re-derive the lifetime from a table it does not own.
   */
  lifetimeHours?: number | null;
  /**
   * WHERE the row came from — the small provenance door (lens grammar §5: a
   * source is shown only when it differs from the page's scope; the client
   * decides that with `visibleSource`, `@synap-core/types/lens`). The most
   * specific readable container: the SESSION a row belongs to, else the
   * PROJECT a session-row sits in. Absent when the row has no readable
   * container (a pod-level notification) — never a guessed one.
   */
  source?: SignalSource;
  /** `live-session` only: the liveness facts the "working now" rule read. */
  live?: SessionActivityLive;
  /**
   * `rule-run` only: the rule's runs inside the window — how many, how many
   * failed, whether one is in flight. The row's door is the rule.
   */
  ruleRun?: RuleRunFacts;
  /** `output` only: the produced object, as `outputs.landed` returns it. */
  landed?: LandedObjectRow;
  /** `activity` only: the ledger row, as `activity.list` returns it. */
  activity?: ActivityRow;
  /**
   * `event` only, and only when the event is a RECORD CHANGE
   * (`parseRecordChange`: `{subject}.{crud}.completed`): the act, the record's
   * kind (its profile slug when the event named one) and the writer when it is
   * not the default API path. The lens page draws it as a data line
   * (`happenedItems`, `@synap-core/types/lens`).
   */
  event?: { action: string; objectKind: string; origin: string | null };
  /**
   * `notification` only: the registry type (`notifications.type`) — what the
   * lens model classifies a row by (a work-broke failure is Blocking with an
   * Open verb and no "Asked by AI" mark; `FAILURE_NOTIFICATION_TYPES`,
   * `@synap-core/types/lens`). Absent on every other kind.
   */
  notificationType?: string;
  /**
   * WHICH block this row belongs to on a needs-you page. `session:<id>` for
   * everything a session owes the person (its owed slots, its draft-asks row,
   * a cluster filed entirely under it), `proposal-cluster:<fingerprint>` for
   * any other cluster, else `null`. The union
   * emits rows sharing a key CONTIGUOUSLY ({@link orderNeedsYou}), so a
   * surface draws a group header exactly where the key changes and never
   * re-groups on its own.
   */
  groupKey: string | null;
  /**
   * `older` when `occurredAt` is more than {@link OLDER_AFTER_MS} ago, else
   * `recent`. Computed HERE, once, so every surface folds the same rows under
   * "Older" — a client that measured age itself would fold by its own clock.
   */
  ageBucket: SignalAgeBucket;
  /**
   * How many unread notifications this row folds — the same `(type, target)`
   * raised N times is ONE row with `repeatCount: N` ({@link foldNotifications}).
   * A `rule-run` row folds a rule's runs the same way (`repeatCount` = runs).
   * 1 on every other kind: a cluster says its size through `count`, and an
   * owed slot or a draft is never a repeat of anything.
   */
  repeatCount: number;
}

/**
 * FIELD CLASSIFICATION for {@link Signal} itself — the same compile-time floor
 * the owed-slot projection carries below. A new `Signal` field must be
 * classified as UNIVERSAL (every producer, every kind, sets it — a surface may
 * read it unguarded) or KIND-SPECIFIC (present on some kinds only — a surface
 * must guard it), or the build stops. `groupKey`, `ageBucket` and
 * `repeatCount` are universal because every surface folds and groups on them.
 */
const UNIVERSAL_SIGNAL_FIELDS = [
  "id",
  "kind",
  "title",
  "count",
  "occurredAt",
  "target",
  "category",
  "groupKey",
  "ageBucket",
  "repeatCount",
] as const satisfies ReadonlyArray<keyof Signal>;

const KIND_SPECIFIC_SIGNAL_FIELDS = [
  "blockedReason",
  "why",
  "claimedDone",
  "sessionGoal",
  "sessionTitle",
  "sessionProjectId",
  "slotKind",
  "criterionKey",
  "slotRef",
  "ask",
  "class",
  "lifetimeHours",
  "source",
  "live",
  "ruleRun",
  "landed",
  "activity",
  "event",
  "notificationType",
] as const satisfies ReadonlyArray<keyof Signal>;

type _SignalFieldsClassified =
  Exclude<
    keyof Signal,
    (typeof UNIVERSAL_SIGNAL_FIELDS)[number]
  > extends (typeof KIND_SPECIFIC_SIGNAL_FIELDS)[number]
    ? true
    : never;
const _signalFieldsClassified: _SignalFieldsClassified = true;
void _signalFieldsClassified;

/**
 * Every universal field is REQUIRED on the type — a universal field declared
 * optional would let a producer omit it while the classification claims every
 * producer sets it.
 */
type _UniversalAreRequired =
  Pick<Signal, (typeof UNIVERSAL_SIGNAL_FIELDS)[number]> extends Required<
    Pick<Signal, (typeof UNIVERSAL_SIGNAL_FIELDS)[number]>
  >
    ? true
    : never;
const _universalAreRequired: _UniversalAreRequired = true;
void _universalAreRequired;

/**
 * Every surface shapes this page through ONE leaf (`@synap-core/types/needs-you`,
 * `needsYouRows`). A `Signal` must stay assignable to what that leaf reads, so
 * renaming or retyping `groupKey` / `ageBucket` / `repeatCount` here stops the
 * build instead of silently un-grouping every surface.
 */
const _signalIsGroupable = (s: Signal): GroupableSignal => s;
void _signalIsGroupable;

/** The universal fields, exported for the tests that prove every producer sets them. */
export const SIGNAL_UNIVERSAL_FIELDS: readonly (keyof Signal)[] =
  UNIVERSAL_SIGNAL_FIELDS;

/** See {@link Signal.ageBucket}. */
export type SignalAgeBucket = "recent" | "older";

/**
 * A row's provenance door — the same shape as `LensSource`
 * (`@synap-core/types/lens`): an object-nav kind, an id, a short label.
 */
export interface SignalSource {
  kind: "workspace" | "project" | "track" | "session";
  id: string;
  label: string;
}

/** The session source of a row, when its session is named. */
export function sessionSource(
  sessionId: string,
  title: string | null | undefined
): { source: SignalSource } | Record<string, never> {
  const label = title?.trim();
  return label ? { source: { kind: "session", id: sessionId, label } } : {};
}

/** A needs-you row older than this folds under "Older" (7 days). */
export const OLDER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The age bucket of an instant, against `now`. Pure. */
export function ageBucketOf(occurredAt: Date, now: Date): SignalAgeBucket {
  return now.getTime() - occurredAt.getTime() > OLDER_AFTER_MS
    ? "older"
    : "recent";
}

/** The block key every row a session owes shares. */
export function sessionGroupKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * The minimum a notification row must expose to become a signal. Mirrors the
 * `notifications` columns the reader already selects — no DB dependency.
 */
export interface NotificationSignalInput {
  id: string;
  title: string;
  category: string;
  sourceType: string;
  sourceId: string | null;
  createdAt: Date;
  /**
   * The registry type (`notifications.type`). Read ONLY for the type's
   * `needsYou` role (`needsYouRole`, registry.ts). Optional because this is a
   * DB-free mirror; every real row carries it, and a row without one is an
   * ordinary `"item"`.
   */
  type?: string;
  /**
   * The row's persisted registry actions (`notifications.actions`). Read ONLY
   * for a `navigate-object` action's `view`, so a notification that opens a
   * room from its banner also opens the room from the inbox — one source, the
   * registry row, never a per-type map here.
   */
  actions?: unknown;
  /**
   * The producer's collapse key (`notifications.group_key`). Read ONLY for a
   * type whose registry `foldBy` is `"groupKey"` ({@link foldNotifications}).
   */
  groupKey?: string | null;
}

/**
 * The CONTAINER a notification resolves to, derived from what it points at
 * (`lens-containers.ts`: its session target, or the room its message was
 * posted in) — never a stored column. Only a session the VIEWER may read is
 * ever named, so a container never leaks a session the person cannot open.
 */
export interface NotificationContainer {
  sessionId: string | null;
  /** The session's display name (`resolveSessionTitle`), when it has one. */
  sessionTitle: string | null;
  projectId: string | null;
  trackId: string | null;
}

/**
 * `notifications.source_type` → object-nav kind.
 *
 * Only source types whose `sourceId` is provably an id of the mapped kind are
 * listed. Everything else resolves to `null` (no click-through) rather than
 * being guessed into a route that cannot load — the same graceful no-op
 * `objectNavTarget` already returns for unmapped kinds. `connector` is absent
 * on purpose: its `sourceId` is a CONNECTION id, which is not addressable by
 * any nav kind today.
 */
export const NOTIFICATION_TARGET_KIND: Readonly<Record<string, string>> = {
  proposal: "proposal",
  entity: "entity",
  automation: "automation",
  agent: "run",
  proactive_message: "channel",
  ai_proactive: "channel",
  // `handoff.continue` (notif-center `requestHandoff`) — sourceId is the session id.
  session: "session",
  // `track.kpi_reached` (services/tracks) — sourceId is the track id.
  track: "track",
};

/**
 * Object-nav address for a notification, or null when it has none.
 *
 * `view` comes from the row's own `navigate-object` action, and only when that
 * action addresses the SAME kind with no literal id of its own (so it means
 * this row's `sourceId`) and names an allowlisted view. Anything else — no
 * action, another kind, another object, an unknown view — yields no view.
 */
export function targetFromNotification(
  sourceType: string,
  sourceId: string | null,
  actions?: unknown
): SignalTarget | null {
  if (!sourceId) return null;
  const kind = NOTIFICATION_TARGET_KIND[sourceType];
  if (!kind) return null;
  const view = viewFromActions(actions, kind);
  return view ? { kind, id: sourceId, view } : { kind, id: sourceId };
}

function viewFromActions(
  actions: unknown,
  kind: string
): ObjectNavView | undefined {
  if (!Array.isArray(actions)) return undefined;
  for (const action of actions) {
    const handler =
      typeof action === "object" && action !== null
        ? (action as { handler?: unknown }).handler
        : undefined;
    if (typeof handler !== "object" || handler === null) continue;
    const h = handler as Record<string, unknown>;
    if (h.type !== "navigate-object" || h.kind !== kind || h.id !== undefined)
      continue;
    if (isObjectNavView(h.view)) return h.view;
  }
  return undefined;
}

/**
 * The session a cluster was filed under, as the VIEWER may see it — read
 * through the session read floor (`readClusterSessions`). Present only for a
 * session the viewer can read.
 */
export interface ClusterSessionName {
  title: string | null;
  projectId: string | null;
}

/** One cluster → one signal. Title via the vocabulary SSOT, imperative mood
 *  (the card describes what approving it WILL do, not what happened).
 *
 *  `session` is the viewer-readable name of `cluster.sessionId`. Without it
 *  (the viewer cannot read the session, or the caller did not look it up) the
 *  cluster gets NO session key — it stays its own row, so a session the viewer
 *  may not read is never named nor implied. Fail closed by default. */
export function signalFromCluster(
  cluster: ProposalCluster,
  now: Date = new Date(),
  session?: ClusterSessionName
): Signal {
  const inSession = cluster.sessionId && session ? cluster.sessionId : null;
  const sampleId = cluster.sampleProposalIds[0] ?? null;
  return {
    // A session PART of a split cluster (`splitBySession`) shares its
    // fingerprint with the other parts, so its newest member makes the id
    // unique. Never the session id: a session the viewer cannot read must not
    // leak through a row id (cluster-sessions.pglite.test.ts pins it).
    id:
      cluster.sessionId && sampleId
        ? `cluster:${cluster.fingerprint}@${sampleId}`
        : `cluster:${cluster.fingerprint}`,
    kind: "proposal-cluster",
    title: buildObjectActionTitle({
      action: cluster.proposalType,
      objectKind: cluster.targetType,
      objectName: cluster.targetLabel,
      mood: "imperative",
    }),
    count: cluster.count,
    occurredAt: cluster.latestAt,
    target: sampleId ? { kind: "proposal", id: sampleId } : null,
    // Clusters are always a governance decision — that is what a pending
    // proposal IS. Same category vocabulary the notifications table uses.
    category: "governance",
    // Forwarded, never re-derived: the cluster already carries the pair from
    // `proposalClassFields`, and every member shares it by construction
    // (proposalType + targetType are both fingerprint inputs).
    class: cluster.class,
    lifetimeHours: cluster.lifetimeHours,
    // A cluster filed ENTIRELY under one session the viewer can read belongs
    // to that session's block, so a needs-you page shows the session ONCE (its card counts the
    // decision beside its owed slots). A cluster spanning sessions, or with a
    // member filed under none, stays its own row. Grouping only — `count` and
    // `signals.count` are untouched.
    ...(inSession && session?.title ? { sessionTitle: session.title } : {}),
    ...(inSession && session?.projectId
      ? { sessionProjectId: session.projectId }
      : {}),
    ...(inSession ? sessionSource(inSession, session?.title) : {}),
    groupKey: inSession
      ? sessionGroupKey(inSession)
      : `proposal-cluster:${cluster.fingerprint}`,
    ageBucket: ageBucketOf(cluster.latestAt, now),
    repeatCount: 1,
  };
}

/**
 * One unread notification → one signal. `repeatCount` is how many rows it
 * stands for (see {@link foldNotifications}); `count` says the same thing,
 * because "how many underlying things" is exactly the folded rows.
 */
export function signalFromNotification(
  row: NotificationSignalInput,
  now: Date = new Date(),
  repeatCount = 1,
  container?: NotificationContainer
): Signal {
  // A notification ABOUT a session the viewer can read joins that session's
  // block, like every other row the session owes — so a session never shows
  // as its card AND a loose notification row (needs-you duplicate cause 1).
  const sessionId = container?.sessionId ?? null;
  return {
    id: `notification:${row.id}`,
    kind: "notification",
    title: row.title,
    count: repeatCount,
    occurredAt: row.createdAt,
    target: targetFromNotification(row.sourceType, row.sourceId, row.actions),
    category: row.category,
    ...(row.type ? { notificationType: row.type } : {}),
    ...(sessionId && container?.sessionTitle
      ? { sessionTitle: container.sessionTitle }
      : {}),
    ...(sessionId && container?.projectId
      ? { sessionProjectId: container.projectId }
      : {}),
    ...(sessionId ? sessionSource(sessionId, container?.sessionTitle) : {}),
    groupKey: sessionId ? sessionGroupKey(sessionId) : null,
    ageBucket: ageBucketOf(row.createdAt, now),
    repeatCount,
  };
}

/**
 * Fold unread notifications per `(type, target)`: the same news about the
 * same object, raised N times, is ONE row carrying the NEWEST instance and
 * `repeatCount: N`. Pure; the list and the count both fold through here, so a
 * folded row counts once in the badge exactly as it lists once.
 *
 * A row with no `sourceId` folds on `(type, sourceType, title)` instead: the
 * registry evaluated the title from the row's data, so two targetless rows of
 * one type with the SAME rendered title say the same thing (needs-you
 * duplicate cause 2 — "Weekly digest ready" raised five times was five
 * rows). Two targetless rows whose titles differ stay apart: different news.
 */
export function foldNotifications(
  rows: readonly NotificationSignalInput[]
): Array<{ row: NotificationSignalInput; repeatCount: number }> {
  const folds = new Map<
    string,
    { row: NotificationSignalInput; repeatCount: number }
  >();
  for (const r of rows) {
    // A type whose registry `foldBy` is "groupKey" folds on the producer's
    // collapse key: one agent failing on nine runs is ONE row ×9.
    const key =
      r.groupKey && needsYouFoldBy(r.type) === "groupKey"
        ? `group\u0000${r.type}\u0000${r.groupKey}`
        : r.sourceId
          ? `${r.type ?? ""}\u0000${r.sourceType}\u0000${r.sourceId}`
          : `untargeted\u0000${r.type ?? ""}\u0000${r.sourceType}\u0000${r.title}`;
    const seen = folds.get(key);
    if (!seen) folds.set(key, { row: r, repeatCount: 1 });
    else {
      seen.repeatCount += 1;
      if (r.createdAt.getTime() > seen.row.createdAt.getTime()) seen.row = r;
    }
  }
  return [...folds.values()];
}

/**
 * The minimum an owed slot must expose to become a signal. A DB-free mirror of
 * the fields `listOwedSlots` (`focus-sessions/owed-outputs.ts`) already
 * projects — nothing is re-derived here.
 */
export interface OwedSlotSignalInput {
  sessionId: string;
  /** The DECLARED label. It is the title, verbatim — see below. */
  label: string;
  /** ISO-8601, written by the block door. The ordering key. */
  owedSince: string;
  /**
   * The three disclosure fields, carried from `listOwedSlots` straight through.
   * Optional here because a slot blocked before these existed has none — and an
   * absent reason must render as "no reason recorded", never as a guessed one.
   */
  blockedReason?: ExpectedOutput["blockedReason"];
  why?: string;
  claimedDone?: boolean;
  /** The owning session's declared goal, straight from `listOwedSlots`. */
  sessionGoal?: string | null;
  /** The owning session's display name, straight from `listOwedSlots`. */
  sessionTitle?: string | null;
  /** The owning session's project, straight from `listOwedSlots`. */
  projectId?: string | null;
  /**
   * The slot's own `ExpectedOutput.kind`, straight from `listOwedSlots`.
   * Optional here only because this input is a DB-free mirror; every real slot
   * carries one.
   */
  kind?: string;
  /**
   * The criterion key of a criterion slot, straight from `listOwedSlots`.
   * Optional for the same reason as `kind`, plus back-compat: an older slot
   * carries none.
   */
  criterionKey?: string;
  /** The slot's pointer, straight from `listOwedSlots`. */
  ref?: OutputRef;
  /** The slot's ask, straight from `listOwedSlots`. */
  ask?: SlotAsk;
}

/**
 * FIELD CLASSIFICATION for {@link OwedSlot} — every field is either PROJECTED
 * onto the signal or DELIBERATELY WITHHELD, and the compile-time check below
 * enforces that a new field can land in neither silently. This projection has
 * already dropped a field twice without a build error to say so: the three
 * disclosure fields (be0abb7d) and `sessionGoal` (this change).
 *
 * PROJECTED — reaches the signal, one way or another:
 *   sessionId                       → `target.id` (via `SignalTarget`, not a
 *                                      same-named field)
 *   label                           → `title`, verbatim
 *   owedSince                       → `occurredAt`, via `owedInstant`
 *   sessionGoal                     → `sessionGoal` — the work this slot came
 *                                      from, the context that decides whether
 *                                      to act now
 *   sessionTitle                    → `sessionTitle` — the session's name, what
 *                                      a card folding several of its asks says
 *   projectId                       → `sessionProjectId` — that card's rail
 *                                      colour (the session's scope, named so)
 *   blockedReason, why, claimedDone → carried straight through (be0abb7d)
 *   kind                            → `slotKind` (renamed: `Signal.kind` is
 *                                      the union discriminator). A criterion
 *                                      slot takes a different VERB from an
 *                                      ordinary deliverable, and a tray that
 *                                      cannot tell them apart offers attest on
 *                                      a grade — marking it done while the
 *                                      criterion stays failing.
 *   criterionKey                    → `criterionKey` — WHICH criterion that
 *                                      grade verb applies to, so a tray can
 *                                      open the scorecard ON it. A key, never
 *                                      the prose label, so no surface
 *                                      re-derives this file's label format.
 *   ref                             → `slotRef` (renamed: `target` is the
 *                                      signal's own door, the session) — so a
 *                                      tray row opens the thing the blocker
 *                                      is about without re-reading the session.
 *   ask                             → `ask` — HOW to answer, so a tray can
 *                                      quick-answer a confirm / choose in place.
 *
 * DELIBERATELY WITHHELD — a real field, not surfaced today, and here is why:
 *   sessionStatus  → no `owed-slot` surface renders a session-lifecycle chip;
 *                     `occurredAt`/age already answers "is this stale". Add it
 *                     if a surface ever needs to tell "still-open session" from
 *                     "obligation survived its session" apart — not before.
 *   workspaceId    → no `Signal` kind carries a space; nothing renders one.
 *                     (`projectId` was withheld here too until the one-list
 *                     card needed its rail colour — it travels as
 *                     `sessionProjectId`, the SESSION's scope, guarded.)
 *   icon           → would let a tray render a per-slot icon, but every
 *                     `Signal` renderer today draws its icon from `category`,
 *                     never from a kind string — undrawn context, not a hole.
 *                     (`kind` was withheld under this same reasoning until it
 *                     turned out to decide the VERB, not the icon.)
 */
const PROJECTED_OWED_SLOT_FIELDS = [
  "sessionId",
  "label",
  "owedSince",
  "sessionGoal",
  "sessionTitle",
  "projectId",
  "blockedReason",
  "why",
  "claimedDone",
  "kind",
  "criterionKey",
  "ref",
  "ask",
] as const satisfies ReadonlyArray<keyof OwedSlot>;

const WITHHELD_OWED_SLOT_FIELDS = [
  "sessionStatus",
  "workspaceId",
  "icon",
] as const satisfies ReadonlyArray<keyof OwedSlot>;

/**
 * COMPILE-TIME coverage floor, the same shape as `update-session.ts`'s
 * `_ServerOwnedCoversEveryField`. A new `OwedSlot` field that is in neither
 * list above makes this alias resolve to `never` and stops the build — the
 * omission becomes a typecheck error instead of a silent, permanent drop.
 */
type _OwedSlotFieldsClassified =
  Exclude<
    keyof OwedSlot,
    (typeof PROJECTED_OWED_SLOT_FIELDS)[number]
  > extends (typeof WITHHELD_OWED_SLOT_FIELDS)[number]
    ? true
    : never;
const _owedSlotFieldsClassified: _OwedSlotFieldsClassified = true;
void _owedSlotFieldsClassified;

/**
 * The sentinel `projectOwedSlots` writes for a slot whose `owedSince` predates
 * the invariant: it must sort as the OLDEST thing there is, not as "now".
 * `new Date("0000-00-00")` is an Invalid Date whose `getTime()` is NaN, and NaN
 * silently loses every comparison in a sort — so the string sentinel is mapped
 * to the epoch rather than parsed.
 */
function owedInstant(owedSince: string): Date {
  const parsed = new Date(owedSince);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * FIELD CLASSIFICATION for the DRAFT row — the same compile-time floor as the
 * owed-slot projection above, because the draft row is built from the SAME
 * `OwedSlot` rows (`listDraftAskSlots`), folded per session.
 *
 * PROJECTED:
 *   sessionId   → `target.id` and the fold key (one row per draft)
 *   sessionGoal → the work named in `title`, and `sessionGoal`
 *   sessionTitle, projectId → `sessionTitle` / `sessionProjectId`, as on the
 *                 owed-slot row (the draft is ONE session)
 *   owedSince   → `occurredAt` = the draft's NEWEST ask — its last activity,
 *                 the key the one newest-first order sorts on
 *   label       → counted (`count` = asks on the draft); each label is the
 *                 fold's unit, never shown on the row
 *
 * WITHHELD — the per-ask disclosure belongs to the ask's OWN row, which the
 * person sees the moment the draft is accepted (answering one accepts it):
 *   kind, icon, blockedReason, why, claimedDone, criterionKey, ref, ask →
 *     one row stands for N asks, and any single ask's reason/pointer/answer
 *     region on it would misdescribe the other N-1. The row is a door to the
 *     session, where every ask renders in full.
 *   sessionStatus, workspaceId → withheld for the reasons the owed-slot
 *     classification gives.
 */
const PROJECTED_DRAFT_ASK_FIELDS = [
  "sessionId",
  "sessionGoal",
  "sessionTitle",
  "projectId",
  "owedSince",
  "label",
] as const satisfies ReadonlyArray<keyof OwedSlot>;

const WITHHELD_DRAFT_ASK_FIELDS = [
  "kind",
  "icon",
  "blockedReason",
  "why",
  "claimedDone",
  "criterionKey",
  "ref",
  "ask",
  "sessionStatus",
  "workspaceId",
] as const satisfies ReadonlyArray<keyof OwedSlot>;

type _DraftAskFieldsClassified =
  Exclude<
    keyof OwedSlot,
    (typeof PROJECTED_DRAFT_ASK_FIELDS)[number]
  > extends (typeof WITHHELD_DRAFT_ASK_FIELDS)[number]
    ? true
    : never;
const _draftAskFieldsClassified: _DraftAskFieldsClassified = true;
void _draftAskFieldsClassified;

/** The draft half of the union: owed slots on pending drafts + who started each. */
export interface DraftAsksInput {
  /** Owed slots on undecided drafts (`listDraftAskSlots`), any order. */
  slots: OwedSlotSignalInput[];
  /** sessionId → the starting agent's display name, when the pod knows it. */
  starterNames: ReadonlyMap<string, string>;
}

/**
 * Pending drafts → one signal per draft that asks at least one thing. A draft
 * with no owed slot never appears: it has no row in `slots` to fold.
 *
 * `count` is the number of asks, so the count chip and the title's "N things"
 * are the same number. `id` keys on the session, so a draft stays one row as
 * asks come and go.
 */
export function signalsFromDraftAsks(
  input: DraftAsksInput,
  now: Date = new Date()
): Signal[] {
  const bySession = new Map<string, OwedSlotSignalInput[]>();
  for (const slot of input.slots) {
    const list = bySession.get(slot.sessionId);
    if (list) list.push(slot);
    else bySession.set(slot.sessionId, [slot]);
  }
  return [...bySession].map(([sessionId, slots]) => {
    const newest = slots
      .map((s) => owedInstant(s.owedSince))
      .reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
    const goal = slots.find((s) => s.sessionGoal)?.sessionGoal ?? null;
    const name = slots.find((s) => s.sessionTitle)?.sessionTitle ?? null;
    const projectId = slots.find((s) => s.projectId)?.projectId ?? null;
    return {
      id: `draft:${sessionId}`,
      kind: "draft-asks" as const,
      title: ASK_COPY.draftAsks(
        input.starterNames.get(sessionId) ?? null,
        goal ?? "a session",
        slots.length
      ),
      count: slots.length,
      occurredAt: newest,
      target: { kind: "session", id: sessionId },
      // Agent-originated, like the owed slots it folds.
      category: "ai",
      ...(goal ? { sessionGoal: goal } : {}),
      ...(name ? { sessionTitle: name } : {}),
      ...(projectId ? { sessionProjectId: projectId } : {}),
      ...sessionSource(sessionId, name),
      groupKey: sessionGroupKey(sessionId),
      ageBucket: ageBucketOf(newest, now),
      repeatCount: 1,
    };
  });
}

/**
 * One owed slot → one signal.
 *
 * ONE ROW PER SLOT, never a cluster: a session owing three deliverables owes
 * three separately actionable things, and collapsing them would hide two behind
 * a count nobody can act on. `count: 1` says exactly that.
 *
 * The ID keys on {@link normalizeExpectedLabel} — the SAME casefold every slot
 * door matches on — so the id a surface round-trips into `attestOutput` can
 * never name a slot the matcher cannot find.
 *
 * TITLE IS THE LABEL, VERBATIM. It is the human string the agent declared, the
 * same way a notification's title is the column the registry already evaluated.
 * It is not a domain token, so it must not be run through the vocabulary — and
 * it must certainly not be `charAt(0).toUpperCase()`'d at this call site.
 */
export function signalFromOwedSlot(
  row: OwedSlotSignalInput,
  now: Date = new Date()
): Signal {
  const occurredAt = owedInstant(row.owedSince);
  return {
    id: `slot:${row.sessionId}:${normalizeExpectedLabel(row.label) ?? ""}`,
    kind: "owed-slot",
    title: row.label,
    count: 1,
    occurredAt,
    target: { kind: "session", id: row.sessionId },
    // Agent-originated work, so `ai` — the same category the registry gives
    // agent completions. Deliberately NOT `governance`: that category means a
    // pending permission DECISION, and an owed slot is an obligation, not a
    // decision. Miscategorising it would let a governance-only filter show a
    // number the governance queue cannot explain.
    category: "ai",
    // The three-layer disclosure a surface renders (chip, why-prose, the
    // agent's claim), plus the session goal that names the work this slot
    // came from, is carried HERE rather than re-fetched — see the field docs
    // on `Signal`. Spread-free and explicit so an added `OwedSlot` field is a
    // deliberate choice to project, never an accident — see the classification
    // above `OwedSlotSignalInput` for every field's disposition.
    ...(row.blockedReason ? { blockedReason: row.blockedReason } : {}),
    ...(row.why ? { why: row.why } : {}),
    ...(row.claimedDone !== undefined ? { claimedDone: row.claimedDone } : {}),
    ...(row.sessionGoal ? { sessionGoal: row.sessionGoal } : {}),
    ...(row.sessionTitle ? { sessionTitle: row.sessionTitle } : {}),
    ...(row.projectId ? { sessionProjectId: row.projectId } : {}),
    ...(row.kind ? { slotKind: row.kind } : {}),
    ...(row.criterionKey ? { criterionKey: row.criterionKey } : {}),
    ...(row.ref ? { slotRef: row.ref } : {}),
    ...(row.ask ? { ask: row.ask } : {}),
    ...sessionSource(row.sessionId, row.sessionTitle),
    groupKey: sessionGroupKey(row.sessionId),
    ageBucket: ageBucketOf(occurredAt, now),
    repeatCount: 1,
  };
}

/**
 * What the union knows about each session's LIVE need. A `"session-pointer"`
 * notification (registry `needsYou`) is decided from this, never from the
 * notification row itself.
 */
export interface SessionLiveNeeds {
  /**
   * Sessions known to hold at least one owed slot: the scanned owed page's
   * sessions, PLUS the pointer sessions measured directly
   * (`sessionsWithOwedSlot`, uncapped) — so a pointer whose session's slots
   * fell past the owed page's cap still folds (needs-you duplicate cause 3).
   */
  owedSessionIds: ReadonlySet<string>;
  /**
   * Sessions whose room holds an agent question nobody has answered yet
   * (`sessionsWithOpenQuestion`). `undefined` means NOT MEASURED, which is a
   * different fact from "no open question": an unmeasured pointer row keeps
   * counting, so a caller that forgets this read over-reports a stale row
   * rather than hiding a live question.
   */
  openQuestionSessionIds?: ReadonlySet<string>;
}

/** One session awaiting the person's review/close (`listSessionsAwaitingReview`). */
export interface ReviewSessionSignalInput {
  id: string;
  title: string | null;
  goal: string | null;
  updatedAt: Date;
  /** The session's project — its rail colour and its provenance door. */
  projectId?: string | null;
}

/**
 * One review session → one signal. The title is the session's own title (the
 * ONE derivation, `resolveSessionTitle`), never composed here; the row is a
 * door to the session, grouped with anything else that session owes.
 */
export function signalFromReviewSession(
  row: ReviewSessionSignalInput,
  now: Date = new Date()
): Signal {
  const title = resolveSessionTitle(row);
  return {
    id: `review:${row.id}`,
    kind: "session-review",
    title,
    count: 1,
    occurredAt: row.updatedAt,
    target: { kind: "session", id: row.id },
    category: "ai",
    ...(row.goal ? { sessionGoal: row.goal } : {}),
    ...(title ? { sessionTitle: title } : {}),
    ...(row.projectId ? { sessionProjectId: row.projectId } : {}),
    groupKey: sessionGroupKey(row.id),
    ageBucket: ageBucketOf(row.updatedAt, now),
    repeatCount: 1,
  };
}

/** The session ids behind an owed page. */
export function owedSessionIdsOf(
  owedSlots: readonly OwedSlotSignalInput[]
): Set<string> {
  return new Set(owedSlots.map((s) => s.sessionId));
}

/**
 * The notifications that survive the dedupe. Exported separately from
 * {@link unionNeedsYou} because `signals.count` needs the SAME filtered set
 * without paying for the mapping. A row is dropped when:
 *
 *   - it is proposal-sourced, or points at a proposal a cluster already
 *     represents (the proposal dedupe, see the file docblock);
 *   - its type is `"informational"` in the registry. It is news, not an ask
 *     (no registry row is tagged this way today — an agent's plain room
 *     `update` produces no notification at all, per founder decision F,
 *     2026-09-25 — but the role stays available for a future news-only type);
 *   - its type is a `"session-pointer"` (`session.needs_you`) and the session
 *     has an owed slot. The slot row IS that need, so the pointer folds into
 *     it: one entry per session, counted once;
 *   - its type is a `"session-pointer"` and the session has neither an owed
 *     slot nor an open question. Whatever it announced was met, so a row the
 *     person never opened must not keep the session in needs-you.
 *
 * A pointer row whose session has no owed slot but an open question stays, and
 * counts once. The question has no row of its own in the union.
 *
 * WHY STATE, NOT MARK-READ. The row does not persist WHY it was written (a slot
 * or a question; the registry's six-hour window merges both into one row), and
 * slots are resolved through many doors (attest, answer, return, retire, a
 * PATCH). Marking the row read at each door would be a list of doors that falls
 * behind. Reading the session's state here is correct whichever door met the
 * need. The cost: the row stays unread in the bell after the need is met. The
 * bell is a history of news, and the badge is not read from it.
 *
 * LIMIT, stated. `owedSessionIds` comes from a CAPPED owed page. A session
 * whose slots fell past the cap does not fold, and its pointer row counts on
 * its own. That only happens when the owed count is already a floor
 * (`owedTruncated`).
 */
export function dedupeNotifications(
  rows: NotificationSignalInput[],
  clusters: ProposalCluster[],
  live: SessionLiveNeeds = { owedSessionIds: new Set() }
): NotificationSignalInput[] {
  return partitionNotifications(rows, clusters, live).needsYou;
}

/**
 * THE one pass that sorts unread notifications into buckets. `needsYou` is
 * {@link dedupeNotifications}. `suggestions` is the sibling bucket: rows
 * whose registry role is `"suggestion"`, meaning something an AI offered on its
 * own initiative (`ai.proactive.*`, `agent.insight`). Both buckets come out of
 * the SAME pass, so the proposal dedupe applies to both and a row can never
 * land in both, or in neither by accident. A suggestion is never in needs-you.
 */
export function partitionNotifications(
  rows: NotificationSignalInput[],
  clusters: ProposalCluster[],
  live: SessionLiveNeeds = { owedSessionIds: new Set() }
): {
  needsYou: NotificationSignalInput[];
  suggestions: NotificationSignalInput[];
  /** SYSTEM HEALTH rows (registry role `"status"`) — the status banner. */
  status: NotificationSignalInput[];
} {
  const clusteredProposalIds = new Set<string>();
  for (const c of clusters) {
    for (const id of c.sampleProposalIds) clusteredProposalIds.add(id);
  }
  const needsYou: NotificationSignalInput[] = [];
  const suggestions: NotificationSignalInput[] = [];
  const status: NotificationSignalInput[] = [];
  for (const r of rows) {
    if (r.sourceType === "proposal") continue;
    if (r.sourceId && clusteredProposalIds.has(r.sourceId)) continue;
    const role = needsYouRole(r.type);
    if (role === "suggestion") suggestions.push(r);
    else if (role === "status") status.push(r);
    else if (role === "item") needsYou.push(r);
    else if (role === "session-pointer" && pointerStillNeedsYou(r, live))
      needsYou.push(r);
    // "informational": in no bucket. It stays in the bell.
  }
  return { needsYou, suggestions, status };
}

/** A `"session-pointer"` row, decided from its session's live state. */
function pointerStillNeedsYou(
  r: NotificationSignalInput,
  live: SessionLiveNeeds
): boolean {
  if (!r.sourceId) return true;
  if (live.owedSessionIds.has(r.sourceId)) return false;
  if (live.openQuestionSessionIds === undefined) return true;
  return live.openQuestionSessionIds.has(r.sourceId);
}

/**
 * The `suggestions` lens: unread AI suggestions, newest first, CAPPED at
 * {@link SUGGESTIONS_CAP} ("possibilities", capped — V1 W7). The sibling of
 * {@link unionNeedsYou}, from the same partition. Unlike an owed slot, a
 * suggestion decays, so newest first is the right order — and the cap keeps
 * the newest. `countNeedsYou().suggestions` applies the same cap, so the
 * number equals the rows. A suggestion about a session the viewer can read
 * names it as its source (`containers`).
 */
export function unionSuggestions(
  notifications: NotificationSignalInput[],
  now: Date = new Date(),
  containers?: ReadonlyMap<string, NotificationContainer>
): Signal[] {
  return partitionNotifications(notifications, [])
    .suggestions.map((r) =>
      signalFromNotification(r, now, 1, containers?.get(r.id))
    )
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, SUGGESTIONS_CAP);
}

/**
 * PROPOSED — what an AI offers that the person may take or leave (lens grammar,
 * founder-approved 2026-10-04): agent DRAFTS (one `draft-asks` row per
 * undecided draft that asks something) + AI SUGGESTIONS (capped, see
 * {@link unionSuggestions}). Ignoring any of it costs nothing, so none of it is
 * ever a needs-you row and none of it counts toward `needsYou`. Pending
 * approvals — a proposal an agent is paused on included — are BLOCKING
 * ({@link unionNeedsYou}), never here. Newest first.
 */
export function unionProposed(args: {
  draftAsks?: DraftAsksInput;
  notifications: NotificationSignalInput[];
  notificationContainers?: ReadonlyMap<string, NotificationContainer>;
  now?: Date;
}): Signal[] {
  const now = args.now ?? new Date();
  return [
    ...(args.draftAsks ? signalsFromDraftAsks(args.draftAsks, now) : []),
    ...unionSuggestions(args.notifications, now, args.notificationContainers),
  ].sort(newestFirst);
}

/**
 * The `needs-you` union — BLOCKING: owed slots, sessions awaiting review,
 * pending proposal clusters and deduped, folded unread notifications — ONE
 * list in ONE order ({@link orderNeedsYou}). Pure — feed it the doors' rows
 * and it decides membership and order.
 *
 * Agent DRAFTS are not here (founder, lens grammar 2026-10-04: drafts are
 * PROPOSED — {@link unionProposed}). `draftAsks` is still read, for one
 * thing only: a draft's `session.needs_you` pointer folds into the draft (its
 * session has an owed slot), so the pointer never resurfaces as a loose
 * needs-you row.
 *
 * ── OWED SLOTS FOLD ONLY A SESSION POINTER, NEVER "ANY ROW ABOUT THE SESSION" ─
 * Every door that hands a slot to the person writes `session.needs_you`
 * (`notify-needs-you.ts`), and that row announced the SAME need the owed-slot
 * row already shows. So the fold is keyed on the registry's
 * `needsYou: "session-pointer"` role, never on `sourceId` alone:
 * `session.unblocked` (`sourceType: "system"`, `sourceId` = the session id) is
 * separate news, and it stays — in the session's block, through its
 * container. See {@link dedupeNotifications}.
 *
 * ── ORDERING: NEWEST FIRST ACROSS EVERY KIND (W2 "calm", 2026-09-28) ─────────
 * One newest-first order across kinds, a session's rows kept together, and
 * anything older than a week folded under "Older" — see {@link orderNeedsYou}.
 */
export function unionNeedsYou(args: {
  clusters: ProposalCluster[];
  /**
   * sessionId → its name, for the clusters' sessions the VIEWER may read
   * (`readClusterSessions`). A cluster whose session is absent here stays its
   * own row. Absent ⇒ no cluster joins a session block (fail closed).
   */
  clusterSessions?: ReadonlyMap<string, ClusterSessionName>;
  notifications: NotificationSignalInput[];
  /**
   * notification id → the container it resolves to (`lens-containers.ts`).
   * A notification whose session is named here joins that session's block.
   * Absent ⇒ every notification is a row of its own (fail closed).
   */
  notificationContainers?: ReadonlyMap<string, NotificationContainer>;
  /** Required, not optional: a caller that forgets the third source ships a
   *  tray that silently under-reports, which is the defect, not a default. */
  owedSlots: OwedSlotSignalInput[];
  /** See {@link SessionLiveNeeds.openQuestionSessionIds}. Absent = unmeasured. */
  openQuestionSessionIds?: ReadonlySet<string>;
  /**
   * Pointer sessions measured to hold an owed slot, independent of the owed
   * page's cap (`sessionsWithOwedSlot`). See {@link SessionLiveNeeds}.
   */
  measuredOwedSessionIds?: ReadonlySet<string>;
  /** Undecided drafts — read ONLY to fold their pointers (see above). */
  draftAsks?: DraftAsksInput;
  /** Sessions awaiting the person's review — at every scope. Absent ⇒ none. */
  reviewSessions?: readonly ReviewSessionSignalInput[];
  /** The clock `ageBucket` is measured against. Absent ⇒ now. */
  now?: Date;
}): Signal[] {
  const now = args.now ?? new Date();
  const notifications = foldNotifications(
    dedupeNotifications(args.notifications, args.clusters, liveNeedsOf(args))
  );
  return orderNeedsYou([
    ...args.owedSlots.map((r) => signalFromOwedSlot(r, now)),
    ...(args.reviewSessions ?? []).map((r) => signalFromReviewSession(r, now)),
    ...args.clusters.map((c) =>
      signalFromCluster(
        c,
        now,
        c.sessionId ? args.clusterSessions?.get(c.sessionId) : undefined
      )
    ),
    ...notifications.map((f) =>
      signalFromNotification(
        f.row,
        now,
        f.repeatCount,
        args.notificationContainers?.get(f.row.id)
      )
    ),
  ]);
}

/** The live needs a pointer row is decided from — ONE derivation, list and count. */
function liveNeedsOf(args: {
  owedSlots: readonly OwedSlotSignalInput[];
  draftAsks?: DraftAsksInput;
  measuredOwedSessionIds?: ReadonlySet<string>;
  openQuestionSessionIds?: ReadonlySet<string>;
}): SessionLiveNeeds {
  const owed = owedSessionIdsOf([
    ...args.owedSlots,
    ...(args.draftAsks?.slots ?? []),
  ]);
  for (const id of args.measuredOwedSessionIds ?? []) owed.add(id);
  return {
    owedSessionIds: owed,
    openQuestionSessionIds: args.openQuestionSessionIds,
  };
}

/**
 * The STATUS BANNER — system health, never a needs-you row (lens grammar,
 * founder-approved 2026-10-04). ONE banner for the page, however many health
 * rows are unread: each issue is folded per `(type, source)` — "Intelligence
 * Hub degraded" raised nine times is ONE issue with `repeatCount: 9` — and the
 * banner leads with the NEWEST issue. `null` when nothing is wrong.
 */
export interface StatusBannerIssue {
  /** The registry type (`system.intelligence_degraded`, …). */
  type: string;
  /** The newest instance's evaluated title. */
  title: string;
  occurredAt: Date;
  /** How many unread rows this issue folds. */
  repeatCount: number;
  /** Every folded row — what "dismiss" marks read. */
  notificationIds: string[];
  target: SignalTarget | null;
}

export interface StatusBanner {
  /** The newest issue's title — what the banner says. */
  title: string;
  occurredAt: Date;
  /** Distinct issues, newest first. */
  issues: StatusBannerIssue[];
}

export function statusBanner(
  notifications: readonly NotificationSignalInput[],
  clusters: ProposalCluster[] = []
): StatusBanner | null {
  const rows = partitionNotifications([...notifications], clusters).status;
  const issues = new Map<string, StatusBannerIssue>();
  for (const r of rows) {
    const key = `${r.type ?? ""}\u0000${r.sourceId ?? ""}`;
    const seen = issues.get(key);
    if (!seen) {
      issues.set(key, {
        type: r.type ?? "",
        title: r.title,
        occurredAt: r.createdAt,
        repeatCount: 1,
        notificationIds: [r.id],
        target: targetFromNotification(r.sourceType, r.sourceId, r.actions),
      });
      continue;
    }
    seen.repeatCount += 1;
    seen.notificationIds.push(r.id);
    if (r.createdAt.getTime() > seen.occurredAt.getTime()) {
      seen.title = r.title;
      seen.occurredAt = r.createdAt;
    }
  }
  if (issues.size === 0) return null;
  const sorted = [...issues.values()].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()
  );
  return {
    title: sorted[0]!.title,
    occurredAt: sorted[0]!.occurredAt,
    issues: sorted,
  };
}

/**
 * Give a row whose OBJECT is a session (`session-review`, `live-session`) its
 * provenance door: the session's PROJECT, named. A row already carrying a
 * source, or whose project the viewer cannot see (absent from `projectNames`),
 * is returned unchanged. Pure.
 */
export function withProjectSource(
  signal: Signal,
  projectNames: ReadonlyMap<string, string>
): Signal {
  if (signal.source || !signal.sessionProjectId) return signal;
  const label = projectNames.get(signal.sessionProjectId)?.trim();
  return label
    ? {
        ...signal,
        source: { kind: "project", id: signal.sessionProjectId, label },
      }
    : signal;
}

/** Newest first; ties broken by id so the order is total and stable. */
function newestFirst(a: Signal, b: Signal): number {
  return (
    b.occurredAt.getTime() - a.occurredAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** A `session:` block's rows all take the bucket of its newest row. */
function liftSessionAgeBuckets(signals: readonly Signal[]): Signal[] {
  const newest = new Map<string, Signal>();
  for (const s of signals) {
    if (!s.groupKey?.startsWith("session:")) continue;
    const cur = newest.get(s.groupKey);
    if (!cur || s.occurredAt.getTime() > cur.occurredAt.getTime()) {
      newest.set(s.groupKey, s);
    }
  }
  return signals.map((s) => {
    const lead = s.groupKey ? newest.get(s.groupKey) : undefined;
    return lead && lead.ageBucket !== s.ageBucket
      ? { ...s, ageBucket: lead.ageBucket }
      : s;
  });
}

/**
 * THE needs-you order. Pure.
 *
 *   1. `recent` rows first, then every `older` row — the "Older" fold is a
 *      suffix, so a surface can cut it off without re-sorting.
 *   2. Inside each bucket, rows sharing a `groupKey` form ONE contiguous
 *      block, placed at its NEWEST row's position; rows inside a block are
 *      newest first. A row with no `groupKey` is a block of one.
 *   3. Blocks are ordered newest first across ALL kinds. A decision filed
 *      today outranks a slot owed for two weeks.
 *
 * A SESSION appears once (founder, 2026-09-28): every row of a `session:`
 * block takes the `ageBucket` of its NEWEST row, so a session whose rows
 * straddle the week boundary is ONE block — in `recent` if anything in it is
 * recent. Only `session:` blocks are lifted; a cluster or a notification is
 * one row anyway. Counts are unaffected (the rows are the same rows).
 */
export function orderNeedsYou(input: readonly Signal[]): Signal[] {
  const signals = liftSessionAgeBuckets(input);
  const out: Signal[] = [];
  for (const bucket of ["recent", "older"] as const) {
    const blocks = new Map<string, Signal[]>();
    for (const s of signals) {
      if (s.ageBucket !== bucket) continue;
      const key = s.groupKey ?? `row:${s.id}`;
      const block = blocks.get(key);
      if (block) block.push(s);
      else blocks.set(key, [s]);
    }
    const sorted = [...blocks.values()].map((b) => b.sort(newestFirst));
    sorted.sort((a, b) => newestFirst(a[0]!, b[0]!));
    for (const b of sorted) out.push(...b);
  }
  return out;
}

/**
 * ONE number for both badges (tray and bell), plus the BREAKDOWN the badge
 * itself renders.
 *
 * `needsYou` is the full union total and is exactly `unionNeedsYou(...).length`
 * before any page slice — the count door and the list door must never disagree
 * about how many things need you.
 *
 * `blocked` is the owed-slot subset, carried separately because the badge shows
 * THAT number and not the total (founder-settled): a badge that added pending
 * proposals to blocked deliverables is textbook badge inflation — one number
 * standing for two populations with different urgencies and different verbs. A
 * client renders "Needs you (needsYou)" with a `blocked` badge from this ONE
 * query; nothing has to run a second count, and the counting rule is not forked
 * to produce the second number.
 *
 * `decisions` / `notifications` / `blocked` / `review` are the PARTS the badge
 * is made of, and `needsYou === decisions + notifications + blocked + review`
 * by construction (asserted in `signals.union.test.ts`). `suggestions` and
 * `drafts` are shipped alongside and are deliberately NOT parts: both are
 * PROPOSED (lens grammar, founder-approved 2026-10-04 — "AI suggestions +
 * agent drafts = Proposed"), and ignoring them costs nothing. `review` —
 * sessions awaiting your review/close, THE needs-you rule's third population —
 * is counted at every scope (pod included). They exist so a surface
 * that states the number can also state what it is made of — Governance said
 * "16 decisions pending" beside a shell badge of 89 and nothing on screen could
 * reconcile the two. A client must READ each part; deriving one by subtracting
 * the others from `needsYou` is the drift this shape exists to prevent.
 *
 * `distinct` is the cluster count BEFORE any page slice — the same value as
 * `decisions`, kept under its original name for the clients that already read
 * it. (Until 2026-09-13 it silently carried the WHOLE total, so a reader of
 * "distinct clusters" got the union; no client rendered it, which is the only
 * reason that shipped unnoticed.) `proposals.groups`
 * computes it, and its `scanTruncated` flag says whether it is a total or a
 * FLOOR. That truncation is carried through here rather than being flattened
 * away, so a caller can never render a floor as if it were exact. The owed half
 * has the same hazard: `listOwedSlots` caps at `limit`, so a full page is a
 * floor too.
 */
export function countNeedsYou(args: {
  /** `proposals.groups`.distinct — distinct pending fingerprints. */
  distinctClusters: number;
  /** `proposals.groups`.scanTruncated. */
  clustersTruncated: boolean;
  /** Unread notifications, already page-limited by the caller. */
  notifications: NotificationSignalInput[];
  clusters: ProposalCluster[];
  /** The notification page hit its limit, so its count is a floor too. */
  notificationsTruncated: boolean;
  /** Owed slots, already page-limited by the caller. */
  owedSlots: OwedSlotSignalInput[];
  /** The owed page hit its limit, so its count is a floor too. */
  owedTruncated: boolean;
  /** See {@link SessionLiveNeeds.openQuestionSessionIds}. Absent = unmeasured. */
  openQuestionSessionIds?: ReadonlySet<string>;
  /** See {@link SessionLiveNeeds.owedSessionIds}. */
  measuredOwedSessionIds?: ReadonlySet<string>;
  /**
   * Sessions finished and awaiting the person's review/close — THE needs-you
   * rule's third population (`needsYouReason === "review"`,
   * `@synap-core/types/units`). Absent ⇒ the scope does not count it (0).
   */
  reviewSessions?: number;
  /** The review scan hit its cap, so its count is a floor. */
  reviewTruncated?: boolean;
  /** Undecided drafts that ask something — the SAME input `unionNeedsYou` takes. */
  draftAsks?: DraftAsksInput;
  /** The draft-slot scan hit its cap, so `drafts` is a floor. */
  draftAsksTruncated?: boolean;
}): {
  needsYou: number;
  distinct: number;
  truncated: boolean;
  blocked: number;
  /** Distinct pending proposal clusters (after the dedupe). */
  decisions: number;
  /** Unread notifications that survive the dedupe. */
  notifications: number;
  /** Sessions awaiting your review / close (every scope). */
  review: number;
  /**
   * Undecided agent drafts that ask you something — ONE per draft, however
   * many asks it holds, exactly the `draft-asks` rows the `proposed` lens
   * returns (the same fold, `signalsFromDraftAsks`). PROPOSED, so NOT a part
   * of `needsYou`; their asks are not in `blocked` either.
   */
  drafts: number;
  /** The draft-slot scan hit its cap, so `drafts` is a floor. */
  draftsTruncated: boolean;
  /**
   * Unread AI suggestions: the sibling bucket. NOT part of `needsYou` and
   * not one of its parts. 0 under a container scope, like `notifications`.
   * Capped at `SUGGESTIONS_CAP`, exactly like the lens it counts.
   */
  suggestions: number;
} {
  const decisions = args.distinctClusters;
  const buckets = partitionNotifications(
    args.notifications,
    args.clusters,
    liveNeedsOf(args)
  );
  // Folded, like the list: the same news raised N times is ONE row there, so
  // it is one here — the badge must equal the number of rows it stands for.
  const notifications = foldNotifications(buckets.needsYou).length;
  const blocked = args.owedSlots.length;
  const review = args.reviewSessions ?? 0;
  // The SAME fold the list renders, counted — never a second rule.
  const drafts = args.draftAsks
    ? signalsFromDraftAsks(args.draftAsks).length
    : 0;
  return {
    // THE item sum (`needsYouTotal`) over the rule's three populations, plus
    // the notification half. Drafts are PROPOSED (2026-10-04) and never count.
    needsYou:
      needsYouTotal({ owed: blocked, decisions, review }) + notifications,
    distinct: decisions,
    decisions,
    notifications,
    truncated:
      args.clustersTruncated ||
      args.notificationsTruncated ||
      args.owedTruncated ||
      (args.reviewTruncated ?? false),
    blocked,
    review,
    drafts,
    draftsTruncated: args.draftAsksTruncated ?? false,
    suggestions: Math.min(buckets.suggestions.length, SUGGESTIONS_CAP),
  };
}
