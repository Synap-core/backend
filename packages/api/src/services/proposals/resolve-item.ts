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
import {
  and,
  db,
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
  const here = detail.workspaceName ?? (await workspaceName(landing));
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
  for (const space of detail.foundIn) {
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
  if (from && landing && here && !nowHere) {
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
      const pending = args.record.resolutions?.[item.key];
      const waitingReview =
        pending?.outcome === "held" && pending.action === "widen_kind_scope";
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
    } else {
      items.push({ ...base, options: [skipOption()] });
    }
  }
  return { resolvable: true, opCount: record.opCount, items };
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
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Creating a new kind from here is not available yet. File it where the kind lives, as another kind, or skip it.",
    });
  }

  // Check the choice BEFORE anything is claimed or written.
  let disposition: ItemDisposition | undefined;
  let widen: { profileId: string; home: string } | undefined;
  if (action.type === "skip") {
    disposition = { kind: "skip" };
  } else if (action.type === "file_in_workspace") {
    const [readable] = await validateWorkspaceAccess(userId, [
      action.workspaceId,
    ]);
    if (!readable) bad("You can't file into that space.");
    if (!(await kindResolvesIn(slug, userId, action.workspaceId))) {
      const name = (await workspaceName(action.workspaceId)) ?? "that space";
      bad(`The kind "${slug}" isn't available in ${name} either.`);
    }
    disposition = { kind: "file", targetWorkspaceId: action.workspaceId };
  } else if (action.type === "use_kind") {
    const kind = await kindResolvesIn(action.profileSlug, userId, landing);
    if (!kind) {
      const name = (await workspaceName(landing)) ?? "this space";
      bad(`The kind "${action.profileSlug}" isn't available in ${name}.`);
    }
    disposition =
      kind.slug === slug
        ? { kind: "file" }
        : { kind: "file", profileSlug: kind.slug };
  } else {
    // widen_kind_scope: the kind must be the item's own slug, in a space the
    // caller can read, and the item must land somewhere.
    const [kind] = await db
      .select({
        id: profiles.id,
        slug: profiles.slug,
        workspaceId: profiles.workspaceId,
      })
      .from(profiles)
      .where(eq(profiles.id, action.profileId))
      .limit(1);
    const readable = kind?.workspaceId
      ? await validateWorkspaceAccess(userId, [kind.workspaceId])
      : [];
    if (!kind || kind.slug !== slug || readable.length === 0) {
      bad("That kind can't be made available for this item.");
    }
    if (!landing) bad("This item has no space to make the kind available in.");
    widen = { profileId: kind.id, home: kind.workspaceId! };
  }

  // Check the plan BEFORE claiming (a widen's plan is known only after it).
  if (disposition) {
    try {
      planResolveRun({ operations, record, itemKey: itemRef, disposition });
    } catch (err) {
      if (err instanceof ResolvePlanError) bad(err.message);
      throw err;
    }
  }

  await claimResolution(proposal, data, record, itemRef, userId);
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
        disposition = {
          kind: "hold",
          reviewProposalId: outcome.proposalId,
        };
      } else if (await kindResolvesIn(slug, userId, landing)) {
        disposition = { kind: "file" };
      } else {
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
      disposition: disposition!,
    });
  } catch (err) {
    await releaseClaim(proposal.id, itemRef);
    throw err;
  }
}

/**
 * Claim the resolution on the row (compare-and-set on `updated_at`), so two
 * presses cannot resume the same items at once. A claim older than
 * {@link RESOLVING_STALE_MS} is a crashed one and does not block.
 */
async function claimResolution(
  proposal: ProposalRow,
  data: Record<string, unknown>,
  record: ResolvableRecord,
  key: string,
  userId: string
): Promise<void> {
  const busy =
    record.resolving &&
    Date.now() - Date.parse(record.resolving.at) < RESOLVING_STALE_MS;
  if (busy) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "An item of this graph is being resolved right now. Reload in a moment.",
    });
  }
  const claimed = await db
    .update(proposals)
    .set({
      data: {
        ...data,
        materialized: {
          ...record,
          resolving: { key, by: userId, at: new Date().toISOString() },
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
}

/** Best-effort: drop a claim this request made, after it failed. */
async function releaseClaim(proposalId: string, key: string): Promise<void> {
  try {
    const row = await db.query.proposals.findFirst({
      where: eq(proposals.id, proposalId),
      columns: { data: true },
    });
    const data = (row?.data ?? {}) as Record<string, unknown>;
    const m = data.materialized as ResolvableRecord | undefined;
    if (!m?.resolving || m.resolving.key !== key) return;
    const { resolving: _drop, ...rest } = m;
    await db
      .update(proposals)
      .set({ data: { ...data, materialized: rest } as never })
      .where(eq(proposals.id, proposalId));
  } catch (err) {
    logger.warn(
      { err, proposalId },
      "resolveItem: the claim could not be released (it expires on its own)"
    );
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
}): Promise<ResolveItemResult> {
  const { proposal, data, record, operations, item, userId, disposition } =
    args;
  let plan;
  try {
    plan = planResolveRun({
      operations,
      record,
      itemKey: item.key,
      disposition,
    });
  } catch (err) {
    if (err instanceof ResolvePlanError) bad(err.message);
    throw err;
  }

  const resume = buildResumeOps({
    operations,
    run: plan.run,
    landed: landedEntityIds(operations, record),
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
    const result = await materializeResume({
      proposal,
      data,
      userId,
      operations: resume.operations,
    });
    if (result.ok) {
      runRecord = remapRunRecord(
        buildStoppedRunRecord(
          {
            operations: resume.operations,
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
  const itemStillFailed = stopped && runRecord?.failedOp?.key === item.key;
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
  const nextData: Record<string, unknown> = complete
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
          : {}),
    },
    where: eq(proposals.id, proposal.id),
  }).returning({ id: proposals.id });
  if (written.length === 0) {
    logger.error(
      { proposalId: proposal.id, item: item.key },
      "resolveItem: the resume ran but the proposal moved meanwhile — its record was not updated"
    );
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "The item was handled, but this proposal changed meanwhile. Reload it.",
    });
  }

  const filedCount = Object.keys(runRecord?.byOp ?? {}).length;
  const waiting = (next.notRun?.length ?? 0) + (next.failedOp ? 1 : 0);
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
 * Run the resumed ops through the SAME composite materializer and doors the
 * approval uses, as the resolving person, with the proposal as the authority
 * its rows carry (`governanceProposalId`) and its agent as their actor.
 * Keyed per item (`<user>:<proposal>:resolve` + the item's run name), so a
 * second press links what the first created.
 */
async function materializeResume(args: {
  proposal: ProposalRow;
  data: Record<string, unknown>;
  userId: string;
  operations: CompositeProposalOperation[];
}): Promise<
  { ok: true; result: MaterializeResult } | { ok: false; error: unknown }
> {
  const { proposal, data, userId } = args;
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
  const compositeCtx = {
    db,
    authenticated: true as const,
    userId,
    workspaceId: proposal.workspaceId ?? null,
    workspaceRole,
    sessionId: proposal.sessionId ?? null,
    governanceProposalId: proposal.id,
    agentUserId: proposal.agentUserId ?? null,
  };
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
          namespace: `${userId}:${proposal.id}:resolve`,
          provider: approvalIdempotencyProvider(proposal.proposalType),
          userId,
          sourceProposalId: proposal.id,
        }),
      }
    );
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}
