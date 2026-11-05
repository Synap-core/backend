/**
 * Resolve ONE waiting item of a graph that stopped part-way — the DB half of
 * `proposals.resolveOptions` and `proposals.resolveItem`
 * (PROPOSAL-FAILURES-YOU-CAN-RESOLVE plan, A2; founder decisions D1–D3).
 *
 * Live 2026-10-22 (proposal e8fc00d6): a capture graph filed 4 of its 5
 * items; the fifth named the kind `trend`, which exists only in Ecosystem,
 * not in Foundation where it was filed. Approving again would re-run the
 * whole graph under a different idempotency key and could file the 4 landed
 * items twice. Here the person resolves the waiting item instead:
 *
 *  - `resolveOptions` lists every waiting item with its ranked choices. For a
 *    missing kind (D3): file it where the kind lives (recommended: same kind,
 *    nothing new), make the kind available here (a governed scope change),
 *    file it as another kind (`resolve-kind-rank.ts`), create the kind
 *    (not yet: see below), skip it.
 *  - `resolveItem` applies one choice and resumes what never ran
 *    (`resolve-item-plan.ts`), keyed per item so a double press links what
 *    the first created. The receipt records each item's outcome
 *    (`materialized.resolutions`); when nothing waits it reads complete and
 *    the proposal is approved by the person who resolved it.
 *
 * Only spaces and kinds the CALLER can read are ever named (the caller may not
 * be who filed it): `describeMissingKind` floors on the caller's spaces, and
 * the other kinds are the caller's accessible kinds in the item's space.
 *
 * `create_kind` is NOT implemented yet: the governed define-kind door
 * (`defineProfile`) takes a Hub Protocol caller with an agent write scope, and
 * a person's session has no such caller. It is offered as unavailable and
 * refused with a clear sentence. TODO(A2 create_kind): route it through the
 * human `profiles.create` door (which runs `checkPermissionOrPropose`) plus
 * its field defs, then hold the item when that yields a proposal.
 */

import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import {
  and,
  db,
  drizzleSql,
  eq,
  getWorkspaceMembership,
  inArray,
  ne,
  profileProperties,
  profiles,
  propertyDefs,
  proposals,
  slugifyPropertyKey,
  transitionProposal,
  workspaces,
  ProfileResolutionService,
  PROFILE_ORIGIN_PROBE,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  normalizeProposalSource,
  type CompositeProposalOperation,
  type ProposalItemDisposition,
} from "@synap-core/types/proposals";
import { createLogger } from "@synap-core/core";
import { WORK_CLOCK } from "@synap-core/types/work-clock";
import {
  materializeCompositeGraph,
  readPartialMaterialization,
  type MaterializeResult,
} from "../../utils/materialize-composite.js";
import { makeExternalLinkIdempotency } from "../../utils/entity-link-idempotency.js";
import { buildRuleLoopCallers } from "../../utils/rule-loop-callers.js";
import { approvalIdempotencyProvider } from "./approval-idempotency.js";
import {
  buildStoppedRunRecord,
  type CompleteMaterializedRecord,
  type LooseOp,
} from "./stamp-materialized.js";
import {
  classifyThrownFailure,
  failureRecord,
  safeFailureSentence,
} from "../../routers/proposals/failure-classification.js";
import { redactForStorage } from "../../utils/redact-secrets.js";
import { proposalUnchangedSince } from "./proposal-cas.js";
import { validateWorkspaceAccess } from "../../utils/workspace-membership.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { twinsShownOnCard } from "../duplicates/find-duplicate-candidates.js";
import { BACKGROUND_APPROVAL_MIN_OPERATIONS } from "./approval-runs.js";
import {
  announceCompositeApproved,
  bindGraphChannels,
  reconcileCompositeEntityOps,
  recordProducedEntities,
  withProposedIdentityResolutions,
} from "../../routers/proposals/apply-approval.js";
import { describeMissingKind } from "../profiles/kind-elsewhere.js";
import type { KindMissingDetail } from "../../utils/kind-missing.js";
import {
  buildResumeOps,
  composeResolvedRecord,
  entityHandles,
  isStoppedRecord,
  landedEntityIds,
  opRefAt,
  planResolveRun,
  relationEnds,
  remapRunRecord,
  ResolvePlanError,
  waitingItems,
  type ItemDisposition,
  type ItemResolution,
  type ResolvableRecord,
  type WaitingItem,
} from "./resolve-item-plan.js";
import {
  rankKindSuggestions,
  type KindSuggestionSignals,
} from "./resolve-kind-rank.js";

const logger = createLogger({ module: "resolve-item" });

/** What `resolveItem` takes as `action` (the option's `action`, echoed). */
export type ResolveActionInput =
  | { type: "file_in_workspace"; workspaceId: string }
  | { type: "use_kind"; profileSlug: string }
  | { type: "skip" }
  | { type: "create_kind" }
  | { type: "widen_kind_scope"; profileId: string };

interface OptionBase {
  recommended: boolean;
  /** false: shown for what it will be, refused for now (`unavailableReason`). */
  available: boolean;
  unavailableReason?: "not_yet" | "review_pending";
}

