/**
 * Resolving ONE item of a graph that stopped part-way — the pure half of
 * `proposals.resolveItem` (PROPOSAL-FAILURES-YOU-CAN-RESOLVE plan, A2).
 *
 * A graph run that throws keeps what landed and stamps the receipt with
 * `opCount`, `failedOp`, `notRun` and `skipped` (`buildStoppedRunRecord`).
 * Approving the proposal again is NOT safe: a second approval run is keyed
 * differently from the first (the plan's finding 5), so it could create the
 * landed items twice. Resolving an item instead:
 *
 *  - applies the person's choice to that ONE item (file it in another space,
 *    file it as another kind, or skip it — skipping also leaves out every
 *    waiting relation that needs it, which could only dangle);
 *  - RESUMES the rest of the run that never ran (`notRun`): those items were
 *    already authorized and never attempted. Items held for a review (a
 *    widened kind waiting for approval) and the relations that need them stay
 *    waiting;
 *  - never re-runs a landed item: landed items are not in the run at all. A
 *    relation to one resolves to its real id, read from the receipt's
 *    per-item record (`byOp`).
 *
 * The run is a SUBSET of the original ops, so positional handles (`$opN`,
 * `$primary`) would point at the wrong op inside it. Every entity op in the
 * subset is renamed `@item<originalIndex>` and every endpoint rewritten to a
 * real id or such a name; results are mapped back to the original keys
 * (`remapRunRecord`). Only entity and relation ops can be resumed: a graph
 * whose remaining steps hold other ops (skills, rules, a plan) is refused
 * with {@link ResolvePlanError} — stated, not guessed.
 */

