"use client";

/**
 * The proposal REVIEW, shared by the `/proposal/[id]` receiver page and the
 * console's Review drawer: the same reads, the same marks, the same verbs —
 * one component, so the two can never disagree.
 *
 *   `useProposalReview`  — the proposal, where it came from, and its space.
 *   `ProposalReviewBody` — the Review template (page-grammar §1), top → down:
 *       who is asking, as ONE line of chips (agent · for whom · space ·
 *         session · when), each a door to its own page;
 *       what its session is FOR, under it — goal, criteria, track, project,
 *         and what else from it waits (`ProposalSessionContext.tsx`);
 *       the change first: the RECORD approving creates or changes (its name
 *         as the heading, its kind beside it, its fields in a grid —
 *         `proposal-record-model.ts`), a document's diff, an app's access
 *         lines; a possible twin under it, each a door ("Looks like");
 *       why, as ONE mark (the reason's short label, its sentence on press),
 *         then the requester's own note, labelled as theirs and clamped;
 *       the decision bar, pinned to the bottom, with who decides. A create
 *         with a record twin has no plain Approve: its verbs ARE the approve
 *         (Fill empty fields · Use existing · Overwrite · Keep both); a
 *         capture graph's Approve sends one choice per item. "Can't be undone"
 *         is the one consequence marked — undo is the default;
 *       Advanced (ids + raw request), collapsed, last.
 *
 * Its parts (marks, sections, the decision bar) are `app/_lib/review/`,
 * shared with the key request review (`/keys/requests/[id]`).
 *
 * This file owns provenance and the ONE "Advanced". Hosts draw only their
 * frame: the page its card header, the drawer its title. Before 2026-10-23
 * the drawer drew its own "who / when / where" rows AND embedded the decision,
 * which drew a second provenance box and a second "Advanced" — provenance
 * three times, Advanced twice, in one panel.
 *
 * Founder dogfood of v1 (2026-10-23, proposal "Create Léa Dogfoodprobe"): the
 * change was one narrow column of chipped values with `ResolvedWorkspaceId`
 * among them; "Always asks a person" and "Can be undone" each came with a
 * paragraph; the agent's words sat unlabelled; and the twin the pod had found
 * was never shown — the plain Approve kept both without asking.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  AppWindow,
  Clock,
  Layers,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import {
  deriveDuplicateReview,
  identityResolutionByRefFor,
  needsIdentityChoice,
  pageOnlyReasonActs,
  proposalPageOnlyReason,
  resolveProposalAction,
  type DuplicateItemChoice,
  type ProposalDuplicateReview,
  type ProposalReviewGraph,
  type ProposalTurnsOn,
} from "@synap-core/types/proposals";
import {
  resolveObjectNoun,
  resolveProvenanceLabel,
} from "@synap-core/types/vocabulary";
import { openIn, type Exit } from "../../../lib/open-in";
import { ExitFallback } from "../../../lib/exit-link";
/* The pod's own uuid predicate, not a fourth regex. `workspaceId` is a TEXT
   column while `workspaces.get` takes `.uuid()` — without this guard a
   non-uuid workspace ref would fire a request that can only fail. */