/** One choice for a waiting item. `kind` picks the words; `action` is sent back. */
export type ResolveOption = OptionBase &
  (
    | {
        /** The item's own kind is available where it lands now. */
        kind: "file_here_now";
        action: { type: "use_kind"; profileSlug: string };
        kindName: string;
      }
    | {
        kind: "file_in_workspace";
        action: { type: "file_in_workspace"; workspaceId: string };
        workspaceName: string;
        kindName: string;
      }
    | {
        kind: "widen_kind_scope";
        action: { type: "widen_kind_scope"; profileId: string };
        kindName: string;
        fromWorkspaceName: string;
        intoWorkspaceName: string;
      }
    | {
        kind: "use_kind";
        action: { type: "use_kind"; profileSlug: string };
        kindName: string;
        signals: KindSuggestionSignals;
      }
    | {
        kind: "create_kind";
        action: { type: "create_kind" };
        draft: {
          slug: string;
          displayName: string;
          fields: Array<{ slug: string; valueType: string }>;
        };
        intoWorkspaceName?: string;
      }
    | {
        /** File it again as it was proposed (a failure that was not its kind). */
        kind: "retry";
        action: { type: "use_kind"; profileSlug: string };
      }
    | {
        /** A record the run never reached (no step failed): file it as proposed. */
        kind: "file_as_proposed";
        action: { type: "use_kind"; profileSlug: string };
      }
    | { kind: "skip"; action: { type: "skip" } }
  );

export interface ResolveItemView {
  /** The item's key on the receipt — what `resolveItem` takes as `itemRef`. */
  itemRef: string;
  opIndex: number;
  op: string;
  title?: string;
  state: WaitingItem["state"];
  /** The safe sentence of why it failed (the failed item only). */
  reason?: string;
  errorClass?: string;
  /** The review a held item waits on. */
  reviewProposalId?: string;
  /** A missing kind, described for THIS caller (only spaces they can read). */
  kindMissing?: KindMissingDetail;
  /** The keys of the waiting links that need this item. */
  dependents: string[];
  /** Best first; at most one is `recommended`. */
  options: ResolveOption[];
}

export interface ResolveOptionsResult {
  resolvable: boolean;
  reason?:
    | "not_a_stopped_graph"
    | "already_decided"
    | "record_mismatch"
    | "nothing_waiting";
  opCount?: number;
  items: ResolveItemView[];
}

type ProposalRow = NonNullable<
  Awaited<ReturnType<typeof db.query.proposals.findFirst>>
>;

/** How long a claimed resolution blocks another (a crashed one then expires). */
const RESOLVING_STALE_MS = WORK_CLOCK.live;

