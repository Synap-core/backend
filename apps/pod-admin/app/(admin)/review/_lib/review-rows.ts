/**
 * Review's rows — the needs-you page (`signals.list({ lens: "needs-you" })`,
 * the SAME population and order the browser and relay trays read) shaped
 * into what the console draws: one row per decision, filed under
 * Access · Changes · Asks, with its one verb.
 *
 * PURE. The page only renders what this returns, so the filing, the verbs
 * and the batch rules are tested at the seam.
 *
 *   Access  — who may act: `access-request` rows (a pending issuer, an app's
 *             origin) and proposal clusters of class `access` (an agent or
 *             app connecting, a role, a key). Decided one at a time, in the
 *             drawer: never inline, never batched.
 *   Changes — every other pending proposal cluster. Inline Approve only when
 *             the viewer may approve every member and it takes nothing away;
 *             batchable when the viewer may approve every member.
 *   Asks    — everything else a person owes (an answer, a review, a failed
 *             run to look at). An agent's question on a session slot is
 *             answered here (`ask-detail.ts`), one at a time, never batched;
 *             anything else opens where it lives.
 *
 * Review later: a durable proposal untouched for 7 days, or an ask nobody
 * answered for 7 days, leaves the headline and the counts for its own fold —
 * the SHARED fold (`needsYouRows`), so the console folds exactly what the
 * badge leaves out and what the desktop and phone apps fold.
 *
 * Words come from the vocabulary door; nothing here names a kind by hand.
 */

import { proposalSubjectKind } from "../../../proposal/[id]/proposal-subject-kind";
import {
  DESTRUCTIVE_ACTIONS,
  isDestructiveAction,
} from "@synap/governance-policy";
import {
  lensRowOfNeedsYou,
  type LensDoor,
  type LensNeedsYouSignal,
} from "@synap-core/types/lens";
import { isObjectNavView } from "@synap-core/types/navigation";
import { needsYouRows } from "@synap-core/types/needs-you";
import { proposalNeedsItsPage } from "@synap-core/types/proposals";
import { askTextRestates, type Ask } from "@synap-core/types/ask";
import {
  REVIEW_PACKAGE_ORDER,
  isReviewPackage,
  reviewPackageOf,
  type ReviewPackage,
} from "@synap-core/types/proposals/review-package";
import { openIn, type Exit } from "../../../../lib/open-in";
import {
  proposalExpiresAt,
  proposalLapsed,
} from "../../../_lib/proposal-expiry";
import { isUuid } from "../../../../lib/format";
import { askSlotOf, askView, type AskSlot } from "./ask-detail";
import {
  proposalRequester,
  type ProposalPrincipalView,
} from "../../../proposal/[id]/proposal-requester";

export type ReviewGroup = "access" | "changes" | "asks";

/** A Review view: one group, all of them, or decided proposals. */
export type ReviewFilter = "all" | ReviewGroup | "history";

export const REVIEW_FILTERS: readonly ReviewFilter[] = [
  "all",
  "access",
  "changes",
  "asks",
  "history",
];

/**
 * The most rows one needs-you read returns (`signals.list` caps `limit` at
 * 100). Review's page, the session strip's count and the next-proposal door
 * read the SAME page, so they share this one number.
 */
export const NEEDS_YOU_PAGE_LIMIT = 100;

/** `?type=` → the view; anything unknown is "all". */
export function reviewFilterOf(param: string | null | undefined): ReviewFilter {
  return REVIEW_FILTERS.find((f) => f === param) ?? "all";
}

/**
 * `?session=` → the one session Review narrows to (the pod's own session
 * lens on `signals.list`), or null. Anything but a uuid is no filter: the
 * read takes `.uuid()` and would only fail.
 */
export function reviewSessionOf(
  param: string | null | undefined
): string | null {
  return param && isUuid(param) ? param : null;
}

/** The fields of a needs-you signal Review reads (structural). */
export interface ReviewSignal extends LensNeedsYouSignal {
  /** Decision class (`access` = who may act). Clusters and access requests. */
  class?: string | null;
  /** A cluster's sampled member proposal ids (≤ 20; `count` may exceed). */
  proposalIds?: string[] | null;
  /** The most specific readable container — a session or project, named. */
  source?: { kind: string; id: string; label: string } | null;
  /** `owed-slot`: HOW the person can answer (the slot's typed ask). */
  ask?: Ask | null;
  /** `owed-slot`: the agent's own (unverified) claim it produced this. */
  claimedDone?: boolean | null;
  /**
   * The review package the pod stamped — the decision the row asks
   * (`reviewPackageOf`). Absent on a pod older than the stamp: the row is
   * then classified here, through the same function.
   */
  package?: string | null;
}