import { formatRelative, formatTimestamp, isUuid } from "../../../lib/format";
import { trpc } from "../../../lib/trpc";
import { proposalExpiresAt, proposalLapsed } from "../../_lib/proposal-expiry";
import { mediaAlt } from "../../_lib/media/stored-media-model";
import { AdvancedPanel } from "../../_lib/object/advanced-panel";
import {
  DisclosedMark,
  Outcome,
  RequesterNote,
  ReviewProvenance,
  ReviewSection,
} from "../../_lib/review/review-parts";
import {
  APPROVE_LABEL,
  ApproveButton,
  DecisionBar,
  RejectButton,
  RejectConfirm,
  WhoDecides,
} from "../../_lib/review/decision-bar";
import { kindIcon } from "../../_lib/object/kind-icon";
import {
  AgentMark,
  PersonAvatar,
  Pill,
} from "../../_lib/object/provenance-chips";
import { deriveDeferredWritesReview } from "@synap-core/types/proposals/deferred-writes";
import { DocumentChanges } from "../../_lib/object/content/document-changes";
import { documentChanges } from "../../_lib/object/content/document-changes-model";
import { AlwaysApproveMenu } from "./AlwaysApproveMenu";
import { DeferredWritesList } from "./DeferredWritesList";
import {
  DuplicateUnchecked,
  ItemTwinChoice,
  TwinDoors,
  TwinVerbs,
} from "./DuplicateChoice";
import {
  PartEdgeList,
  ProposedRecordCard,
  RecordGroupList,
} from "./ProposedRecordCard";
import { ProposalSessionContext } from "./ProposalSessionContext";
import {
  compositeItems,
  turnOnRecords,
  type GraphItemKey,
} from "./composite-parts-model";
import { recordGroups } from "./record-groups";
import { proposalHeading } from "./proposal-heading";
import { proposalProfileSlug } from "./proposal-subject-kind";
import { proposalRequesterParts } from "./proposal-requester";
import {
  graphRecords,
  proposedEntityMedia,
  proposedRecord,
  type ProposedRecord,
  type ResolvedRef,
} from "./proposal-record-model";
import {
  reasonMark,
  undoMark,
  type ProposalChangeInput,
  type ReviewMark,
} from "./proposal-review-model";
import { proposalWhy } from "./proposal-why";
import {
  ApprovalProgressLines,
  showApprovalProgressToast,
  useApprovalProgress,
} from "../../_lib/approval-progress/approval-progress-toast";
import {
  approvalProgressCopy,
  isApplying,
  progressUnavailable,
  type ApprovalRun,
} from "../../_lib/approval-progress/approval-progress-model";
import {
  renderedRevision,
  useProposalDecision,
  type ApproveChoice,
} from "./use-proposal-decision";
import { useRecordDefinitions } from "./use-record-definitions";

/**
 * `pending` and `approval_failed` are the two states a reviewer can still decide;
 * everything else is terminal (already approved / rejected / reverted / withdrawn).
 */
export function isActionable(status: string): boolean {
  return status === "pending" || status === "approval_failed";
}

/**
 * The status the review draws: a pending proposal whose moment passed is
 * Expired — history, with no Approve — even before the pod's expiry sweep
 * writes it (`proposal-expiry.ts`).
 */
export function reviewStatus(
  p: { status?: unknown; createdAt?: unknown; lifetimeHours?: unknown },
  now: number = Date.now()
): string {
  const status = String(p.status ?? "pending");
  if (status !== "pending") return status;
  const at =
    typeof p.createdAt === "string" || p.createdAt instanceof Date
      ? p.createdAt
      : null;
  const lifetime = typeof p.lifetimeHours === "number" ? p.lifetimeHours : null;
  return proposalLapsed(proposalExpiresAt(at, lifetime), now)
    ? "expired"
    : status;
}

/** The reads one proposal review needs. */
export function useProposalReview(proposalId: string) {
  const query = trpc.proposals.get.useQuery({ proposalId });

  /* WHERE the request came from. `proposals.source` enforces the SAME access
     gate as `get`, so this adds no exposure — it only names objects the reader
     is already allowed to see. Gated on `query.data` so a proposal that does
     not exist (or that this reader may not see) does not fire a second call
     that can only 404/403. `retry: false`: a provenance panel is evidence, and
     evidence that is absent must stay absent rather than retry into view. */
  const source = trpc.proposals.source.useQuery(
    { proposalId },
    { enabled: !!query.data, retry: false }
  );

  /* WHICH workspace. The proposal row carries only `workspaceId`; the name is
     a separate read, member-gated exactly like the review itself. A pod-wide
     proposal has no workspace at all (measured: ~70% of recent rows) — hence
     `enabled`, and hence the segment is OMITTED rather than filled with an id.*/
  const workspaceId = query.data?.workspaceId ?? undefined;
  const workspace = trpc.workspaces.get.useQuery(
    { id: workspaceId ?? "" },
    { enabled: !!workspaceId && isUuid(workspaceId), retry: false }
  );

  /* Provenance targets, resolved through the ONE exit door. A session, an
     automation, a playbook, an agent or a conversation opens on its web
     page; a skill lives in the desktop app. */
  const sourceExits = (source.data?.targets ?? []).map((target) => ({
    target,
    exit: openIn({ kind: "object", objectKind: target.kind, id: target.id }),
  }));

  return {
    query,
    sourceExits,
    workspaceName: workspace.data?.name ?? null,
  };
}

export type ProposalReviewData = NonNullable<
  ReturnType<typeof useProposalReview>["query"]["data"]
>;

export type ProposalSourceExit = ReturnType<
  typeof useProposalReview