function readGraph(proposal: ProposalRow):
  | {
      ok: true;
      data: Record<string, unknown>;
      record: ResolvableRecord;
      operations: LooseOp[];
    }
  | { ok: false; reason: NonNullable<ResolveOptionsResult["reason"]> } {
  const data = (proposal.data ?? {}) as Record<string, unknown>;
  const record = data.materialized;
  // Decided first: a graph whose last item was resolved no longer carries
  // the stopped-run fields, and must read "decided", not "not a graph".
  if (
    proposal.status !== ProposalStatus.APPROVAL_FAILED &&
    proposal.status !== ProposalStatus.PENDING
  ) {
    return { ok: false, reason: "already_decided" };
  }
  if (
    !isStoppedRecord(record) ||
    proposal.status !== ProposalStatus.APPROVAL_FAILED
  ) {
    return { ok: false, reason: "not_a_stopped_graph" };
  }
  const operations = Array.isArray(data.operations)
    ? (data.operations as LooseOp[])
    : [];
  // The record's indexes name the ops the run was given; they must be these.
  if (operations.length !== record.opCount) {
    return { ok: false, reason: "record_mismatch" };
  }
  return { ok: true, data, record, operations };
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function titleCase(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function valueTypeOf(v: unknown): string {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return "array";
  if (v && typeof v === "object") return "object";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
  return "string";
}

/** Where an entity op lands: its own pin, else the proposal's space. */
function landingOf(op: LooseOp, proposal: ProposalRow): string | null {
  return str(op.targetWorkspaceId) ?? proposal.workspaceId ?? null;
}

async function kindResolvesIn(
  slug: string,
  userId: string,
  workspaceId: string | null
) {
  const profile = await new ProfileResolutionService(db).resolveProfile(
    slug,
    userId,
    workspaceId
  );
  return profile && profile.profileKind !== "role" && profile.isActive
    ? profile
    : null;
}

async function workspaceName(id: string | null): Promise<string | undefined> {
  if (!id) return undefined;
  const [row] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return row?.name ?? undefined;
}

/** The kind options for an entity whose kind is not available where it lands. */
async function kindOptions(args: {
  proposal: ProposalRow;
  op: LooseOp;
  item: WaitingItem;
  record: ResolvableRecord;
  userId: string;
}): Promise<{ kindMissing: KindMissingDetail; options: ResolveOption[] }> {
  const { proposal, op, item, userId } = args;
  const slug = String(op.profileSlug ?? "");
  const landing = landingOf(op, proposal);
  const detail = await describeMissingKind({
    profileSlug: slug,
    userId,
    workspaceId: landing,
  });
  const kindName = detail.kindName ?? titleCase(slug);
  // Named only when the caller can read it (`describeMissingKind`'s floor).
  const here = detail.workspaceName;
  const options: ResolveOption[] = [];

  // The kind became available where it lands (its scope was widened since).
  const nowHere = await kindResolvesIn(slug, userId, landing);
  if (nowHere) {
    options.push({
      kind: "file_here_now",
      action: { type: "use_kind", profileSlug: slug },
      kindName: nowHere.displayName ?? kindName,
      recommended: true,
      available: true,
    });
  }

  // D3: where the kind lives, first (recommended: same kind, nothing new).
  // Only a space the caller may WRITE in: the record would be theirs there.
  for (const space of detail.foundIn) {
    if (!(await mayWriteIn(userId, space.workspaceId))) continue;
    options.push({
      kind: "file_in_workspace",
      action: { type: "file_in_workspace", workspaceId: space.workspaceId },
      workspaceName: space.name,
      kindName,
      recommended: !nowHere && options.length === 0,
      available: true,
    });
  }

  // Then: make the kind available here (a scope change, reviewed).
  const from = detail.foundIn[0];
  if (
    from &&
    landing &&
    here &&
    !nowHere &&
    (await validateWorkspaceAccess(userId, [landing])).length > 0
  ) {
    const [kind] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(
          eq(profiles.slug, slug),
          eq(profiles.workspaceId, from.workspaceId),
          eq(profiles.isActive, true),
          ne(profiles.origin, PROFILE_ORIGIN_PROBE)
        )
      )
      .limit(1);
    if (kind) {
      const waitingReview =
        (await pendingWidenReview(args.record, item.key)) !== null;
      options.push({
        kind: "widen_kind_scope",
        action: { type: "widen_kind_scope", profileId: kind.id },
        kindName,
        fromWorkspaceName: from.name,
        intoWorkspaceName: here,
        recommended: false,
        available: !waitingReview,
        ...(waitingReview ? { unavailableReason: "review_pending" } : {}),
      });
    }
  }

  // Then: another kind available here, ranked without a model.
  const propertyKeys = Object.keys(
    (op.properties as Record<string, unknown> | undefined) ?? {}
  );
  const accessible = (
    await new ProfileResolutionService(db).getAccessibleProfiles(
      userId,
      landing
    )
  ).filter(
    (p) =>
      p.profileKind !== "role" &&
      p.isActive &&
      p.origin !== PROFILE_ORIGIN_PROBE &&
      p.slug !== slug
  );
  const fieldRows =
    accessible.length === 0
      ? []
      : await db
          .select({
            profileId: profileProperties.profileId,
            slug: propertyDefs.slug,
          })
          .from(profileProperties)
          .innerJoin(
            propertyDefs,
            eq(propertyDefs.id, profileProperties.propertyDefId)
          )
          .where(
            inArray(
              profileProperties.profileId,
              accessible.map((p) => p.id)
            )
          );
  const fieldsOf = new Map<string, string[]>();
  for (const r of fieldRows) {
    fieldsOf.set(r.profileId, [...(fieldsOf.get(r.profileId) ?? []), r.slug]);
  }
  // The missing kind's own vocabulary, from where it lives (if readable).
  const [elsewhere] = from
    ? await db
        .select({
          synonyms: profiles.synonyms,
          semanticSlug: profiles.semanticSlug,
        })
        .from(profiles)
        .where(
          and(
            eq(profiles.slug, slug),
            eq(profiles.workspaceId, from.workspaceId),
            eq(profiles.isActive, true)
          )
        )
        .limit(1)
    : [];
  const suggestions = rankKindSuggestions({
    missing: {
      slug,
      kindName,
      synonyms: elsewhere?.synonyms ?? null,
      semanticSlug: elsewhere?.semanticSlug ?? null,
    },
    item: { title: str(op.title), propertyKeys },
    candidates: accessible.map((p) => ({
      slug: p.slug,
      displayName: p.displayName,
      plural: p.plural,
      synonyms: p.synonyms,
      semanticSlug: p.semanticSlug,
      fieldSlugs: fieldsOf.get(p.id) ?? [],
    })),
  });
  for (const s of suggestions) {
    options.push({
      kind: "use_kind",
      action: { type: "use_kind", profileSlug: s.slug },
      kindName: s.displayName,
      signals: s.signals,
      recommended: false,
      available: true,
    });
  }

  options.push({
    kind: "create_kind",
    action: { type: "create_kind" },
    draft: {
      slug,
      displayName: kindName,
      fields: propertyKeys.map((k) => ({
        slug: slugifyPropertyKey(k) || k,
        valueType: valueTypeOf(
          (op.properties as Record<string, unknown> | undefined)?.[k]
        ),
      })),
    },
    ...(here ? { intoWorkspaceName: here } : {}),
    recommended: false,
    available: false,
    unavailableReason: "not_yet",
  });
  options.push(skipOption(options.length === 0));
  return { kindMissing: detail, options };
}

const skipOption = (recommended = false): ResolveOption => ({
  kind: "skip",
  action: { type: "skip" },
  recommended,
  available: true,
});

/**
 * Every waiting item of a stopped graph, with its ranked choices. The caller's
 * authority to approve the proposal is checked by the door before this.
 */
export async function describeResolveOptions(
  proposal: ProposalRow,
  userId: string
): Promise<ResolveOptionsResult> {
  const graph = readGraph(proposal);
  if (!graph.ok) return { resolvable: false, reason: graph.reason, items: [] };
  const { record, operations } = graph;
  const waiting = waitingItems(record);
  if (waiting.length === 0) {
    return {
      resolvable: false,
      reason: "nothing_waiting",
      opCount: record.opCount,
      items: [],
    };
  }
  const handles = entityHandles(operations);
  const waitingIdx = new Set(waiting.map((w) => w.opIndex));

  const items: ResolveItemView[] = [];
  for (const item of waiting) {
    const op = operations[item.opIndex]!;
    const dependents = waiting
      .filter(
        (w) =>
          w.opIndex !== item.opIndex &&
          waitingIdx.has(w.opIndex) &&
          relationEnds(operations[w.opIndex]!, handles).includes(item.opIndex)
      )
      .map((w) => w.key);
    const base = {
      itemRef: item.key,
      opIndex: item.opIndex,
      op: item.op,
      ...(item.title ? { title: item.title } : {}),
      state: item.state,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.errorClass ? { errorClass: item.errorClass } : {}),
      ...(item.reviewProposalId
        ? { reviewProposalId: item.reviewProposalId }
        : {}),
      dependents,
    };
    const kindWaits =
      op.op === "create_entity" &&
      ((item.state === "failed" && item.errorClass === "kind_missing") ||
        item.state === "held");
    if (kindWaits) {
      const { kindMissing, options } = await kindOptions({
        proposal,
        op,
        item,
        record,
        userId,
      });
      items.push({ ...base, kindMissing, options });
    } else if (op.op === "create_entity" && item.state === "failed") {
      items.push({
        ...base,
        options: [
          {
            kind: "retry",
            action: { type: "use_kind", profileSlug: String(op.profileSlug) },
            recommended: true,
            available: true,
          },
          skipOption(),
        ],
      });
    } else if (op.op === "create_entity" && !record.failedOp) {
      // The run stopped between two steps: nothing failed, so a record it
      // never reached is filed as proposed (and the rest resumes with it).
      items.push({
        ...base,
        options: [
          {
            kind: "file_as_proposed",
            action: { type: "use_kind", profileSlug: String(op.profileSlug) },
            recommended: true,
            available: true,
          },
          skipOption(),
        ],
      });
    } else {
      items.push({ ...base, options: [skipOption()] });
    }
  }
  return { resolvable: true, opCount: record.opCount, items };
}