/**
 * What `proposals.list` says about one pending proposal — the reviewer's own
 * verdict and the names the pod resolved. Keyed by proposal id.
 */
export interface ProposalFacts {
  id: string;
  proposalType: string;
  targetType: string;
  viewerCanReview: boolean;
  appName?: string | null;
  agentName?: string | null;
  authorName?: string | null;
  /** The roles `proposalRequester` names — see `proposal-requester.ts`. */
  agentActorName?: string | null;
  principal?: ProposalPrincipalView | null;
  actorKind?: string | null;
  workspaceName?: string | null;
  data?: unknown;
  /** The request payload (`request.data`), where an entity proposal names its kind. */
  requestData?: unknown;
}

/** What the row's one verb opens. */
export type ReviewDetail =
  | { kind: "proposal"; proposalId: string }
  | { kind: "issuer"; issuerId: string }
  | { kind: "app-request"; requestId: string }
  /**
   * An agent's question on a session slot, answered in the detail. `slot` is
   * the question as it read when the row was built; the page hands the
   * detail the live one too, so it can tell the question changed.
   */
  | { kind: "ask"; sessionId: string; label: string; slot: AskSlot }
  /** Any other ask: decided where it lives, so the row opens it there. */
  | { kind: "open"; door: LensDoor };

/**
 * An ask's door, resolved through the one exit door. The door's `view` rides
 * along: a capture's door is its session's Intake Room (`view: "room"`), and
 * dropping it opened the plain session page — not the thread the ask is in.
 * An unknown view is dropped (the allowlist is `OBJECT_NAV_VIEWS`).
 */
export function exitOf(detail: Extract<ReviewDetail, { kind: "open" }>): Exit {
  const { kind, id, view } = detail.door;
  return openIn({
    kind: "object",
    objectKind: kind,
    id,
    ...(isObjectNavView(view) ? { view } : {}),
  });
}

export interface ReviewRow {
  /** Stable key: the signal id. */
  key: string;
  group: ReviewGroup;
  /** The decision it asks — what Review groups by (founder B-1). */
  package: ReviewPackage;
  /** The session it belongs to, when the viewer may read it. */
  sessionId: string | null;
  /** That session's name. */
  sessionTitle: string | null;
  /** The ONE agent that asked (the pod's `by`), when there is one. */
  agent: { id: string; label: string } | null;
  /** Object kind for the noun chip + icon (`agent`, `issuer`, `track`…). */
  nounKind: string;
  title: string;
  /** Who asked — an agent's or app's NAME, never an id. Null = unknown. */
  who: string | null;
  /** Where — a space, project or session name, or an access request's origin. */
  where: string | null;
  /** A short state chip ("Needs your answer"), when the ask has one. */
  reason: string | null;
  /** How many identical things the row stands for (a cluster's N). */
  count: number;
  occurredAt: string | null;
  /** When it stops being answerable (ISO), or null when it never expires. */
  expiresAt: string | null;
  /**
   * Its moment passed (the pod's sweep has not marked it yet): history, so
   * nothing approves it from the row and no batch takes it.
   */
  expired: boolean;
  /** Null when the row has nothing to open. */
  detail: ReviewDetail | null;
  /** May be approved from the row itself. */
  inlineApprove: boolean;
  /** Every member proposal, when the row may join a batch; else null. */
  batchIds: string[] | null;
  /** Every id a `?focus=` may name this row by. */
  ids: string[];
  /** In the Review later fold: out of the headline and the counts. */
  reviewLater: boolean;
}

/**
 * The ids a row stands for after its signal id: a proposal cluster's members
 * (or its sampled proposal); for any other row, its target's id. Read through
 * here, never by slicing `ids` at a call site.
 */
export function reviewRowMembers(row: Pick<ReviewRow, "ids">): string[] {
  return row.ids.slice(1);
}