>["sourceExits"][number];

// ─── Who is asking: one line ─────────────────────────────────────────────────

/**
 * WHO is asking, FOR whom, WHERE and WHEN, as one line of chips. Every part
 * is something the pod resolved; a part it did not resolve is absent, never
 * guessed and never an id.
 */
function ProvenanceLine({
  proposal: p,
  sourceExits,
  workspaceName,
}: {
  proposal: ProposalReviewData;
  sourceExits: ProposalSourceExit[];
  workspaceName: string | null;
}) {
  const { actor, forWhom } = proposalRequesterParts(p);
  const created = p.createdAt ? new Date(p.createdAt) : null;
  const asked = created && !Number.isNaN(created.getTime()) ? created : null;
  const agentExit = sourceExits.find((s) => s.target.kind === "agent");
  const others = sourceExits.filter((s) => s.target.kind !== "agent");
  const spaceExit =
    workspaceName && p.workspaceId
      ? openIn({ kind: "object", objectKind: "workspace", id: p.workspaceId })
      : undefined;

  /* One fallback beneath the line, not one per chip — six chips must not
     tell the reader to install the app six times (the defect `exit-link.tsx`
     documents). */
  const fallbackExit: Exit | undefined =
    sourceExits.find(({ exit }) => exit.isDesktopLink)?.exit ??
    (spaceExit?.isDesktopLink ? spaceExit : undefined);

  return (
    <ReviewProvenance
      fallback={
        fallbackExit && <ExitFallback exit={fallbackExit} showWeb={false} />
      }
    >
      {actor && (
        <Pill exit={actor.role === "agent" ? agentExit?.exit : undefined}>
          {actor.role === "agent" ? (
            <AgentMark name={actor.name} />
          ) : actor.role === "app" ? (
            <AppWindow aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
          ) : actor.role === "guest" ? (
            <UserRound aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
          ) : (
            <PersonAvatar name={actor.name} />
          )}
          {actor.role === "guest" ? (
            <span className="truncate">
              <span className="font-medium text-foreground">
                {resolveProvenanceLabel("guest")}
              </span>
              <span className="text-foreground/55"> through </span>
              {actor.name}
            </span>
          ) : (
            <span className="truncate font-medium text-foreground">
              {actor.name}
            </span>
          )}
        </Pill>
      )}
      {forWhom && (
        <Pill>
          {forWhom.name ? (
            <>
              <span className="text-foreground/55">for</span>
              <PersonAvatar name={forWhom.name} />
              <span className="truncate">{forWhom.name}</span>
            </>
          ) : (
            <span className="text-foreground/65">{forWhom.text}</span>
          )}
        </Pill>
      )}
      {workspaceName && (
        <Pill exit={spaceExit} title={resolveObjectNoun("workspace")}>
          <Layers aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
          <span className="truncate">{workspaceName}</span>
        </Pill>
      )}
      {others.map(({ target, exit }) => {
        const Icon = kindIcon(target.kind);
        return (
          <Pill
            key={`${target.kind}:${target.id}`}
            exit={exit}
            title={resolveObjectNoun(target.kind)}
          >
            <Icon aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
            <span className="truncate">{target.label}</span>
          </Pill>
        );
      })}
      {asked && (
        <Pill>
          <Clock aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
          <time
            dateTime={asked.toISOString()}
            title={formatTimestamp(p.createdAt)}
          >
            {formatRelative(p.createdAt)}
          </time>
        </Pill>
      )}
    </ReviewProvenance>
  );
}

// ─── The decision ────────────────────────────────────────────────────────────

/**
 * A decided proposal, in one sentence beside its status (`Outcome`, which
 * takes its mark and its words from the status).
 */
function terminalMessage(status: string): string {
  switch (status) {
    case "approved":
      return "You approved this change — it's now in your pod.";
    case "auto_approved":
      return "This matched an auto-approve rule and is already applied.";
    case "rejected":
      return "You rejected this — the agent was told why.";
    case "reverted":
      return "This change was undone after it was applied.";
    case "expired":
      return "Its moment passed before anyone decided — nothing was applied.";
    default:
      return "The agent withdrew this proposal — nothing was applied.";
  }
}

/** What the decision bar offers: the verbs a twin needs, or a plain Approve. */
type DecisionMode =
  | { kind: "plain" }
  | { kind: "twin-verbs"; review: ProposalDuplicateReview }
  | {
      kind: "graph-choices";
      review: ProposalDuplicateReview;
      choices: Readonly<Record<string, DuplicateItemChoice | undefined>>;
    };