/** May the caller write records in this space (editor+, or its owner)? */
async function mayWriteIn(userId: string, workspaceId: string): Promise<boolean> {
  try {
    await assertWorkspaceWrite(db, userId, { workspaceId });
    return true;
  } catch {
    return false;
  }
}

/** Review statuses after which a scope change may be asked for again. */
const REVIEW_CLOSED = new Set<string>([
  ProposalStatus.REJECTED,
  ProposalStatus.WITHDRAWN,
  ProposalStatus.EXPIRED,
  ProposalStatus.REVERTED,
  ProposalStatus.APPROVAL_FAILED,
]);

/**
 * The scope-change review a held item still waits on, re-read from the row:
 * null when there is none, or it was refused / withdrawn / expired (the
 * choice is then available again), or it was approved (the kind is here).
 */
async function pendingWidenReview(
  record: ResolvableRecord,
  key: string
): Promise<string | null> {
  const r = record.resolutions?.[key];
  if (
    r?.outcome !== "held" ||
    r.action !== "widen_kind_scope" ||
    !r.reviewProposalId
  ) {
    return null;
  }
  const review = await db.query.proposals.findFirst({
    where: eq(proposals.id, r.reviewProposalId),
    columns: { status: true },
  });
  if (!review || REVIEW_CLOSED.has(review.status)) return null;
  if (review.status === ProposalStatus.APPROVED) return null;
  return r.reviewProposalId;
}

export interface ResolveItemResult {
  /** Nothing waits any more: the proposal now reads approved. */
  complete: boolean;
  status: "approved" | "approval_failed";
  /** failed: the resumed run stopped on this same item again. */
  outcome: ItemResolution["outcome"] | "failed";
  /** Records and links this resolution filed (created or linked). */
  filed: number;
  /** Items still waiting after it. */
  waiting: number;
  /** The review the item now waits on (a kind scope change). */
  reviewProposalId?: string;
  /** A later item the resumed run stopped on. */
  stoppedOn?: { itemRef: string; reason: string };
}

function bad(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** The key a reviewer's disposition uses for an op (`applyGraphDispositions`). */
function dispositionRefs(operations: readonly LooseOp[]): string[] {
  let relation = 0;
  return operations.map((op, i) => {
    if (op.op === "create_relation") return `$rel${relation++}`;
    return typeof op.ref === "string" && op.ref ? op.ref : `$op${i}`;
  });
}

/** A reviewer's earlier per-item decisions (`data.dispositions`), by op index. */
function readDispositions(
  data: Record<string, unknown>,
  operations: readonly LooseOp[]
): { rejected: Set<number>; edits: Map<number, Record<string, unknown>> } {
  const map = (data.dispositions ?? {}) as Record<
    string,
    ProposalItemDisposition | undefined
  >;
  const rejected = new Set<number>();
  const edits = new Map<number, Record<string, unknown>>();
  dispositionRefs(operations).forEach((ref, i) => {
    const d = map[ref];
    if (d?.status === "reject") rejected.add(i);
    else if (
      d?.status === "edit" &&
      d.edits &&
      operations[i]?.op === "create_entity"
    ) {
      edits.set(i, d.edits);
    }
  });
  return { rejected, edits };
}

/** The ctx the resume's entity and relation doors run under, or a refusal. */
async function compositeCtxFor(proposal: ProposalRow, userId: string) {
  let workspaceRole = "owner";
  if (proposal.workspaceId) {
    const membership = await getWorkspaceMembership(
      db,
      proposal.workspaceId,
      userId
    );
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No workspace access",
      });
    }
    workspaceRole = membership.role;
  }
  return {
    db,
    authenticated: true as const,
    userId,
    workspaceId: proposal.workspaceId ?? null,
    workspaceRole,
    sessionId: proposal.sessionId ?? null,
    governanceProposalId: proposal.id,
    agentUserId: proposal.agentUserId ?? null,
  };
}

