/**
 * Pod hygiene CLEANUP PACK — the shared item model.
 *
 * ONE `pod_hygiene/cleanup_pack` proposal lists independent retirements the
 * owner reviews item by item (`proposals.rejectItem` → `data.dispositions[ref]`).
 * The pod files it, relay reviews it, desktop reads it; this module is the one
 * place the item SHAPE, its ref, its caption and its tolerant reader are
 * decided, so those three surfaces cannot fork the rule.
 *
 * Pure + dependency-free (same contract as `../vocabulary`): no Node APIs, no
 * date library, no clock — every time-dependent output takes `now`.
 *
 * ── Schema history ──────────────────────────────────────────────────────────
 * v1 (no `data.schema`): items `{ ref: "$itemN", action, targetId, label,
 *   reason }`, four actions. Refs were POSITIONAL — meaningless across packs.
 * v2 (`data.schema === 2`): items carry an id-keyed ref, a subject, machine
 *   evidence and a snapshot. `expire_proposal` and `pause_automation` are gone
 *   (founder decisions FD1/FD2: the first is a terminal act a toggle list must
 *   not offer; the second belongs to the automation-health warden). Packs
 *   already filed as v1 still READ, flagged `legacy`.
 */

import {
  resolveActionLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "../vocabulary/index.js";

export const CLEANUP_PACK_SCHEMA = 2;

export const CLEANUP_PACK_ACTIONS = [
  "close_session",
  "retire_profile",
] as const;
export type CleanupPackAction = (typeof CLEANUP_PACK_ACTIONS)[number];

/** v1-only actions. Readable in an already-filed pack; never filed again. */
export const LEGACY_CLEANUP_PACK_ACTIONS = [
  "expire_proposal",
  "pause_automation",
] as const;
export type LegacyCleanupPackAction =
  (typeof LEGACY_CLEANUP_PACK_ACTIONS)[number];

/** Object-nav kind a surface routes an item with. Never a raw table name. */
export const CLEANUP_ACTION_SUBJECT_KIND = {
  close_session: "session",
  retire_profile: "kind",
} as const satisfies Record<CleanupPackAction, string>;
export type CleanupPackSubjectKind =
  (typeof CLEANUP_ACTION_SUBJECT_KIND)[CleanupPackAction];

const LEGACY_ACTION_SUBJECT_KIND = {
  ...CLEANUP_ACTION_SUBJECT_KIND,
  expire_proposal: "proposal",
  pause_automation: "automation",
} as const satisfies Record<
  CleanupPackAction | LegacyCleanupPackAction,
  string
>;

/** Total items in one pack — what a phone can review. */
export const MAX_ITEMS_PER_PACK = 30;
/** Per action group. The rest is counted in `truncated`, never dropped silently. */
export const MAX_ITEMS_PER_ACTION = 15;
/** "Leave out" is a remembered keep for this many days, by subject kind (FD3). */
export const KEEP_DAYS = {
  kind: 90,
  session: 30,
} as const satisfies Record<CleanupPackSubjectKind, number>;
/** An undecided pack older than this is superseded by a fresh one (FD4). */
export const SUPERSEDE_AFTER_DAYS = 7;

/**
 * Whether a USER-REACHABLE inverse door exists for an applied item — not
 * whether the data model could be reversed by someone with DB access. The
 * filer copies this into `item.reversible`. Both are `false` in v1 (FD5):
 * a closed session has no reopen door, and a retired kind has no reactivate
 * door. Flip a row only in the same change that ships that door.
 */
export const CLEANUP_ACTION_REVERSIBLE: Readonly<
  Record<CleanupPackAction, boolean>
> = {
  close_session: false,
  retire_profile: false,
};

export interface CleanupPackItemV2 {
  /** `${action}:${subject.id}` — id-keyed, so stable ACROSS packs. */
  ref: string;
  action: CleanupPackAction;
  subject: { kind: CleanupPackSubjectKind; id: string; name: string };
  /** Machine facts, so each surface formats and nothing re-queries. */
  evidence: {
    /** ISO. */
    createdAt: string;
    /** ISO, or null when no activity was ever recorded. */
    lastActivityAt: string | null;
    /** Kinds: live entities (0 at filing). */
    records?: number;
    /** Kinds: what depends on it. `automations: null` = not measured. */
    dependents?: {
      views: number;
      automations: number | null;
      relationTypes: number;
      facets: number;
    };
  };
  /** True only when a user-reachable inverse door exists. See CLEANUP_ACTION_REVERSIBLE. */
  reversible: boolean;
  risk: "low" | "irreversible";
  /** Apply-time re-validation baseline. */
  snapshot: { updatedAt: string; revisionCount?: number };
}

/** The id-keyed item ref. The key `rejectItem` dispositions and don't-nag memory use. */
export function stableItemRef(
  action: CleanupPackAction,
  subjectId: string
): string {
  return `${action}:${subjectId}`;
}

// ── Group heading ────────────────────────────────────────────────────────────

/**
 * Per action: the vocabulary verb and noun tokens (resolved through the one
 * door), plus the product adjective, which is copy and stays local. Legacy
 * actions keep their phrase so a v1 pack still reads with headings.
 */
const ACTION_PHRASE: Record<
  CleanupPackAction | LegacyCleanupPackAction,
  { verb: string; noun: string; qualify: (noun: string) => string }
> = {
  close_session: {
    verb: "close",
    noun: "session",
    qualify: (n) => `idle ${n}`,
  },
  retire_profile: {
    verb: "retire",
    noun: "kind",
    qualify: (n) => `unused ${n}`,
  },
  expire_proposal: {
    verb: "expire",
    noun: "proposal",
    qualify: (n) => `old ${n}`,
  },
  pause_automation: {
    verb: "pause",
    noun: "automation",
    qualify: (n) => `${n} that never ran`,
  },
};

/** PURE: "Close 3 idle sessions" — verb and noun from the vocabulary door. */
export function describeCleanupAction(
  action: CleanupPackAction | LegacyCleanupPackAction,
  count: number
): string {
  const phrase = ACTION_PHRASE[action];
  const noun = (
    count === 1
      ? resolveObjectNoun(phrase.noun)
      : resolveObjectNounPlural(phrase.noun)
  ).toLowerCase();
  return `${resolveActionLabel(phrase.verb, "imperative")} ${count} ${phrase.qualify(noun)}`;
}

// ── Caption ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function wholeDaysBetween(fromIso: string, now: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(fromIso)) / DAY_MS)
  );
}