/**
 * The verbs, nothing else. While the pod found a record twin
 * (`needsIdentityChoice`) there is no plain Approve and no "Approve &
 * always…": each would approve without the reviewer choosing, and the pod
 * then keeps both. A single create's twin verbs ARE the approve; a graph's
 * Approve sends one choice per item and waits while one still needs a pick.
 */
function DecisionButtons({
  proposal: p,
  mode,
  undo,
  onDecided,
  resume = false,
}: {
  proposal: ProposalReviewData;
  mode: DecisionMode;
  undo: ReviewMark | null;
  onDecided: () => void;
  /** A background attempt stopped part-way: approving again finishes it. */
  resume?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const decision = useProposalDecision(p.id, onDecided, {
    onRejected: () => setRejecting(false),
    expectedRevision: renderedRevision(p),
  });
  const { busy } = decision;

  if (rejecting) {
    return (
      <RejectConfirm
        reason={{
          value: reason,
          onChange: setReason,
          placeholder: "Why are you rejecting this? The agent sees this.",
        }}
        isLoading={decision.rejecting}
        onConfirm={() => decision.reject(reason)}
        onCancel={() => setRejecting(false)}
      />
    );
  }

  const rejectButton = (
    <RejectButton isDisabled={busy} onPress={() => setRejecting(true)} />
  );
  const undoChip = undo && <DisclosedMark mark={undo} icon={TriangleAlert} />;

  if (mode.kind === "twin-verbs") {
    return (
      <div className="flex flex-col gap-2.5">
        <TwinVerbs
          twins={mode.review.resolvable}
          pickedId={pickedId}
          onPick={setPickedId}
          onResolve={(identityResolution) =>
            decision.approve({ identityResolution })
          }
          busy={busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          {rejectButton}
          {undoChip}
        </div>
      </div>
    );
  }

  let choice: ApproveChoice = {};
  let waiting = false;
  if (mode.kind === "graph-choices") {
    const { byRef, missing } = identityResolutionByRefFor(
      mode.review.items,
      mode.choices
    );
    choice = { identityResolutionByRef: byRef };
    waiting = missing.length > 0;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ApproveButton
        isLoading={decision.approving}
        isDisabled={busy || waiting}
        onPress={() => decision.approve(choice)}
      >
        {resume ? "Resume" : APPROVE_LABEL}
      </ApproveButton>
      {rejectButton}
      {/* Never widen autonomy beside the approval of something that acts on
          its own: that moment is for reading it, not for "always". */}
      {mode.kind === "plain" &&
        !pageOnlyReasonActs(proposalPageOnlyReason(p)) && (
          <AlwaysApproveMenu proposal={p} disabled={busy} onDone={onDecided} />
        )}
      {undoChip}
      {waiting && (
        <span className="text-[12px] text-foreground/60">
          Pick the record for each item first.
        </span>
      )}
    </div>
  );
}

/** A background approval, as the decision bar shows it: title + bar + counts. */
function ApplyingNow({ run }: { run: ApprovalRun }) {
  const copy = approvalProgressCopy(run);
  return (
    <div aria-live="polite" className="flex flex-col gap-1.5">
      <span
        className={`text-[14px] font-medium ${
          copy.tone === "danger" ? "text-danger" : "text-foreground"
        }`}
      >
        {copy.title}
      </span>
      <ApprovalProgressLines copy={copy} />
    </div>
  );
}

// ─── The review ──────────────────────────────────────────────────────────────

/** The graph parts that act on their own once approved: never folded. */
const ACTING_SOURCES: ReadonlySet<GraphItemKey> = new Set<GraphItemKey>([
  "skills",
  "automations",
  "rules",
  "updates",
]);

/** The stored payload's capture-graph operations, when it is a graph. */
function isGraphPayload(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { operations?: unknown }).operations)
  );
}

function graphKindsOf(payload: unknown): string[] {
  if (!isGraphPayload(payload)) return [];
  const kinds = new Set<string>();
  for (const op of (payload as { operations: unknown[] }).operations) {
    const o = op as { op?: unknown; profileSlug?: unknown };
    if (o?.op === "create_entity" && typeof o.profileSlug === "string") {
      kinds.add(o.profileSlug);
    }
  }
  return [...kinds];
}