/** Which group a needs-you signal files under. */
export function reviewGroupOf(
  s: Pick<ReviewSignal, "kind" | "class">
): ReviewGroup {
  if (s.kind === "access-request") return "access";
  if (s.kind === "proposal-cluster")
    return s.class === "access" ? "access" : "changes";
  return "asks";
}

/**
 * A proposal that TAKES SOMETHING AWAY — the governance floor's destructive
 * actions, plus the removal verbs below that floor. Read off the proposal's
 * own type and, for a capability run, the verb it executes
 * (`entity.delete`). Such a change is never approved from a list row.
 */
const REMOVAL_ACTIONS: ReadonlySet<string> = new Set([
  ...DESTRUCTIVE_ACTIONS,
  "remove",
  "revoke",
  "retire",
  "propose_retire",
]);

export function isRemoval(
  f: Pick<ProposalFacts, "proposalType" | "data">
): boolean {
  const action = (token: string) => {
    const verb = token.slice(token.lastIndexOf(".") + 1);
    return REMOVAL_ACTIONS.has(verb) || isDestructiveAction(verb);
  };
  if (action(f.proposalType)) return true;
  const data = f.data as { verbId?: unknown } | null | undefined;
  return typeof data?.verbId === "string" && action(data.verbId);
}

function iso(at: string | Date | null | undefined): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * A proposal only its own page can decide, so no row approves it inline and
 * no batch sweeps it in: THE rule every surface and the pod's batch door read
 * (`proposalNeedsItsPage`, `@synap-core/types` page-only.ts).
 */
function needsItsPage(f: ProposalFacts | undefined): boolean {
  return f !== undefined && proposalNeedsItsPage(f);
}

/** The members a cluster row decides, when the sample IS the whole cluster. */
function wholeCluster(s: ReviewSignal): string[] | null {
  const ids = s.proposalIds?.length
    ? s.proposalIds
    : s.target?.kind === "proposal"
      ? [s.target.id]
      : [];
  return ids.length > 0 && ids.length === Math.max(1, s.count) ? ids : null;
}

/** A row's kind-specific half; `title` only when it is not the signal's. */
type RowShape = Omit<
  ReviewRow,
  | "key"
  | "group"
  | "package"
  | "sessionId"
  | "sessionTitle"
  | "agent"
  | "title"
  | "occurredAt"
  | "count"
  | "reviewLater"
  | "expired"
> & { title?: string };

function proposalRow(
  s: ReviewSignal,
  group: ReviewGroup,
  facts: ReadonlyMap<string, ProposalFacts>
): RowShape {
  const sampleId = s.target?.kind === "proposal" ? s.target.id : null;
  const sample = sampleId ? facts.get(sampleId) : undefined;
  const members = wholeCluster(s);
  // The viewer's OWN verdict on every member — the bar `approve` enforces.
  const approvable =
    members !== null &&
    members.every((id) => facts.get(id)?.viewerCanReview === true);
  const changes = group === "changes";
  const onItsPage = (members ?? (sampleId ? [sampleId] : [])).some((id) =>
    needsItsPage(facts.get(id))
  );
  return {
    nounKind: sample
      ? proposalSubjectKind(sample, sample.requestData ?? sample.data) ||
        "proposal"
      : "proposal",
    who: (sample && proposalRequester(sample)) || sample?.agentName || null,
    where: sample?.workspaceName || s.source?.label || null,
    reason: null,
    expiresAt: null,
    detail: sampleId ? { kind: "proposal", proposalId: sampleId } : null,
    inlineApprove:
      changes &&
      approvable &&
      !onItsPage &&
      sample !== undefined &&
      !isRemoval(sample),
    batchIds: changes && approvable && !onItsPage ? members : null,
    ids: [s.id, ...(s.proposalIds ?? (sampleId ? [sampleId] : []))],
  };
}

function accessRow(s: ReviewSignal): RowShape {
  const target = s.target;
  return {
    nounKind: s.access?.subject ?? "application",
    // The asker is named in the title; the row says where it asks from.
    who: null,
    where: s.access?.from ?? null,
    reason: null,
    expiresAt: null,
    detail:
      target?.kind === "issuer"
        ? { kind: "issuer", issuerId: target.id }
        : target?.kind === "connection-request"
          ? { kind: "app-request", requestId: target.id }
          : null,
    inlineApprove: false,
    batchIds: null,
    ids: [s.id, ...(target ? [target.id] : [])],
  };
}