import {
  PRIMARY_REF,
  type CompositeCreateEntityOp,
  type CompositeCreateRelationOp,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";
import {
  mergeMaterializedRecords,
  opKeys,
  relationOpKey,
  type CompleteMaterializedRecord,
  type LooseOp,
  type MaterializedFailedOp,
  type MaterializedOpRef,
  type MaterializedSkippedOp,
} from "./stamp-materialized.js";

/** What a person can choose for a waiting item (the wire's `action.type`). */
export const RESOLVE_ACTION_TYPES = [
  "file_in_workspace",
  "use_kind",
  "skip",
  "create_kind",
  "widen_kind_scope",
] as const;
export type ResolveActionType = (typeof RESOLVE_ACTION_TYPES)[number];

/** How one item was resolved — `materialized.resolutions[key]`. */
export interface ItemResolution {
  action: ResolveActionType;
  /** filed: it ran (see `byOp`); skipped: left out; held: waits on a review. */
  outcome: "filed" | "skipped" | "held";
  by: string;
  at: string;
  workspaceId?: string;
  profileSlug?: string;
  /** The review it waits on (a kind scope change that needs approval). */
  reviewProposalId?: string;
}

/** The record with the per-item resolutions this module adds. */
export interface ResolvableRecord extends CompleteMaterializedRecord {
  resolutions?: Record<string, ItemResolution>;
  /** A resolution in flight (claimed under a CAS; stale after a few minutes). */
  resolving?: { key: string; by: string; at: string };
}

export interface WaitingItem extends MaterializedOpRef {
  /** failed: the op that threw; not_run: never reached; held: waits on a review. */
  state: "failed" | "not_run" | "held";
  reason?: string;
  errorClass?: string;
  reviewProposalId?: string;
}

export class ResolvePlanError extends Error {
  constructor(
    readonly code: "not_waiting" | "unsupported_op" | "not_an_entity",
    message: string
  ) {
    super(message);
    this.name = "ResolvePlanError";
  }
}

/** Every item still waiting: the failed op first, then what never ran. */
export function waitingItems(record: ResolvableRecord): WaitingItem[] {
  const held = record.resolutions ?? {};
  const out: WaitingItem[] = [];
  if (record.failedOp) {
    out.push({ ...record.failedOp, state: "failed" });
  }
  for (const ref of record.notRun ?? []) {
    const r = held[ref.key];
    out.push(
      r?.outcome === "held"
        ? {
            ...ref,
            state: "held",
            ...(r.reviewProposalId
              ? { reviewProposalId: r.reviewProposalId }
              : {}),
          }
        : { ...ref, state: "not_run" }
    );
  }
  return out;
}

/** Is this a record of a run that stopped part-way? */
export function isStoppedRecord(record: unknown): record is ResolvableRecord {
  return (
    !!record &&
    typeof record === "object" &&
    typeof (record as { opCount?: unknown }).opCount === "number"
  );
}

/**
 * handle → the index of the create_entity op it names, the way the
 * materializer registers them (`registerEntityRef`): `$op<index among ALL
 * ops>`, the op's own `ref`, and `$primary` for the first entity.
 */
export function entityHandles(
  operations: readonly LooseOp[]
): Map<string, number> {
  const map = new Map<string, number>();
  let first: number | undefined;
  operations.forEach((op, i) => {
    if (op.op !== "create_entity") return;
    map.set(`$op${i}`, i);
    if (typeof op.ref === "string" && op.ref) map.set(op.ref, i);
    if (first === undefined) first = i;
  });
  if (first !== undefined) map.set(PRIMARY_REF, first);
  return map;
}

/** The entity op indices a relation op's two ends name (UUID ends: none). */
export function relationEnds(
  op: LooseOp,
  handles: Map<string, number>
): number[] {
  if (op.op !== "create_relation") return [];
  return [op.sourceRef, op.targetRef].flatMap((ref) => {
    const at = typeof ref === "string" ? handles.get(ref) : undefined;
    return at === undefined ? [] : [at];
  });
}

/** entity op index → the id it landed as, read from `byOp` (reverted: none). */
export function landedEntityIds(
  operations: readonly LooseOp[],
  record: CompleteMaterializedRecord
): Map<number, string> {
  const keys = opKeys(operations);
  const out = new Map<number, string>();
  operations.forEach((op, i) => {
    if (op.op !== "create_entity") return;
    const entry = record.byOp?.[keys[i]!];
    if (entry?.entityId && !entry.revertedAt) out.set(i, entry.entityId);
  });
  return out;
}

/** What the person chose for the item, once the server has checked it. */
export type ItemDisposition =
  | {
      kind: "file";
      /** Overrides on the item's op: another space, another kind. */
      targetWorkspaceId?: string;
      profileSlug?: string;
    }
  | { kind: "skip" }
  | { kind: "hold"; reviewProposalId: string };

export interface ResolvePlan {
  item: WaitingItem;
  /** Original op indices to run, in their original order. */
  run: number[];
  /** Ops left out now, with why. */
  skip: Array<{ opIndex: number; reason: string }>;
  /** Ops that keep waiting (held items and the relations that need them). */
  keepWaiting: number[];
  /** Overrides for the item's op, when it runs. */
  overrides?: { targetWorkspaceId?: string; profileSlug?: string };
}

export const SKIPPED_BY_PERSON = "Skipped on review.";
export const SKIPPED_NEEDS_SKIPPED =
  "Left out: it links to an item that was skipped.";
export const SKIPPED_NEEDS_UNFILED =
  "Left out: it links to an item that was not filed.";

const RESUMABLE_OPS = new Set(["create_entity", "create_relation"]);

/**
 * Which ops run, which are left out and which keep waiting, for one choice.
 * Pure: reads the ops, the record and the choice.
 */
export function planResolveRun(args: {
  operations: readonly LooseOp[];
  record: ResolvableRecord;
  itemKey: string;
  disposition: ItemDisposition;
}): ResolvePlan {
  const { operations, record, itemKey, disposition } = args;
  const waiting = waitingItems(record);
  const item = waiting.find((w) => w.key === itemKey);
  if (!item) {
    throw new ResolvePlanError(
      "not_waiting",
      "That item is not waiting: it was filed, skipped or never part of this graph."
    );
  }
  const op = operations[item.opIndex];
  if (!op) {
    throw new ResolvePlanError(
      "not_waiting",
      "That item does not match this graph's steps."
    );
  }
  if (disposition.kind !== "skip" && op.op !== "create_entity") {
    throw new ResolvePlanError(
      "not_an_entity",
      "Only a record can be filed another way. A link can only be skipped."
    );
  }

  const handles = entityHandles(operations);
  const landed = landedEntityIds(operations, record);

  // Items held for a review keep waiting, and so does every relation to one
  // (the item itself joins them when this choice holds it).
  const held = new Set(
    waiting
      .filter((w) => w.state === "held" && w.key !== itemKey)
      .map((w) => w.opIndex)
  );
  if (disposition.kind === "hold") held.add(item.opIndex);
  const skipped = new Set<number>();
  if (disposition.kind === "skip") skipped.add(item.opIndex);

  const skip: ResolvePlan["skip"] = [];
  if (disposition.kind === "skip") {
    skip.push({ opIndex: item.opIndex, reason: SKIPPED_BY_PERSON });
  }
  const keepWaiting: number[] = [];
  const run: number[] = [];

  const waitingIdx = waiting
    .map((w) => w.opIndex)
    .filter((i) => i !== item.opIndex || disposition.kind === "file")
    .sort((a, b) => a - b);
  // The item itself is in `waitingIdx` only when it runs; held/skipped it was
  // recorded above. Entities first decide; relations then follow their ends.
  const runEntities = new Set(
    waitingIdx.filter(
      (i) => operations[i]?.op === "create_entity" && !held.has(i)
    )
  );
  for (const i of waitingIdx) {
    const o = operations[i]!;
    if (held.has(i)) {
      keepWaiting.push(i);
      continue;
    }
    if (!RESUMABLE_OPS.has(o.op)) {
      throw new ResolvePlanError(
        "unsupported_op",
        `This graph's remaining steps include a "${o.op}", which can't be resumed from here yet. Ask the AI to file the rest again.`
      );
    }
    if (o.op === "create_relation") {
      const ends = relationEnds(o, handles);
      if (ends.some((e) => skipped.has(e))) {
        skip.push({ opIndex: i, reason: SKIPPED_NEEDS_SKIPPED });
        continue;
      }
      if (ends.some((e) => held.has(e))) {
        keepWaiting.push(i);
        continue;
      }
      if (ends.some((e) => !landed.has(e) && !runEntities.has(e))) {
        skip.push({ opIndex: i, reason: SKIPPED_NEEDS_UNFILED });
        continue;
      }
    }
    run.push(i);
  }
  if (disposition.kind === "hold") keepWaiting.push(item.opIndex);

  const overrides =
    disposition.kind === "file" &&
    (disposition.targetWorkspaceId || disposition.profileSlug)
      ? {
          ...(disposition.targetWorkspaceId
            ? { targetWorkspaceId: disposition.targetWorkspaceId }
            : {}),
          ...(disposition.profileSlug
            ? { profileSlug: disposition.profileSlug }
            : {}),
        }
      : undefined;

  return {
    item,
    run,
    skip: skip.sort((a, b) => a.opIndex - b.opIndex),
    keepWaiting: [...new Set(keepWaiting)].sort((a, b) => a - b),
    ...(overrides ? { overrides } : {}),
  };
}

/** The name an entity op runs under inside a resume (never positional). */
export const itemRunRef = (originalIndex: number): string =>
  `@item${originalIndex}`;

export interface ResumeOps {
  operations: CompositeProposalOperation[];
  /** subset index → original index. */
  originalIndex: number[];
  /** subset `byOp` key → original key. */
  originalKey: Map<string, string>;
}

/**
 * The subset of ops a resume runs, with every handle made absolute: a landed
 * entity becomes its real id, an entity in the run becomes `@item<i>`. An end
 * starting with `$` that names no entity cannot be left positional (it would
 * name the wrong op inside the subset), so it becomes an unknown name the
 * materializer refuses loudly — reported as a skipped link.
 */
export function buildResumeOps(args: {
  operations: readonly LooseOp[];
  run: readonly number[];
  landed: Map<number, string>;
  overrides?: Map<number, { targetWorkspaceId?: string; profileSlug?: string }>;
}): ResumeOps {
  const { operations, run, landed } = args;
  const handles = entityHandles(operations);
  const keys = opKeys(operations);
  const inRun = new Set(run);
  const rewrite = (ref: unknown): unknown => {
    if (typeof ref !== "string") return ref;
    const at = handles.get(ref);
    if (at === undefined) return ref.startsWith("$") ? `@unknown:${ref}` : ref;
    const id = landed.get(at);
    if (id) return id;
    if (inRun.has(at)) return itemRunRef(at);
    return `@unfiled:${ref}`;
  };

  const ops: CompositeProposalOperation[] = [];
  const originalIndex: number[] = [];
  const originalKey = new Map<string, string>();
  for (const i of run) {
    const op = operations[i]!;
    if (op.op === "create_entity") {
      const entity = op as unknown as CompositeCreateEntityOp;
      const next: CompositeCreateEntityOp = {
        ...entity,
        ...(args.overrides?.get(i) ?? {}),
        ref: itemRunRef(i),
        ...(entity.existingEntityId
          ? { existingEntityId: String(rewrite(entity.existingEntityId)) }
          : {}),
        ...(entity.facets
          ? {
              facets: entity.facets.map((f) =>
                f.contextRef
                  ? { ...f, contextRef: String(rewrite(f.contextRef)) }
                  : f
              ),
            }
          : {}),
      };
      ops.push(next);
      originalKey.set(itemRunRef(i), keys[i]!);
    } else {
      const relation = op as unknown as CompositeCreateRelationOp;
      const next: CompositeCreateRelationOp = {
        ...relation,
        sourceRef: String(rewrite(relation.sourceRef)),
        targetRef: String(rewrite(relation.targetRef)),
      };
      ops.push(next);
      originalKey.set(relationOpKey(next), keys[i]!);
    }
    originalIndex.push(i);
  }
  return { operations: ops, originalIndex, originalKey };
}

function remapRef<T extends MaterializedOpRef>(ref: T, map: ResumeOps): T {
  return {
    ...ref,
    key: map.originalKey.get(ref.key) ?? ref.key,
    opIndex: map.originalIndex[ref.opIndex] ?? ref.opIndex,
  };
}

/** A resume's record, with every key and index back in the original's terms. */
export function remapRunRecord(
  record: CompleteMaterializedRecord,
  map: ResumeOps
): CompleteMaterializedRecord {
  const out: CompleteMaterializedRecord = { ...record };
  if (record.byOp) {
    out.byOp = Object.fromEntries(
      Object.entries(record.byOp).map(([k, v]) => [
        map.originalKey.get(k) ?? k,
        v,
      ])
    );
  }
  if (record.failedOp) out.failedOp = remapRef(record.failedOp, map);
  if (record.notRun) out.notRun = record.notRun.map((r) => remapRef(r, map));
  if (record.skipped) out.skipped = record.skipped.map((r) => remapRef(r, map));
  return out;
}

/** One op as the record addresses it. */
export function opRefAt(
  operations: readonly LooseOp[],
  index: number
): MaterializedOpRef {
  const op = operations[index]!;
  const keys = opKeys(operations);
  let title: string | undefined;
  for (const field of ["title", "name", "goal"] as const) {
    const v = op[field];
    if (typeof v === "string" && v.trim()) {
      title = v.trim().slice(0, 200);
      break;
    }
  }
  return {
    key: keys[index]!,
    opIndex: index,
    op: op.op,
    ...(title ? { title } : {}),
  };
}

const byIndex = (a: MaterializedOpRef, b: MaterializedOpRef) =>
  a.opIndex - b.opIndex;

function uniqueByKey<T extends MaterializedOpRef>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    return true;
  });
}