function daysPhrase(days: number): string {
  if (days < 1) return "less than a day";
  return days === 1 ? "1 day" : `${days} days`;
}

/** "3 Aug", or "3 Aug 2025" outside `now`'s year. UTC, so identical on every device. */
function shortDate(iso: string, now: Date): string {
  const d = new Date(iso);
  const head = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? head
    : `${head} ${d.getUTCFullYear()}`;
}

function countOf(kind: string, n: number): string {
  return `${n} ${(n === 1 ? resolveObjectNoun(kind) : resolveObjectNounPlural(kind)).toLowerCase()}`;
}

/**
 * PURE: the one-glance evidence line under an item's name.
 *
 *   session  "Idle 41 days · no activity since 3 Aug"
 *   kind     "0 records · created 64 days ago · used by 2 views"
 *
 * It states facts only. It NEVER promises the act can be undone — no v1 item
 * has a user-reachable inverse door (FD5) — whatever `reversible` says; a
 * surface that has such a door renders its own affordance for it.
 */
export function cleanupItemReason(item: CleanupPackItemV2, now: Date): string {
  const { evidence } = item;
  switch (item.action) {
    case "close_session": {
      if (evidence.lastActivityAt === null) {
        return `Created ${daysPhrase(wholeDaysBetween(evidence.createdAt, now))} ago · no activity recorded`;
      }
      return `Idle ${daysPhrase(wholeDaysBetween(evidence.lastActivityAt, now))} · no activity since ${shortDate(evidence.lastActivityAt, now)}`;
    }
    case "retire_profile": {
      const parts: string[] = [];
      if (evidence.records !== undefined) {
        // "record" is product copy for a live entity, not a model token.
        parts.push(
          evidence.records === 1 ? "1 record" : `${evidence.records} records`
        );
      }
      parts.push(
        `created ${daysPhrase(wholeDaysBetween(evidence.createdAt, now))} ago`
      );
      if (evidence.lastActivityAt !== null) {
        parts.push(`last used ${shortDate(evidence.lastActivityAt, now)}`);
      }
      const deps = evidence.dependents;
      if (deps) {
        const used = [
          deps.views > 0 ? countOf("view", deps.views) : null,
          deps.automations ? countOf("automation", deps.automations) : null,
          deps.relationTypes > 0
            ? countOf("relation_def", deps.relationTypes)
            : null,
          deps.facets > 0 ? countOf("facet", deps.facets) : null,
        ].filter((s): s is string => s !== null);
        if (used.length > 0) parts.push(`used by ${used.join(", ")}`);
        // Unmeasured is not zero: never let a missing count read as "unused".
        if (deps.automations === null) parts.push("automations not checked");
        else if (used.length === 0) parts.push("nothing depends on it");
      }
      const line = parts.join(" · ");
      return line.charAt(0).toUpperCase() + line.slice(1);
    }
  }
}

