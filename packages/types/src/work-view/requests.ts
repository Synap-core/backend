/**
 * requestsOf — the needs-you HEADLINE as REQUESTS: what the person is asked,
 * once each, and at most {@link REQUESTS_HEADLINE_CAP} at a time (plan
 * 5207fbb6 "one timeline for Work", point of view 3e47abde §1; needs doc
 * da5d922a: 32 headline rows, one notification repeated 26 times).
 *
 * Input: the needs-you page's signal rows as the pod sends them (`signals.list`
 * `lens: "needs-you"`, or Hub `GET /needs-you` `rows.needs_you`). The rows
 * the pod classed OUT of the headline (any `needsYouClass` fold, an older
 * pod's `reviewLater`) are not requests: they are counted in
 * `outOfHeadline` and never drawn here.
 *
 * The rules, in the order they apply (each one only ever JOINS rows; no row is
 * dropped, every signal is in exactly one request's `items`):
 *
 *   1. ORDER — the Inbox's triage order, never a new one: `needsYouBuckets`
 *      (`orderNeedsYouByBlocking`): P0 first, judgements, the four buckets,
 *      priority, rows that stop a job, then the pod's order.
 *   2. REPEATS — a notification raised N times is already ONE row with
 *      `repeatCount: N` (`repeatOf`); `copies` keeps the N.
 *   3. TWINS — the same ask twice: same kind, same title (case and spacing
 *      folded) and same SUBJECT (`subjectEntityId`, else the job). Merged into
 *      the first, in order.
 *   4. ROLL-UP — a child job's asks belong to its parent job: `parentOf`
 *      (from the work graph's `spawned_from` edges, {@link parentOfGraph})
 *      climbs to the top job the caller can see. A job asking 2+ things is ONE
 *      `job` request; its own BOOKKEEPING (an acceptance review, a stage gate,
 *      a criterion to grade) rides inside it, never as a request of its own.
 *   5. BATCH — what is left as single asks, of the SAME kind across jobs, is
 *      one `batch` request ("Check 3 sends"): the same title asked by several
 *      jobs (one playbook's step), the same thing to provide (a credential, a
 *      permission, a capability), the same request action
 *      (`capability.run`, `playbook.stage_gate`…), the same notification
 *      type, or the jobs' own bookkeeping (accept these jobs). Only at
 *      {@link ROUTINE_BATCH_MIN} or more. A batch is checked together, item by
 *      item: `routine` is true only when every item is a routine change, the
 *      one class a surface may approve at once.
 *   6. CAP — the first {@link REQUESTS_HEADLINE_CAP} requests are the
 *      headline; the rest are `waiting` ("N waiting", a door).
 *
 * Deterministic: a request sits where its FIRST item sat in the triage order.
 * Pure; no words (a surface names a request through the vocabulary door).
 */

import {
  ROUTINE_BATCH_MIN,
  needsYouBuckets,
  needsYouFoldOf,
  needsYouItemKind,
  needsYouReasonOf,
  repeatOf,
  sessionIdOfGroupKey,
  type BucketableSignal,
  type GroupableSignal,
  type NeedsYouBucket,
  type NeedsYouBucketOptions,
} from "../needs-you/index.js";

/** How many requests the headline shows (Home and the Work page, founder D, 16 Nov). */
export const REQUESTS_HEADLINE_CAP = 5;

/** The fields of a needs-you signal row {@link requestsOf} reads (structural). */
export interface RequestSignal extends GroupableSignal, BucketableSignal {
  groupKey: string | null;
  title?: string | null;
  /** `owed-slot`: the entity the job is about — what makes two asks twins. */
  subjectEntityId?: string | null;
  /** `owed-slot`: the slot's kind (`criterion` = a grade, bookkeeping). */
  slotKind?: string | null;
}

export type WorkRequestKind = "ask" | "job" | "batch";

export interface WorkRequest<T extends RequestSignal> {
  /** Stable key: `ask:<signal id>`, `job:<job id>` or `batch:<batch key>`. */
  key: string;
  kind: WorkRequestKind;
  /** The most blocking item: what the card leads with. */
  lead: T;
  /** Every signal row it stands for, lead first, in triage order (twins included). */
  items: T[];
  /** The lead's Inbox bucket. */
  bucket: NeedsYouBucket;
  /** The lead's reason key (`needsYouReasonOf`): the glyph a surface draws. */
  reason: string;
  /** The top job it belongs to (`job` / `ask`); null for a batch or a job-less row. */
  jobId: string | null;
  /** Every distinct top job its items belong to. */
  jobIds: string[];
  /** The batch key a `batch` was made on; null otherwise. */
  batchKey: string | null;
  /** Rows merged as the same ask (twins), beyond the first of each. */
  twins: number;
  /** Every item is a job's own bookkeeping. */
  bookkeeping: boolean;
  /** Every item is a routine change: the one class approved together. */
  routine: boolean;
  /** How many copies the person was shown for it: repeats and twins included. */
  copies: number;
}