/**
 * Apply one choice to one waiting item and resume what never ran. The door
 * has checked the caller's authority to approve this proposal.
 */
export async function resolveProposalItem(args: {
  proposal: ProposalRow;
  userId: string;
  itemRef: string;
  action: ResolveActionInput;
}): Promise<ResolveItemResult> {
  const { proposal, userId, itemRef, action } = args;
  const graph = readGraph(proposal);
  if (!graph.ok) {
    throw new TRPCError({
      code: graph.reason === "already_decided" ? "CONFLICT" : "BAD_REQUEST",
      message:
        graph.reason === "already_decided"
          ? "This proposal was already decided, so there is nothing to resolve."
          : "Only a graph that stopped part-way has items to resolve.",
    });
  }
  const { data, record, operations } = graph;
  const item = waitingItems(record).find((w) => w.key === itemRef);
  if (!item) {
    bad(
      "That item is not waiting: it was filed, skipped or never part of this graph."
    );
  }
  const op = operations[item.opIndex]!;
  const slug = String(op.profileSlug ?? "");
  const landing = landingOf(op, proposal);
  if (action.type !== "skip" && op.op !== "create_entity") {
    bad("Only a record can be filed another way. A link can only be skipped.");
  }
  if (action.type === "create_kind") {
    bad(
      "Creating a new kind from here is not available yet. File it where the kind lives, as another kind, or skip it."
    );
  }

  // Every check that can refuse runs BEFORE anything is claimed or written,
  // so a refusal never leaves a scope change (or a claim) behind.
  let disposition: ItemDisposition;
  let widen: { profileId: string; home: string } | undefined;
  if (action.type === "skip") {
    disposition = { kind: "skip" };
  } else if (action.type === "file_in_workspace") {
    if (!(await mayWriteIn(userId, action.workspaceId))) {
      bad("You can't file records into that space.");
    }
    if (!(await kindResolvesIn(slug, userId, action.workspaceId))) {
      const [readable] = await validateWorkspaceAccess(userId, [
        action.workspaceId,
      ]);
      const name =
        (readable ? await workspaceName(readable) : undefined) ?? "that space";
      bad(`The kind "${slug}" isn't available in ${name} either.`);
    }
    disposition = { kind: "file", targetWorkspaceId: action.workspaceId };
  } else if (action.type === "use_kind") {
    const kind = await kindResolvesIn(action.profileSlug, userId, landing);
    if (!kind) {
      bad(`The kind "${action.profileSlug}" isn't available where this item lands.`);
    }
    disposition =
      kind.slug === slug
        ? { kind: "file" }
        : { kind: "file", profileSlug: kind.slug };
  } else {
    // widen_kind_scope: the item's own kind, in a space the caller can read,
    // into a space the caller can read, and no review of it already open.
    const [kind] = await db
      .select({
        id: profiles.id,
        slug: profiles.slug,
        workspaceId: profiles.workspaceId,
      })
      .from(profiles)
      .where(eq(profiles.id, action.profileId))
      .limit(1);
    const readable = await validateWorkspaceAccess(
      userId,
      [kind?.workspaceId, landing].filter((w): w is string => !!w)
    );
    if (
      !kind?.workspaceId ||
      kind.slug !== slug ||
      !landing ||
      !readable.includes(kind.workspaceId) ||
      !readable.includes(landing)
    ) {
      bad("That kind can't be made available for this item.");
    }
    if (await pendingWidenReview(record, item.key)) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Making this kind available here already waits for a review. File it once that review is approved, or choose another way.",
      });
    }
    widen = { profileId: kind.id, home: kind.workspaceId };
    disposition = { kind: "file" };
  }

  // The plan (as a file, for a widen) and the doors' ctx, checked up front.
  const planned = checkedPlan({ data, record, operations, item, disposition });
  if (planned.run.length >= BACKGROUND_APPROVAL_MIN_OPERATIONS) {
    bad(
      `Resolving this item would file ${planned.run.length} steps at once, more than can be filed here. Ask the AI to file the rest again.`
    );
  }
  const compositeCtx = await compositeCtxFor(proposal, userId);

  const claim = await claimResolution(proposal, data, record, itemRef, userId);
  let ran = false;
  try {
    if (widen) {
      const { changeKindScope } =
        await import("../profiles/change-kind-scope.js");
      const outcome = await changeKindScope(
        { userId, scopes: [], agentUserId: null, sessionId: null },
        {
          profileId: widen.profileId,
          scope: "shared",
          allowedWorkspaceIds: [landing!],
          workspaceId: widen.home,
          reasoning: `So "${item.title ?? slug}" can be filed where it was captured.`,
        }
      );
      if (outcome.status === "proposed") {
        disposition = { kind: "hold", reviewProposalId: outcome.proposalId };
      } else if (!(await kindResolvesIn(slug, userId, landing))) {
        bad(
          "The kind's scope changed, but it still isn't available where this item lands."
        );
      }
    }
    return await runResolution({
      proposal,
      data,
      record,
      operations,
      item,
      userId,
      action,
      disposition,
      claim,
      compositeCtx,
      onRunStart: () => {
        ran = true;
      },
    });
  } catch (err) {
    // A run that filed rows keeps its claim, marked unfinished: only its
    // person may finish it (their keys link what it filed). Otherwise the
    // claim is simply dropped.
    if (ran) await markUnfinished(proposal.id, claim);
    else await releaseClaim(proposal.id, claim);
    throw err;
  }
}