function askRow(s: ReviewSignal): RowShape {
  // The shared lens row decides an ask's noun, chip, door and title (the
  // card's question, `askCardView`) — the same words browser and relay draw.
  const lens = lensRowOfNeedsYou(
    { kind: "item", key: s.id, signal: s, session: null },
    "blocking"
  );
  const slot = askSlotOf(s);
  // Who asked: the agent by name, else the cause — the card's own mark.
  const asker = slot ? askView(slot).asker : null;
  const where = s.source?.label || s.sessionTitle || null;
  return {
    title: lens.title,
    nounKind: lens.objectKind,
    who: asker ? (asker.kind === "agent" ? asker.name : asker.label) : null,
    // A session named after the question ("Decide: X") says it twice.
    where: where && !askTextRestates(where, lens.title) ? where : null,
    reason: lens.reason,
    expiresAt: null,
    detail: slot
      ? { kind: "ask", sessionId: slot.sessionId, label: slot.label, slot }
      : lens.door
        ? { kind: "open", door: lens.door }
        : null,
    inlineApprove: false,
    batchIds: null,
    ids: [s.id, ...(s.target ? [s.target.id] : [])],
  };
}

/**
 * The page's rows, in the SERVER's order (newest first across kinds), one per
 * signal — a session owing several things is several rows here: Review
 * decides each, it does not summarise.
 */
export function reviewRows(
  signals: readonly ReviewSignal[],
  facts: ReadonlyMap<string, ProposalFacts>,
  now: number = Date.now()
): ReviewRow[] {
  const later = reviewLaterIds(signals);
  return signals.map((s) => {
    const group = reviewGroupOf(s);
    const shape =
      s.kind === "access-request"
        ? accessRow(s)
        : s.kind === "proposal-cluster"
          ? proposalRow(s, group, facts)
          : askRow(s);
    const occurredAt = iso(s.occurredAt);
    const expiresAt = proposalExpiresAt(occurredAt, s.lifetimeHours);
    const expired = proposalLapsed(expiresAt, now);
    const sessionId = sessionOf(s);
    return {
      ...shape,
      ...(expired ? { inlineApprove: false, batchIds: null } : {}),
      key: s.id,
      group,
      package: packageOf(s, facts),
      sessionId,
      sessionTitle: sessionId
        ? s.sessionTitle ||
          (s.source?.kind === "session" ? s.source.label : null) ||
          null
        : null,
      agent: s.by?.id && s.by.label ? { id: s.by.id, label: s.by.label } : null,
      title: shape.title ?? s.title,
      occurredAt,
      expiresAt,
      expired,
      count: Math.max(1, s.count),
      reviewLater: later.has(s.id),
    };
  });
}

/** The signals the shared needs-you fold puts in Review later. */
function reviewLaterIds(signals: readonly ReviewSignal[]): Set<string> {
  return new Set(
    needsYouRows(signals).reviewLater.flatMap((r) =>
      r.kind === "item" ? [r.signal.id] : r.items.map((s) => s.id)
    )
  );
}

const SESSION_KEY = "session:";

/** The session a row belongs to: its block key, else a session source. */
function sessionOf(s: ReviewSignal): string | null {
  if (s.groupKey?.startsWith(SESSION_KEY))
    return s.groupKey.slice(SESSION_KEY.length);
  return s.source?.kind === "session" ? s.source.id : null;
}

/**
 * The row's review package: the pod's stamp, else the same classifier over
 * what the page knows (a pod older than the stamp).
 */
function packageOf(
  s: ReviewSignal,
  facts: ReadonlyMap<string, ProposalFacts>
): ReviewPackage {
  if (isReviewPackage(s.package)) return s.package;
  const sample =
    s.target?.kind === "proposal" ? facts.get(s.target.id) : undefined;
  const request = sample?.requestData as { profileSlug?: unknown } | undefined;
  return reviewPackageOf({
    kind: s.kind,
    proposalType: sample?.proposalType,
    targetType: sample?.targetType,
    class: s.class,
    data: sample?.data,
    objectKind:
      typeof request?.profileSlug === "string" ? request.profileSlug : null,
  });
}

// ── Grouping (founder B-1 / B-4) ─────────────────────────────────────────────