export interface WorkRequests<T extends RequestSignal> {
  /** At most `cap` requests, in triage order. */
  headline: WorkRequest<T>[];
  /** The rest, in order: "N waiting". */
  waiting: WorkRequest<T>[];
  /** Before and after, on the rows handed in. */
  counts: {
    /** Headline signal rows handed in. */
    rows: number;
    /** Copies those rows stand for (a notification's repeats counted). */
    copies: number;
    /** Requests after merge, roll-up and batch (`headline` + `waiting`). */
    requests: number;
    /** Rows the pod classed out of the headline: not requests here. */
    outOfHeadline: number;
  };
}

export interface RequestsOptions<
  T extends RequestSignal,
> extends NeedsYouBucketOptions<T> {
  /** A job's parent job, or null at a root (`parentOfGraph`). Absent: no roll-up. */
  parentOf?: (jobId: string) => string | null | undefined;
  /** Headline size; default {@link REQUESTS_HEADLINE_CAP}. */
  cap?: number;
}

/** Things to PROVIDE: the same act across jobs (go get a key, grant a right). */
const PROVIDE_REASONS: ReadonlySet<string> = new Set([
  "credential",
  "permission",
  "capability",
]);

/** The action a request cluster is about: `capability.run`, `playbook.stage_gate`… */
export function requestActionOf(signal: {
  kind: string;
  id: string;
}): string | null {
  if (signal.kind !== "proposal-cluster") return null;
  // `cluster:<action>\u0000<subject type>\u0000<subject>@<proposal>` (the pod's
  // fingerprint, `needs-you-union.ts`): the action is its first part.
  const PREFIX = "cluster:";
  if (!signal.id.startsWith(PREFIX)) return null;
  const end = signal.id.indexOf("\u0000", PREFIX.length);
  return end > PREFIX.length ? signal.id.slice(PREFIX.length, end) : null;
}

/**
 * A job's own bookkeeping: what is decided with the job's acceptance, not one
 * by one (finding 1e5f1aa5) — its review for acceptance, a stage gate of its
 * playbook, a criterion the person grades.
 */
export function isBookkeeping(
  signal: Pick<RequestSignal, "kind" | "id" | "slotKind">
): boolean {
  if (signal.kind === "session-review") return true;
  if (signal.kind === "owed-slot") return signal.slotKind === "criterion";
  return requestActionOf(signal) === "playbook.stage_gate";
}