/**
 * The receipt's record after a resolution: what the resume filed merged over
 * what had landed, the item's resolution recorded, and the stopped-run
 * fields recomputed. Complete (nothing waits) ⇒ `opCount`, `failedOp` and
 * `notRun` are dropped, as a complete stamp drops them; `skipped` and
 * `resolutions` stay so the record still says what was left out and why.
 *
 * `run` is the resume's own record, already remapped. A resume that did not
 * throw can still leave an op without a result (a self-relation it dropped):
 * such an op is recorded as skipped, never left waiting forever.
 */
export function composeResolvedRecord(args: {
  older: ResolvableRecord;
  run: CompleteMaterializedRecord | null;
  /** Did the resume throw? (its `failedOp` / `notRun` then stand) */
  stopped: boolean;
  operations: readonly LooseOp[];
  plan: Pick<ResolvePlan, "skip" | "keepWaiting">;
  /** null: the resume stopped on the item itself, so nothing was resolved. */
  resolution: { key: string; value: ItemResolution } | null;
  stampedAt: string;
}): { record: ResolvableRecord; complete: boolean } {
  const { older, run, stopped, operations, plan } = args;
  const runFiled: CompleteMaterializedRecord = run
    ? { ...run, stampedAt: args.stampedAt }
    : { stampedAt: args.stampedAt };
  delete runFiled.opCount;
  delete runFiled.failedOp;
  delete runFiled.notRun;
  delete runFiled.skipped;
  // Drops the older stopped-run fields (a stamp without `opCount`).
  const merged = mergeMaterializedRecords(older, runFiled) as ResolvableRecord;
  delete merged.resolving;

  const dropped: MaterializedSkippedOp[] = stopped
    ? []
    : (run?.notRun ?? []).map((r) => ({
        ...r,
        reason: "Left out when the rest was filed.",
      }));
  const skipped = uniqueByKey([
    ...(older.skipped ?? []),
    ...plan.skip.map((s) => ({
      ...opRefAt(operations, s.opIndex),
      reason: s.reason,
    })),
    ...(run?.skipped ?? []),
    ...dropped,
  ]).sort(byIndex);
  const failedOp: MaterializedFailedOp | undefined = stopped
    ? run?.failedOp
    : undefined;
  const notRun = uniqueByKey([
    ...(stopped ? (run?.notRun ?? []) : []),
    ...plan.keepWaiting.map((i) => opRefAt(operations, i)),
  ])
    .filter((r) => r.key !== failedOp?.key)
    .sort(byIndex);

  merged.resolutions = {
    ...(older.resolutions ?? {}),
    ...(args.resolution
      ? { [args.resolution.key]: args.resolution.value }
      : {}),
  };
  if (Object.keys(merged.resolutions).length === 0) delete merged.resolutions;
  if (skipped.length > 0) merged.skipped = skipped;
  else delete merged.skipped;

  const complete = !failedOp && notRun.length === 0;
  if (complete) {
    delete merged.opCount;
    delete merged.failedOp;
    delete merged.notRun;
  } else {
    merged.opCount = older.opCount;
    if (failedOp) merged.failedOp = failedOp;
    else delete merged.failedOp;
    merged.notRun = notRun;
  }
  return { record: merged, complete };
}