// ── Tolerant reader ──────────────────────────────────────────────────────────

/** One readable item, v1 or v2, normalised for rendering and applying. */
export interface ReadCleanupPackItem {
  ref: string;
  action: CleanupPackAction | LegacyCleanupPackAction;
  subject: {
    kind: CleanupPackSubjectKind | "proposal" | "automation";
    id: string;
    name: string;
  };
  /** Filed by v1: positional ref, no evidence, possibly a dropped action. */
  legacy: boolean;
  /** The full v2 item; null for a legacy row (it has no evidence). */
  item: CleanupPackItemV2 | null;
}

export interface CleanupPackRead {
  /** 2 when `data.schema === 2`; 1 for an items array without it; null when there are no items. */
  schema: 1 | 2 | null;
  items: ReadCleanupPackItem[];
  /** Entries present but not parseable. A count, so a failed read never looks empty. */
  unreadable: number;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseV2(raw: unknown): CleanupPackItemV2 | null {
  if (!isObj(raw)) return null;
  const action = raw.action;
  if (!(CLEANUP_PACK_ACTIONS as readonly unknown[]).includes(action))
    return null;
  const act = action as CleanupPackAction;
  const { subject, evidence, snapshot } = raw;
  if (
    !isObj(subject) ||
    subject.kind !== CLEANUP_ACTION_SUBJECT_KIND[act] ||
    typeof subject.id !== "string" ||
    subject.id === "" ||
    typeof subject.name !== "string"
  )
    return null;
  // A ref that is not id-keyed would silently disable don't-nag memory.
  if (raw.ref !== stableItemRef(act, subject.id)) return null;
  if (
    !isObj(evidence) ||
    !isIso(evidence.createdAt) ||
    !(evidence.lastActivityAt === null || isIso(evidence.lastActivityAt))
  )
    return null;
  if (evidence.records !== undefined && !isCount(evidence.records)) return null;
  const deps = evidence.dependents;
  if (
    deps !== undefined &&
    !(
      isObj(deps) &&
      isCount(deps.views) &&
      (deps.automations === null || isCount(deps.automations)) &&
      isCount(deps.relationTypes) &&
      isCount(deps.facets)
    )
  )
    return null;
  if (typeof raw.reversible !== "boolean") return null;
  if (raw.risk !== "low" && raw.risk !== "irreversible") return null;
  if (
    !isObj(snapshot) ||
    !isIso(snapshot.updatedAt) ||
    (snapshot.revisionCount !== undefined && !isCount(snapshot.revisionCount))
  )
    return null;
  return raw as unknown as CleanupPackItemV2;
}

function parseV1(raw: unknown): ReadCleanupPackItem | null {
  if (!isObj(raw)) return null;
  const action = raw.action;
  if (
    ![...CLEANUP_PACK_ACTIONS, ...LEGACY_CLEANUP_PACK_ACTIONS].includes(
      action as CleanupPackAction
    )
  )
    return null;
  if (
    typeof raw.ref !== "string" ||
    typeof raw.targetId !== "string" ||
    raw.targetId === ""
  )
    return null;
  const act = action as CleanupPackAction | LegacyCleanupPackAction;
  return {
    ref: raw.ref,
    action: act,
    subject: {
      kind: LEGACY_ACTION_SUBJECT_KIND[act],
      id: raw.targetId,
      name: typeof raw.label === "string" ? raw.label : "",
    },
    legacy: true,
    item: null,
  };
}

/**
 * PURE, never throws: a stored pack's `data` → its items. `data.schema === 2`
 * reads v2 items strictly; anything else reads as a v1 pack (flagged legacy).
 * An entry that does not parse is COUNTED in `unreadable`, never dropped
 * silently and never thrown — so "none of these items could be read" and
 * "nothing to tidy" stay two different screens.
 */
export function readPackItems(data: unknown): CleanupPackRead {
  const raw = isObj(data) ? data.items : undefined;
  if (!Array.isArray(raw)) return { schema: null, items: [], unreadable: 0 };
  const schema = (data as Obj).schema === CLEANUP_PACK_SCHEMA ? 2 : 1;
  const items: ReadCleanupPackItem[] = [];
  let unreadable = 0;
  for (const entry of raw) {
    if (schema === 2) {
      const item = parseV2(entry);
      if (item)
        items.push({
          ref: item.ref,
          action: item.action,
          subject: item.subject,
          legacy: false,
          item,
        });
      else unreadable += 1;
    } else {
      const read = parseV1(entry);
      if (read) items.push(read);
      else unreadable += 1;
    }
  }
  return { schema, items, unreadable };
}