function checkedPlan(args: {
  data: Record<string, unknown>;
  record: ResolvableRecord;
  operations: LooseOp[];
  item: WaitingItem;
  disposition: ItemDisposition;
}) {
  const { rejected } = readDispositions(args.data, args.operations);
  try {
    return planResolveRun({
      operations: args.operations,
      record: args.record,
      itemKey: args.item.key,
      disposition: args.disposition,
      rejected,
    });
  } catch (err) {
    if (err instanceof ResolvePlanError) bad(err.message);
    throw err;
  }
}

interface Claim {
  token: string;
  by: string;
}

/** The predicate "this run still owns the claim". */
const ownsClaim = (claim: Claim) =>
  drizzleSql`${proposals.data}->'materialized'->'resolving'->>'token' = ${claim.token}`;

/**
 * Claim the resolution on the row (compare-and-set on `updated_at`), so two
 * presses never resume the same items at once. A live claim refuses; a claim
 * whose heartbeat stopped for {@link RESOLVING_STALE_MS}, or that is marked
 * unfinished, may be taken over only by the person who made it — their
 * per-item keys link what it filed (`approval-runs` `assertMayResume`: the
 * lookup that dedups is floored on the person, so anyone else would file it
 * all again).
 */
async function claimResolution(
  proposal: ProposalRow,
  data: Record<string, unknown>,
  record: ResolvableRecord,
  key: string,
  userId: string
): Promise<Claim> {
  const prior = record.resolving;
  if (prior) {
    const live =
      !prior.unfinished &&
      Date.now() - Date.parse(prior.at) < RESOLVING_STALE_MS;
    if (live) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "An item of this graph is being resolved right now. Reload in a moment.",
      });
    }
    if (prior.by !== userId) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Part of this graph was being filed by the person who started it. Only they can finish it without creating duplicates.",
      });
    }
  }
  const claim: Claim = { token: randomUUID(), by: userId };
  const claimed = await db
    .update(proposals)
    .set({
      data: {
        ...data,
        materialized: {
          ...record,
          resolving: {
            key,
            by: userId,
            token: claim.token,
            at: new Date().toISOString(),
          },
        },
      } as never,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposals.id, proposal.id),
        eq(proposals.status, ProposalStatus.APPROVAL_FAILED),
        proposalUnchangedSince(proposal.updatedAt)
      )
    )
    .returning({ id: proposals.id });
  if (claimed.length === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This proposal changed since you opened it. Reload it.",
    });
  }
  return claim;
}

/** Renew the claim's heartbeat; false when another run took it over. */
async function heartbeat(proposalId: string, claim: Claim): Promise<boolean> {
  const renewed = await db
    .update(proposals)
    .set({
      data: drizzleSql`jsonb_set(${proposals.data}, '{materialized,resolving,at}', to_jsonb(${new Date().toISOString()}::text))`,
    })
    .where(and(eq(proposals.id, proposalId), ownsClaim(claim)))
    .returning({ id: proposals.id });
  return renewed.length > 0;
}

/** Best-effort: drop a claim this run owns, after it failed before filing. */
async function releaseClaim(proposalId: string, claim: Claim): Promise<void> {
  try {
    await db
      .update(proposals)
      .set({
        data: drizzleSql`${proposals.data} #- '{materialized,resolving}'`,
      })
      .where(and(eq(proposals.id, proposalId), ownsClaim(claim)));
  } catch (err) {
    logger.warn(
      { err, proposalId },
      "resolveItem: the claim could not be released (it expires on its own)"
    );
  }
}

/** Best-effort: mark a claim this run owns as filed-but-not-stamped. */
async function markUnfinished(proposalId: string, claim: Claim): Promise<void> {
  try {
    await db
      .update(proposals)
      .set({
        data: drizzleSql`jsonb_set(${proposals.data}, '{materialized,resolving,unfinished}', 'true'::jsonb)`,
      })
      .where(and(eq(proposals.id, proposalId), ownsClaim(claim)));
  } catch (err) {
    logger.warn(
      { err, proposalId },
      "resolveItem: the claim could not be marked unfinished"
    );
  }
}

class LostClaimError extends Error {
  constructor() {
    super("Another resolution of this graph took over; this one stopped.");
    this.name = "LostClaimError";
  }
}