/**
 * The whole review of one proposal. `onDecided` fires after an approve or
 * reject lands (the page refetches; the drawer refreshes Review).
 * `barClassName` places the pinned decision bar in its host's scroll box
 * (its `bottom`, padding and ground).
 */
export function ProposalReviewBody({
  proposal: p,
  sourceExits,
  workspaceName,
  identity,
  onDecided,
  barClassName = "",
  afterDecision,
}: {
  proposal: ProposalReviewData;
  sourceExits: ProposalSourceExit[];
  workspaceName: string | null;
  /** Who the reader is signed in as, when the host knows it. */
  identity?: string;
  onDecided: () => void;
  barClassName?: string;
  /**
   * The page's door to what is next — drawn under the outcome, or under a
   * background approval's progress. Never beside the verbs: a proposal the
   * reader must still (re)decide — `approval_failed`, a stopped run — gets
   * no second primary inviting them to leave it.
   */
  afterDecision?: ReactNode;
}) {
  const status = reviewStatus(p);
  const payload = p.request.data ?? p.data;
  const { appConnect } = proposalHeading(p, payload);
  /* Writes kept for later (a held-writes pack, a join's deferred writes): one
     row per write, never the payload drawn as a record ("Untitled", its day,
     its outcome ids). They sit at the top of the row's own `data`. */
  const deferredWrites = appConnect
    ? null
    : (deriveDeferredWritesReview(p.data) ??
      deriveDeferredWritesReview(payload));
  // A document edit carries its own before / after: the reviewer reads the
  // change, not the request's JSON.
  const docChanges =
    appConnect || deferredWrites ? null : documentChanges(payload);
  const action = resolveProposalAction({
    proposalType: p.proposalType,
    data: p.data,
  });
  const graph = isGraphPayload(payload);
  const createKind =
    !graph && action === "create" && payload && typeof payload === "object"
      ? proposalProfileSlug(payload)
      : null;
  const graphKinds = graphKindsOf(payload);
  const defs = useRecordDefinitions({
    createKind,
    targetEntityId:
      !graph && action !== "create" && p.targetType === "entity"
        ? (p.targetId ?? null)
        : null,
    graphKinds,
  });

  /* The record(s) approving creates or changes. A graph: one card per part
     the pod's projection lists (skills, automations, rules, records, the
     process, updates — `composite-parts-model.ts`), and its links as one
     list; nobody approves a part they cannot see. Otherwise the pod's diff
     as one record — absent when it has nothing readable (the raw request is
     still in Advanced). */
  const objectRefs = (p as { objectRefs?: Record<string, ResolvedRef> })
    .objectRefs;
  const reviewGraph = graph
    ? (p.review as { graph?: ProposalReviewGraph }).graph
    : undefined;
  const graphItems =
    reviewGraph && !appConnect && !docChanges && !deferredWrites
      ? compositeItems(reviewGraph, payload, defs.definitionsFor)
      : [];
  /* A request to turn skills on: each skill drawn whole (its code or
     instructions, what it can reach), never only the names the payload
     carries. */
  const turnsOn =
    !graph && !appConnect && !docChanges && !deferredWrites
      ? (p.review as { turnsOn?: ProposalTurnsOn }).turnsOn
      : undefined;
  const edges = graphItems.flatMap((item) =>
    item.shape === "edge" ? [item.edge] : []
  );
  const records: ProposedRecord[] =
    appConnect || docChanges || deferredWrites
      ? []
      : graph
        ? reviewGraph
          ? graphItems.flatMap((item) =>
              item.shape === "record" ? [item.record] : []
            )
          : graphRecords(payload, defs.definitionsFor)
        : turnsOn
          ? turnOnRecords(turnsOn)
          : (() => {
              const record = proposedRecord({
                changes: (
                  p.review as { changes?: readonly ProposalChangeInput[] }
                ).changes,
                action,
                targetName: p.targetName ? String(p.targetName) : null,
                kind:
                  p.targetType === "entity"
                    ? defs.targetKind
                    : p.targetType
                      ? String(p.targetType)
                      : null,
                definitions: defs.definitions,
                objectRefs,
              });
              return record ? [record] : [];
            })();
  // An entity create carrying an upload: the reviewer sees the image itself.
  const recordMedia =
    !graph && action === "create" && p.targetType === "entity"
      ? proposedEntityMedia(payload)
      : null;
  const recordMediaAlt = recordMedia
    ? mediaAlt(
        (payload as { title?: unknown }).title,
        (payload as { properties?: Record<string, unknown> | null }).properties
      )
    : undefined;

  /* The twin(s) the pod's duplicate door found, read with the ONE derivation.
     `duplicateCheck` rides the TOP of the stored payload (`p.data`), beside
     the request envelope. */
  const duplicate = deriveDuplicateReview(p.data, {
    singleEntityCreate:
      !graph && p.targetType === "entity" && action === "create",
  });
  const [itemChoices, setItemChoices] = useState<
    Record<string, DuplicateItemChoice | undefined>
  >({});
  const actionable = isActionable(status);
  // A large approval applies in the background: while it runs, the bar shows
  // its progress instead of the verbs, for anyone who opens the proposal.
  const progress = useApprovalProgress(p.id, actionable);
  const run = progress.data as ApprovalRun | null | undefined;
  const applying = actionable && isApplying(run);
  const stopped =
    actionable && (run?.state === "failed" || run?.state === "stalled");
  useEffect(() => {
    if (applying) showApprovalProgressToast(p.id);
  }, [applying, p.id]);
  const mode: DecisionMode =
    duplicate && needsIdentityChoice({ duplicate })
      ? duplicate.resolvable.length > 0
        ? { kind: "twin-verbs", review: duplicate }
        : { kind: "graph-choices", review: duplicate, choices: itemChoices }
      : { kind: "plain" };
  const itemByRef = new Map(
    (duplicate?.items ?? []).map((item) => [item.forRef, item])
  );
  // Twins drawn under their graph item are not repeated in the flat list.
  const flatTwins = (duplicate?.candidates ?? []).filter(
    (c) => !(c.ref === "record" && c.forRef && itemByRef.has(c.forRef))
  );

  const why = proposalWhy({
    governanceReason: p.governanceReason,
    reasoning: p.review.reasoning,
  });
  const reason = reasonMark(p.governanceReason);
  const undo = undoMark((p as { revertable?: boolean | null }).revertable);
  const { actor } = proposalRequesterParts(p);
  // Present only when `proposals.source` named it: a session the reader may
  // read (the session floor, decision D1).
  const session = sourceExits.find((s) => s.target.kind === "session");

  /* A single create's twins sit under its own card; a graph item's sit inside
     that item's card, with its choice. */
  const twinsUnderCard = flatTwins.length > 0 && records.length === 1;
  /* One group per kind, capped; what acts on its own and what still owes a
     choice are never folded. */
  const actingRefs = new Set([
    ...graphItems.flatMap((item) =>
      item.shape === "record" && ACTING_SOURCES.has(item.source)
        ? [item.record.ref]
        : []
    ),
    ...(turnsOn ? records.map((r) => r.ref) : []),
  ]);
  const groups = recordGroups(
    records,
    (record) => actingRefs.has(record.ref) || itemByRef.has(record.ref)
  );
  const orphanItems = (duplicate?.items ?? []).filter(
    (item) => !records.some((r) => r.ref === item.forRef)
  );

  return (
    <div className="flex flex-col gap-5">
      <ProvenanceLine
        proposal={p}
        sourceExits={sourceExits}
        workspaceName={workspaceName}
      />
      {session && (
        <ProposalSessionContext
          sessionId={session.target.id}
          proposalId={p.id}
        />
      )}

      {/* The change first. */}
      {appConnect ? (
        <ReviewSection label="What it asks for">
          <ul className="flex flex-col gap-1">
            {appConnect.lines.map((line) => (
              <li
                key={line.workspaceId}
                className="text-[13px] text-foreground/80"
              >
                {line.text}
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-foreground/65">
            It gets a key only after you approve, and its writes still follow
            your review rules.
          </p>
        </ReviewSection>
      ) : deferredWrites ? (
        <DeferredWritesList review={deferredWrites} />
      ) : docChanges ? (
        <ReviewSection label="What changes">
          <DocumentChanges changes={docChanges} />
        </ReviewSection>
      ) : records.length > 0 ? (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <RecordGroupList
              key={group.kind ?? ""}
              group={group}
              render={(record) => {
                const item = itemByRef.get(record.ref);
                return (
                  <ProposedRecordCard
                    key={record.ref}
                    record={record}
                    media={recordMedia}
                    mediaAlt={recordMediaAlt}
                  >
                    {twinsUnderCard && (
                      <div className="border-t border-foreground/[0.06] pt-3">
                        <TwinDoors
                          candidates={flatTwins}
                          truncated={duplicate?.check.truncated}
                        />
                      </div>
                    )}
                    {item &&
                      (actionable ? (
                        <ItemTwinChoice
                          item={item}
                          choice={itemChoices[item.forRef]}
                          onChoice={(choice) =>
                            setItemChoices((prev) => ({
                              ...prev,
                              [item.forRef]: choice,
                            }))
                          }
                          busy={false}
                        />
                      ) : (
                        <div className="border-t border-foreground/[0.06] pt-3">
                          <TwinDoors
                            candidates={item.resolvable}
                            withFor={false}
                          />
                        </div>
                      ))}
                  </ProposedRecordCard>
                );
              }}
            />
          ))}
        </div>
      ) : null}
      {turnsOn && turnsOn.unreadSkills > 0 && (
        <p className="text-[13px] text-foreground/80">
          {`It also turns on ${turnsOn.unreadSkills} ${
            turnsOn.unreadSkills === 1 ? "skill" : "skills"
          } you cannot read.`}
        </p>
      )}
      {edges.length > 0 && <PartEdgeList edges={edges} />}
      {/* A graph item whose card is not drawn still owes its choice: it is
          never sent on a default nobody saw. */}
      {orphanItems.map((item) => (
        <ProposedRecordCard
          key={item.forRef}
          record={{
            ref: item.forRef,
            title: item.forTitle,
            kind: item.resolvable[0]?.kind ?? null,
            op: "create",
            fields: [],
          }}
        >
          {actionable ? (
            <ItemTwinChoice
              item={item}
              choice={itemChoices[item.forRef]}
              onChoice={(choice) =>
                setItemChoices((prev) => ({ ...prev, [item.forRef]: choice }))
              }
              busy={false}
            />
          ) : (
            <TwinDoors candidates={item.resolvable} withFor={false} />
          )}
        </ProposedRecordCard>
      ))}
      {flatTwins.length > 0 && !twinsUnderCard && (
        <TwinDoors
          candidates={flatTwins}
          truncated={duplicate?.check.truncated}
        />
      )}

      {/* Why: ONE mark (its sentence on press), then the requester's own
          words, as theirs. Worded for every status: an approved proposal
          still needed approval. */}
      {(reason || why.proposer || duplicate?.check.status === "unchecked") && (
        <section aria-label="Why" className="flex flex-col gap-3">
          {(reason || duplicate?.check.status === "unchecked") && (
            <div className="flex flex-wrap items-center gap-2">
              {reason && (
                <DisclosedMark
                  mark={reason}
                  icon={reason.tone === "warning" ? ShieldAlert : ShieldCheck}
                />
              )}
              {duplicate?.check.status === "unchecked" && (
                <DuplicateUnchecked />
              )}
            </div>
          )}
          {why.proposer && (
            <RequesterNote who={actor?.name ?? null} text={why.proposer} />
          )}
        </section>
      )}

      <DecisionBar pinned={actionable} className={barClassName}>
        {applying && run ? (
          <>
            <ApplyingNow run={run} />
            {afterDecision}
          </>
        ) : actionable ? (
          <>
            {/* A failed READ of progress is said, never read as "nothing
                running"; the approve door itself still refuses or joins a
                run that is in fact applying. */}
            {progress.isError && (
              <ApprovalProgressLines
                copy={progressUnavailable}
                onRetry={() => void progress.refetch()}
              />
            )}
            {stopped && run && <ApplyingNow run={run} />}
            <DecisionButtons
              proposal={p}
              mode={mode}
              undo={undo}
              onDecided={onDecided}
              resume={stopped}
            />
          </>
        ) : (
          <>
            <Outcome status={status} message={terminalMessage(status)} />
            {afterDecision}
          </>
        )}
        <WhoDecides identity={identity} />
      </DecisionBar>

      {/* The ONE Advanced: ids and the raw request, collapsed, under the
          decision — the reader decides on the change, not on the JSON. */}
      <AdvancedPanel
        ids={[
          { label: "Proposal id", value: p.id },
          { label: "Change", value: `${p.targetType} · ${p.proposalType}` },
          ...(p.targetId ? [{ label: "Target id", value: p.targetId }] : []),
        ]}
        raw={p.request}
      />
    </div>
  );
}