/** How many things rows stand for — a cluster counts its members. */
export function itemCount(rows: readonly ReviewRow[]): number {
  return rows.reduce((n, r) => n + r.count, 0);
}

/** The oldest `occurredAt` of rows (ISO), or null when none is known. */
export function oldestAt(rows: readonly ReviewRow[]): string | null {
  let oldest: string | null = null;
  for (const r of rows)
    if (r.occurredAt && (oldest === null || r.occurredAt < oldest))
      oldest = r.occurredAt;
  return oldest;
}

/** One package's rows, in the page's order. */
export interface PackageGroup {
  package: ReviewPackage;
  rows: ReviewRow[];
}

/**
 * Rows by PACKAGE, in the fixed order (stakes first); a package with no row
 * is left out. Inside a package the server's order (newest first) holds.
 */
export function packageGroups(rows: readonly ReviewRow[]): PackageGroup[] {
  return REVIEW_PACKAGE_ORDER.map((pkg) => ({
    package: pkg,
    rows: rows.filter((r) => r.package === pkg),
  })).filter((g) => g.rows.length > 0);
}

/** A block of rows under one session or one agent. */
export interface RowGroup {
  /** The session or agent id; `null` for the rows that have none. */
  id: string | null;
  /** Its name; `null` for the rows that have none (the page words it). */
  title: string | null;
  rows: ReviewRow[];
}

function groupBy(
  rows: readonly ReviewRow[],
  keyOf: (r: ReviewRow) => { id: string; title: string | null } | null
): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  const loose: ReviewRow[] = [];
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) {
      loose.push(r);
      continue;
    }
    const g = groups.get(key.id);
    if (g) {
      g.rows.push(r);
      g.title ??= key.title;
    } else groups.set(key.id, { id: key.id, title: key.title, rows: [r] });
  }
  // First appearance = the server's newest-first order; the loose rows last.
  const out = [...groups.values()];
  if (loose.length > 0) out.push({ id: null, title: null, rows: loose });
  return out;
}

/** Rows by SESSION ("Group by Work", and Bookkeeping's fold). */
export function sessionGroups(rows: readonly ReviewRow[]): RowGroup[] {
  return groupBy(rows, (r) =>
    r.sessionId ? { id: r.sessionId, title: r.sessionTitle } : null
  );
}

/** Rows by the AGENT that asked ("Group by Agent", and Hand-offs' fold). */
export function agentGroups(rows: readonly ReviewRow[]): RowGroup[] {
  return groupBy(rows, (r) =>
    r.agent ? { id: r.agent.id, title: r.agent.label } : null
  );
}

/**
 * What "Keep all" / "Allow all" over a set of rows approves: the batchable
 * rows, in order, while their members fit ONE batch (`BATCH_MAX`). A row the
 * viewer may not approve whole, an access row, a page-only proposal or an
 * expired one is never swept in (`batchIds` is null for each). `left` is how
 * many rows the action does NOT take.
 */
export function keepAllOf(rows: readonly ReviewRow[]): {
  rows: ReviewRow[];
  proposalIds: string[];
  left: number;
} {
  const picked: ReviewRow[] = [];
  const proposalIds: string[] = [];
  for (const r of rows) {
    if (!r.batchIds) continue;
    if (proposalIds.length + r.batchIds.length > BATCH_MAX) break;
    picked.push(r);
    proposalIds.push(...r.batchIds);
  }
  return { rows: picked, proposalIds, left: rows.length - picked.length };
}

/**
 * The ONE suggestion Review offers (optional, last in the brief): agents'
 * notes on their own sessions that can all be kept at once. Offered when
 * Bookkeeping holds at least two items and "Keep all" takes every row.
 */
export function bookkeepingSuggestion(
  rows: readonly ReviewRow[]
): { count: number; sessions: number; rows: ReviewRow[] } | null {
  const books = rows.filter((r) => r.package === "bookkeeping");
  const keep = keepAllOf(books);
  const count = itemCount(keep.rows);
  if (count < 2 || keep.left > 0) return null;
  return {
    count,
    sessions: sessionGroups(keep.rows).length,
    rows: keep.rows,
  };
}