function foldTitle(title: string | null | undefined): string {
  return (title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The top job a job rolls up to (cycle-safe); the job itself without `parentOf`. */
function topJobOf(
  jobId: string,
  parentOf: RequestsOptions<RequestSignal>["parentOf"]
): string {
  if (!parentOf) return jobId;
  const seen = new Set([jobId]);
  let at = jobId;
  for (;;) {
    const up = parentOf(at);
    if (!up || seen.has(up)) return at;
    seen.add(up);
    at = up;
  }
}

/** One request being built — internal. */
interface Draft<T extends RequestSignal> {
  kind: WorkRequestKind;
  key: string;
  items: T[];
  buckets: NeedsYouBucket[];
  jobId: string | null;
  batchKey: string | null;
  twins: number;
  /** Triage position of its first item. */
  at: number;
}

/**
 * The needs-you headline rows as requests: merged, rolled up, batched and
 * capped. See the module rule.
 */
export function requestsOf<T extends RequestSignal>(
  signals: readonly T[],
  opts: RequestsOptions<T> = {}
): WorkRequests<T> {
  const cap = Math.max(0, opts.cap ?? REQUESTS_HEADLINE_CAP);
  const inHeadline = signals.filter((s) => needsYouFoldOf(s) === null);
  const outOfHeadline = signals.length - inHeadline.length;
  const ordered = needsYouBuckets(inHeadline, opts).rows;

  const jobOf = (s: T): string | null => {
    const id = sessionIdOfGroupKey(s.groupKey);
    return id
      ? topJobOf(
          id,
          opts.parentOf as RequestsOptions<RequestSignal>["parentOf"]
        )
      : null;
  };

  // 3. Twins: one draft per distinct ask.
  const asks: Draft<T>[] = [];
  const byTwinKey = new Map<string, Draft<T>>();
  ordered.forEach(({ signal, bucket }, at) => {
    const jobId = jobOf(signal);
    const title = foldTitle(signal.title);
    const subject = signal.subjectEntityId || jobId;
    const twinKey =
      title && subject ? `${signal.kind}|${title}|${subject}` : null;
    const twin = twinKey ? byTwinKey.get(twinKey) : undefined;
    if (twin) {
      twin.items.push(signal);
      twin.buckets.push(bucket);
      twin.twins += 1;
      return;
    }
    const draft: Draft<T> = {
      kind: "ask",
      key: `ask:${signal.id}`,
      items: [signal],
      buckets: [bucket],
      jobId,
      batchKey: null,
      twins: 0,
      at,
    };
    asks.push(draft);
    if (twinKey) byTwinKey.set(twinKey, draft);
  });

  // 4. Roll-up: a job asking 2+ distinct things is one job request.
  const perJob = new Map<string, Draft<T>[]>();
  for (const d of asks) {
    if (!d.jobId) continue;
    const list = perJob.get(d.jobId) ?? [];
    list.push(d);
    perJob.set(d.jobId, list);
  }
  const drafts: Draft<T>[] = [];
  const singles: Draft<T>[] = [];
  const jobDone = new Set<string>();
  for (const d of asks) {
    const group = d.jobId ? perJob.get(d.jobId)! : [d];
    if (group.length < 2) {
      singles.push(d);
      continue;
    }
    if (jobDone.has(d.jobId!)) continue;
    jobDone.add(d.jobId!);
    drafts.push({
      kind: "job",
      key: `job:${d.jobId}`,
      items: group.flatMap((g) => g.items),
      buckets: group.flatMap((g) => g.buckets),
      jobId: d.jobId,
      batchKey: null,
      twins: group.reduce((n, g) => n + g.twins, 0),
      at: d.at,
    });
  }

  // 5. Batch the single asks of the same kind across jobs.
  const titleJobs = new Map<string, Set<string>>();
  for (const d of singles) {
    const s = d.items[0]!;
    if (s.kind !== "owed-slot" || !foldTitle(s.title)) continue;
    const set = titleJobs.get(foldTitle(s.title)) ?? new Set<string>();
    set.add(d.jobId ?? s.id);
    titleJobs.set(foldTitle(s.title), set);
  }
  const batchKeyOf = (s: T): string | null => {
    if (isBookkeeping(s)) return "bookkeeping";
    if (s.kind === "owed-slot") {
      const t = foldTitle(s.title);
      if (t && (titleJobs.get(t)?.size ?? 0) >= 2) return `slot-title:${t}`;
      const reason = needsYouItemKind(s);
      return PROVIDE_REASONS.has(reason) ? `slot:${reason}` : null;
    }
    const action = requestActionOf(s);
    if (action) return `request:${action}`;
    if (s.kind === "notification" && s.notificationType) {
      return `notification:${s.notificationType}`;
    }
    return null;
  };
  const byBatch = new Map<string, Draft<T>[]>();
  for (const d of singles) {
    const key = batchKeyOf(d.items[0]!);
    if (!key) continue;
    const list = byBatch.get(key) ?? [];
    list.push(d);
    byBatch.set(key, list);
  }
  const batched = new Set<Draft<T>>();
  for (const [key, group] of byBatch) {
    if (group.length < ROUTINE_BATCH_MIN) continue;
    group.forEach((g) => batched.add(g));
    drafts.push({
      kind: "batch",
      key: `batch:${key}`,
      items: group.flatMap((g) => g.items),
      buckets: group.flatMap((g) => g.buckets),
      jobId: null,
      batchKey: key,
      twins: group.reduce((n, g) => n + g.twins, 0),
      at: group[0]!.at,
    });
  }
  for (const d of singles) if (!batched.has(d)) drafts.push(d);

  // 6. Order by first item, then cap.
  drafts.sort((a, b) => a.at - b.at);
  const requests = drafts.map((d) => toRequest(d, jobOf));
  return {
    headline: requests.slice(0, cap),
    waiting: requests.slice(cap),
    counts: {
      rows: inHeadline.length,
      copies: inHeadline.reduce((n, s) => n + repeatOf(s), 0),
      requests: requests.length,
      outOfHeadline,
    },
  };
}

function toRequest<T extends RequestSignal>(
  d: Draft<T>,
  jobOf: (s: T) => string | null
): WorkRequest<T> {
  const lead = d.items[0]!;
  const jobIds = [
    ...new Set(d.items.map(jobOf).filter((j): j is string => j !== null)),
  ];
  return {
    key: d.key,
    kind: d.kind,
    lead,
    items: d.items,
    bucket: d.buckets[0]!,
    reason: needsYouReasonOf(lead),
    jobId: d.kind === "batch" ? null : d.jobId,
    jobIds,
    batchKey: d.batchKey,
    twins: d.twins,
    bookkeeping: d.items.every(isBookkeeping),
    routine: d.buckets.every((b) => b === "routine"),
    copies: d.items.reduce((n, s) => n + repeatOf(s), 0),
  };
}