async function runResolution(args: {
  proposal: ProposalRow;
  data: Record<string, unknown>;
  record: ResolvableRecord;
  operations: LooseOp[];
  item: WaitingItem;
  userId: string;
  action: ResolveActionInput;
  disposition: ItemDisposition;
  claim: Claim;
  compositeCtx: Awaited<ReturnType<typeof compositeCtxFor>>;
  onRunStart: () => void;
}): Promise<ResolveItemResult> {
  const { proposal, data, record, operations, item, userId, disposition } =
    args;
  const plan = checkedPlan({ data, record, operations, item, disposition });
  const { edits } = readDispositions(data, operations);
  const resume = buildResumeOps({
    operations,
    run: plan.run,
    landed: landedEntityIds(operations, record),
    edits,
    ...(plan.overrides
      ? { overrides: new Map([[item.opIndex, plan.overrides]]) }
      : {}),
  });

  let runRecord: CompleteMaterializedRecord | null = null;
  let stopped = false;
  let failure:
    | {
        meta: ReturnType<typeof classifyThrownFailure>;
        sentence: string;
        raw: string;
      }
    | undefined;
  if (resume.operations.length > 0) {
    // Filed exactly as approving would have: knowledge properties completed
    // and reconciled against the kind's fields.
    const operationsToRun = await reconcileCompositeEntityOps(
      resume.operations,
      { userId, workspaceId: proposal.workspaceId ?? null }
    );
    args.onRunStart();
    const result = await materializeResume({
      proposal,
      data,
      userId,
      operations: operationsToRun,
      resume,
      claim: args.claim,
      compositeCtx: args.compositeCtx,
    });
    if (!result.ok && result.error instanceof LostClaimError) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Another resolution of this graph took over while this one ran. Reload it.",
      });
    }
    if (result.ok) {
      runRecord = remapRunRecord(
        buildStoppedRunRecord(
          {
            operations: operationsToRun,
            result: result.result,
            failedOpIndex: -1,
          },
          { reason: "", errorClass: "unknown" }
        ),
        resume
      );
    } else {
      const partial = readPartialMaterialization(result.error);
      const meta = classifyThrownFailure(result.error);
      const sentence = safeFailureSentence(result.error, meta);
      failure = {
        meta,
        sentence,
        raw:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
      };
      stopped = true;
      if (partial) {
        runRecord = remapRunRecord(
          buildStoppedRunRecord(partial, {
            reason: sentence,
            errorClass: meta.errorClass ?? "unknown",
          }),
          resume
        );
      } else {
        // Thrown before any op ran: everything that was to run still waits.
        runRecord = {
          notRun: resume.originalIndex
            .slice(1)
            .map((i) => opRefAt(operations, i)),
          failedOp: {
            ...opRefAt(operations, resume.originalIndex[0]!),
            reason: sentence,
            errorClass: meta.errorClass ?? "unknown",
          },
        };
      }
    }
  }

  const outcome: ItemResolution["outcome"] =
    disposition.kind === "skip"
      ? "skipped"
      : disposition.kind === "hold"
        ? "held"
        : "filed";
  const now = new Date();
  // The resume stopped on the item itself (its new kind refused it, say): it
  // still waits, failed, and no resolution is recorded as if it had applied.
  const itemStillFailed =
    stopped && runRecord?.failedOp?.opIndex === item.opIndex;
  const { record: next, complete } = composeResolvedRecord({
    older: record,
    run: runRecord,
    stopped,
    operations,
    plan,
    resolution: itemStillFailed
      ? null
      : {
          key: item.key,
          value: {
            action: args.action.type,
            outcome,
            by: userId,
            at: now.toISOString(),
            ...(plan.overrides?.targetWorkspaceId
              ? { workspaceId: plan.overrides.targetWorkspaceId }
              : {}),
            ...(plan.overrides?.profileSlug
              ? { profileSlug: plan.overrides.profileSlug }
              : {}),
            ...(disposition.kind === "hold"
              ? { reviewProposalId: disposition.reviewProposalId }
              : {}),
          },
        },
    stampedAt: now.toISOString(),
  });

  const {
    failure: _oldFailure,
    materializationError: _oldError,
    ...rest
  } = data;
  const waiting = (next.notRun?.length ?? 0) + (next.failedOp ? 1 : 0);
  // A hold that left no failure behind: the old failure is no longer true.
  const heldOnly = !complete && !failure && !next.failedOp;
  const nextData: Record<string, unknown> = complete || heldOnly
    ? { ...rest, materialized: next }
    : failure
      ? {
          ...data,
          materialized: next,
          materializationError: redactForStorage(failure.raw),
          failure: failureRecord(failure.meta),
        }
      : { ...data, materialized: next };

  const written = await transitionProposal(db, {
    to: complete ? ProposalStatus.APPROVED : ProposalStatus.APPROVAL_FAILED,
    from: [ProposalStatus.APPROVAL_FAILED],
    set: {
      data: nextData as never,
      updatedAt: now,
      ...(complete
        ? { rejectionReason: null, reviewedBy: userId, reviewedAt: now }
        : failure
          ? { rejectionReason: failure.sentence }
          : heldOnly
            ? {
                rejectionReason: `${waiting === 1 ? "1 item waits" : `${waiting} items wait`} for a review before ${waiting === 1 ? "it" : "they"} can be filed.`,
              }
            : {}),
    },
    // Only the run that owns the claim may stamp what it did.
    where: and(eq(proposals.id, proposal.id), ownsClaim(args.claim)),
  }).returning({ id: proposals.id });
  if (written.length === 0) {
    logger.error(
      { proposalId: proposal.id, item: item.key },
      "resolveItem: the resume ran but the proposal moved (or its claim was taken) meanwhile — its record was not updated"
    );
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "The item was handled, but this proposal changed meanwhile. Reload it.",
    });
  }

  await afterResolved({
    proposal,
    data,
    operations,
    userId,
    created: runRecord?.entityIds ?? [],
    complete,
    record: next,
  });

  const filedCount = Object.keys(runRecord?.byOp ?? {}).length;
  return {
    complete,
    status: complete ? "approved" : "approval_failed",
    outcome: itemStillFailed ? "failed" : outcome,
    filed: filedCount,
    waiting,
    ...(disposition.kind === "hold"
      ? { reviewProposalId: disposition.reviewProposalId }
      : {}),
    ...(next.failedOp && failure
      ? { stoppedOn: { itemRef: next.failedOp.key, reason: failure.sentence } }
      : {}),
  };
}