/** The live question an open ask detail names, or null once it moved on. */
export function liveAskSlot(
  rows: readonly ReviewRow[],
  detail: { sessionId: string; label: string }
): AskSlot | null {
  for (const r of rows) {
    if (
      r.detail?.kind === "ask" &&
      r.detail.sessionId === detail.sessionId &&
      r.detail.label === detail.label
    )
      return r.detail.slot;
  }
  return null;
}

/** Rows per chip: All and each group — the headline, as the badge counts it. */
export function reviewCounts(
  rows: readonly ReviewRow[]
): Record<"all" | ReviewGroup, number> {
  const out = { all: 0, access: 0, changes: 0, asks: 0 };
  for (const r of rows) {
    if (r.reviewLater) continue;
    out.all += 1;
    out[r.group] += 1;
  }
  return out;
}

/**
 * What each chip SAYS — one number, one source (ui-composition §11). All is
 * the pod's count (`signals.count`, the nav badge's) when Review is not
 * narrowed; a group is counted from the page read, which stops at
 * `NEEDS_YOU_PAGE_LIMIT`: on a full page a group's count is a floor ("N+"),
 * and a group with none on it is unknown (no count), never "0".
 */
export function reviewChipCounts(
  rows: readonly ReviewRow[],
  total: { needsYou: number; truncated: boolean } | null
): Record<"all" | ReviewGroup, string | undefined> {
  const counts = reviewCounts(rows);
  const full = rows.length >= NEEDS_YOU_PAGE_LIMIT;
  const floor = (n: number): string | undefined =>
    !full ? String(n) : n > 0 ? `${n}+` : undefined;
  return {
    all: total
      ? total.truncated
        ? `${total.needsYou}+`
        : String(total.needsYou)
      : floor(counts.all),
    access: floor(counts.access),
    changes: floor(counts.changes),
    asks: floor(counts.asks),
  };
}

/**
 * What a needs-you view shows ("history" is not one): its headline rows, and
 * the rows of its Review later fold.
 */
export function rowsInView(
  rows: readonly ReviewRow[],
  filter: Exclude<ReviewFilter, "history">
): { headline: ReviewRow[]; reviewLater: ReviewRow[] } {
  const inView =
    filter === "all" ? rows : rows.filter((r) => r.group === filter);
  return {
    headline: inView.filter((r) => !r.reviewLater),
    reviewLater: inView.filter((r) => r.reviewLater),
  };
}

/** The row a `?focus=<id>` names — by signal, target or member proposal id. */
export function focusedRow(
  rows: readonly ReviewRow[],
  focusId: string | null
): ReviewRow | null {
  if (!focusId) return null;
  return rows.find((r) => r.ids.includes(focusId)) ?? null;
}

/** The most proposals one batch call takes (`proposals.batchApprove`). */
export const BATCH_MAX = 50;

/**
 * What a batch over the selected rows acts on: only batchable rows (never an
 * access row, never one the viewer may not approve whole), their member ids
 * flattened. `tooMany` past the batch door's limit.
 */
export function batchOf(
  rows: readonly ReviewRow[],
  selected: ReadonlySet<string>
): { rows: ReviewRow[]; proposalIds: string[]; tooMany: boolean } {
  const picked = rows.filter((r) => selected.has(r.key) && r.batchIds);
  const proposalIds = picked.flatMap((r) => r.batchIds ?? []);
  return {
    rows: picked,
    proposalIds,
    tooMany: proposalIds.length > BATCH_MAX,
  };
}

/** One per-proposal outcome of `proposals.batchApprove`. */
export interface BatchItemResult {
  proposalId: string;
  success: boolean;
  error?: string;
}

/**
 * A batch approve's outcome, per ROW: a row is approved when every member
 * landed; a failed member names its row's title and the pod's own reason.
 */
export function summarizeBatch(
  rows: readonly ReviewRow[],
  results: readonly BatchItemResult[]
): { approved: number; failures: Array<{ title: string; error: string }> } {
  const byId = new Map(results.map((r) => [r.proposalId, r]));
  let approved = 0;
  const failures: Array<{ title: string; error: string }> = [];
  for (const row of rows) {
    const failed = (row.batchIds ?? [])
      .map((id) => byId.get(id))
      .find((r) => r && !r.success);
    if (failed) {
      failures.push({
        title: row.title,
        error: failed.error?.trim() || "It could not be approved.",
      });
    } else approved += 1;
  }
  return { approved, failures };
}