/**
 * The approval tail, shared with the composite approval (apply-approval.ts):
 * on every resume the entities it created get their `produced` links and
 * project membership; once nothing waits, the graph's channel bindings and
 * the approved signals (bell, waiting agents, wait-holds, automations, the
 * IS outcome, a pod-wide connection sync). After the stamp landed, so a
 * failure here is logged, never reported as a failed resolution.
 */
async function afterResolved(args: {
  proposal: ProposalRow;
  data: Record<string, unknown>;
  operations: LooseOp[];
  userId: string;
  created: string[];
  complete: boolean;
  record: ResolvableRecord;
}): Promise<void> {
  const { proposal, userId } = args;
  try {
    await recordProducedEntities(proposal, args.created, userId);
    if (!args.complete) return;
    const ids = landedEntityIds(args.operations, args.record);
    const refToRealId: Record<string, string> = {};
    args.operations.forEach((op, i) => {
      const id = ids.get(i);
      if (!id) return;
      refToRealId[`$op${i}`] = id;
      if (typeof op.ref === "string" && op.ref) refToRealId[op.ref] = id;
    });
    await bindGraphChannels(args.data, refToRealId, proposal, userId);
    await announceCompositeApproved(proposal, userId);
  } catch (err) {
    logger.error(
      { err, proposalId: proposal.id },
      "resolveItem: resolved, but a follow-up of the approval failed"
    );
  }
}

/**
 * Run the resumed ops through the SAME composite materializer and doors the
 * approval uses, as the resolving person, with the proposal as the authority
 * its rows carry (`governanceProposalId`) and its agent as their actor, and
 * the approval's duplicate rules: a same-name record nobody reviewed refuses
 * (it is never filed silently). Keyed per proposal + item
 * (`<proposal>:resolve:@item<i>`), so a retry links what an earlier attempt
 * filed. The claim's heartbeat is renewed as each op settles; a run whose
 * claim was taken over stops at once.
 */
async function materializeResume(args: {
  proposal: ProposalRow;
  data: Record<string, unknown>;
  userId: string;
  operations: CompositeProposalOperation[];
  resume: ReturnType<typeof buildResumeOps>;
  claim: Claim;
  compositeCtx: Awaited<ReturnType<typeof compositeCtxFor>>;
}): Promise<
  { ok: true; result: MaterializeResult } | { ok: false; error: unknown }
> {
  const { proposal, data, userId, compositeCtx } = args;
  const { entitiesRouter } = await import("../../routers/entities.js");
  const { relationsRouter } = await import("../../routers/relations.js");
  const entityCaller = entitiesRouter.createCaller(
    compositeCtx as unknown as Parameters<typeof entitiesRouter.createCaller>[0]
  );
  const relationCaller = relationsRouter.createCaller(
    compositeCtx as unknown as Parameters<
      typeof relationsRouter.createCaller
    >[0]
  );
  // The disposition ref of each resumed entity (`op.ref ?? $op<i>` of the
  // ORIGINAL op): the key the card's twins and identity choices use.
  const refs = dispositionRefs(
    (data.operations as LooseOp[] | undefined) ?? []
  );
  const dispositionRefOf = new Map<string, string>();
  args.resume.originalIndex.forEach((orig, sub) => {
    const r = args.resume.operations[sub] as { ref?: unknown };
    if (typeof r.ref === "string") dispositionRefOf.set(r.ref, refs[orig]!);
  });
  try {
    const result = await materializeCompositeGraph(
      args.operations,
      entityCaller,
      relationCaller,
      (err, type) =>
        logger.warn(
          { err, type, proposalId: proposal.id },
          "resolveItem: relation create failed (entities kept)"
        ),
      {
        facetCaller: entityCaller,
        // Wired like every materialize call site (tripwire
        // rule-loop-callers-wired-at-every-materialize), although a resume
        // only ever carries entity and relation ops (`planResolveRun`
        // refuses anything else), so these are never reached today.
        ...buildRuleLoopCallers({
          database: db,
          userId,
          workspaceId: proposal.workspaceId ?? null,
          auditSource: "rule_loop_resolve_item",
          skillAuthor: {
            agentUserId: proposal.agentUserId ?? null,
            personApproved: true,
          },
        }),
        source: normalizeProposalSource(
          typeof data.source === "string" ? data.source : "system"
        ),
        idempotency: makeExternalLinkIdempotency(db, {
          namespace: `${proposal.id}:resolve`,
          provider: approvalIdempotencyProvider(proposal.proposalType),
          userId,
          sourceProposalId: proposal.id,
        }),
        askReviewerOnDuplicate: true,
        reviewedTwinIdsByRef: twinsShownOnCard(data).byRef,
        ...withProposedIdentityResolutions(
          data.proposedIdentityResolutionByRef,
          undefined
        ),
        entityRef: (op) =>
          (typeof op.ref === "string" && dispositionRefOf.get(op.ref)) ||
          op.ref ||
          "",
        onProgress: async () => {
          if (!(await heartbeat(proposal.id, args.claim))) {
            throw new LostClaimError();
          }
        },
      }
    );
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}
