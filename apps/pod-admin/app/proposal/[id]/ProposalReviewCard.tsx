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
 *       the change first (before → after per field, a document's diff, an
 *         app's access lines);
 *       why (the policy as a mark + its sentence, the proposer's own words);
 *       what approving does (undoable or not, as a mark);
 *       Advanced (ids + raw request), collapsed, last;
 *       the decision bar, pinned to the bottom, with who decides.
 *
 * This file owns provenance and the ONE "Advanced". Hosts draw only their
 * frame: the page its card header, the drawer its title. Before 2026-10-23
 * the drawer drew its own "who / when / where" rows AND embedded the decision,
 * which drew a second provenance box and a second "Advanced" — provenance
 * three times, Advanced twice, in one panel.
 */

import { useState, type ReactNode } from "react";
import { Button, Textarea, addToast } from "@heroui/react";
import {
  AppWindow,
  ArrowRight,
  Check,
  Clock,
  Layers,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { resolveServiceMark } from "@synap-core/types/service-marks";
import {
  resolveObjectNoun,
  resolveProvenanceLabel,
} from "@synap-core/types/vocabulary";
import { openIn, type Exit } from "../../../lib/open-in";
import {
  ExitFallback,
  externalProps,
  rowHref,
  usePlacedExit,
} from "../../../lib/exit-link";
/* The pod's own uuid predicate, not a fourth regex. `workspaceId` is a TEXT
   column while `workspaces.get` takes `.uuid()` — without this guard a
   non-uuid workspace ref would fire a request that can only fail. */
import { formatRelative, formatTimestamp, isUuid } from "../../../lib/format";
import { trpc } from "../../../lib/trpc";
import { navItem } from "../../../lib/console-nav";
import { useConsoleRole } from "../../(admin)/components/side-nav-role";
import { AdvancedPanel } from "../../_lib/object/advanced-panel";
import { kindIcon } from "../../_lib/object/kind-icon";
import { DocumentChanges } from "../../_lib/object/content/document-changes";
import { documentChanges } from "../../_lib/object/content/document-changes-model";
import { AlwaysApproveMenu } from "./AlwaysApproveMenu";
import { proposalHeading } from "./proposal-heading";
import { proposalRequesterParts } from "./proposal-requester";
import {
  approveConsequence,
  fieldChangeRows,
  governanceMark,
  initials,
  type FieldChangeRow,
  type ProposalChangeInput,
  type ReviewMark,
} from "./proposal-review-model";
import { proposalWhy } from "./proposal-why";

/**
 * `pending` and `approval_failed` are the two states a reviewer can still decide;
 * everything else is terminal (already approved / rejected / reverted / withdrawn).
 */
export function isActionable(status: string): boolean {
  return status === "pending" || status === "approval_failed";
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

// ─── Marks ───────────────────────────────────────────────────────────────────

const MARK_TONE: Record<ReviewMark["tone"], string> = {
  warning: "bg-warning/10 text-warning ring-warning/25",
  primary: "bg-primary/10 text-primary ring-primary/25",
  success: "bg-success/10 text-success ring-success/25",
  default: "bg-foreground/[0.05] text-foreground/75 ring-foreground/15",
};

/** A state, said by colour + icon first and four words second. */
function MarkChip({
  mark,
  icon: Icon,
}: {
  mark: ReviewMark;
  icon: LucideIcon;
}) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium ring-1 ring-inset ${MARK_TONE[mark.tone]}`}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
      {mark.label}
    </span>
  );
}

const PILL =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-foreground/[0.04] px-2.5 text-[12.5px] text-foreground/80 ring-1 ring-inset ring-foreground/10";
const PILL_DOOR =
  "transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/**
 * One provenance chip. With an exit it is a door to that object's own page
 * (or, on a phone that cannot follow it, the console page covering it);
 * without one — or when this device has nowhere to send it — it is a mark.
 */
function Pill({
  exit,
  title,
  children,
}: {
  exit?: Exit;
  title?: string;
  children: ReactNode;
}) {
  if (!exit) {
    return (
      <span className={PILL} title={title}>
        {children}
      </span>
    );
  }
  return (
    <DoorPill exit={exit} title={title}>
      {children}
    </DoorPill>
  );
}

function DoorPill({
  exit,
  title,
  children,
}: {
  exit: Exit;
  title?: string;
  children: ReactNode;
}) {
  const href = rowHref(usePlacedExit(exit));
  if (href === null) {
    return (
      <span className={PILL} title={title}>
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      {...externalProps(href)}
      title={title}
      className={`${PILL} ${PILL_DOOR}`}
    >
      {children}
    </a>
  );
}

/** The agent's service mark (the registry's glyph; neutral when it has none). */
function AgentMark({ name }: { name: string }) {
  const mark = resolveServiceMark(name, "mono");
  return (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground/80"
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill={mark.fill}>
        <path d={mark.path} fillRule={mark.fillRule} />
      </svg>
    </span>
  );
}

function PersonAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-semibold text-primary"
    >
      {initials(name)}
    </span>
  );
}

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
    <div className="flex flex-col gap-1.5">
      <div
        role="group"
        aria-label="Who is asking"
        data-review-provenance=""
        className="flex flex-wrap items-center gap-1.5"
      >
        {actor && (
          <Pill exit={actor.role === "agent" ? agentExit?.exit : undefined}>
            {actor.role === "agent" ? (
              <AgentMark name={actor.name} />
            ) : actor.role === "app" ? (
              <AppWindow
                aria-hidden
                className="h-3.5 w-3.5 text-foreground/55"
              />
            ) : actor.role === "guest" ? (
              <UserRound
                aria-hidden
                className="h-3.5 w-3.5 text-foreground/55"
              />
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
          <span className={PILL}>
            <Clock aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
            <time
              dateTime={asked.toISOString()}
              title={formatTimestamp(p.createdAt)}
            >
              {formatRelative(p.createdAt)}
            </time>
          </span>
        )}
      </div>
      {fallbackExit && <ExitFallback exit={fallbackExit} showWeb={false} />}
    </div>
  );
}

// ─── The change ──────────────────────────────────────────────────────────────

function FieldValue({
  value,
  tone,
}: {
  value: string | null;
  tone: "before" | "after";
}) {
  if (value === null) {
    return <span className="text-[13px] italic text-foreground/50">empty</span>;
  }
  return (
    <span
      className={
        tone === "before"
          ? "rounded-md bg-status-down/[0.06] px-1.5 py-0.5 text-[13px] text-foreground/60 line-through decoration-status-down/50 ring-1 ring-inset ring-status-down/20"
          : "rounded-md bg-status-healthy/[0.08] px-1.5 py-0.5 text-[13px] font-medium text-foreground ring-1 ring-inset ring-status-healthy/30"
      }
    >
      {value}
    </span>
  );
}

function FieldChanges({ rows }: { rows: FieldChangeRow[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-col gap-1">
          <span className="text-[12px] text-foreground/60">{row.label}</span>
          <span className="flex flex-wrap items-center gap-1.5 break-words">
            {row.before !== undefined && (
              <>
                <FieldValue value={row.before} tone="before" />
                {row.op === "change" && (
                  <ArrowRight
                    aria-label="becomes"
                    className="h-3.5 w-3.5 shrink-0 text-foreground/45"
                  />
                )}
              </>
            )}
            {row.after !== undefined && (
              <FieldValue value={row.after} tone="after" />
            )}
            {row.op === "remove" && (
              <span className="text-[12px] text-status-down">removed</span>
            )}
          </span>
          {row.stale && (
            <span className="text-[11.5px] text-warning">
              Edited since this was proposed — the value before is out of date.
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10"
    >
      {children}
    </section>
  );
}

// ─── The decision ────────────────────────────────────────────────────────────

/** Terminal-state payoff — mirrors the `Outcome` pattern in ApproveForm.tsx. */
function terminalOutcome(status: string): {
  tone: "success" | "danger" | "muted";
  icon: ReactNode;
  title: string;
  message: string;
} {
  switch (status) {
    case "approved":
      return {
        tone: "success",
        icon: <Check className="h-6 w-6" strokeWidth={2.2} />,
        title: "Approved",
        message: "You approved this change — it's now in your pod.",
      };
    case "auto_approved":
      return {
        tone: "success",
        icon: <Check className="h-6 w-6" strokeWidth={2.2} />,
        title: "Auto-approved",
        message: "This matched an auto-approve rule and is already applied.",
      };
    case "rejected":
      return {
        tone: "danger",
        icon: <X className="h-6 w-6" strokeWidth={2.2} />,
        title: "Rejected",
        message: "You rejected this — the agent was told why.",
      };
    case "reverted":
      return {
        tone: "muted",
        icon: <X className="h-6 w-6" strokeWidth={2.2} />,
        title: "Reverted",
        message: "This change was undone after it was applied.",
      };
    default:
      return {
        tone: "muted",
        icon: <X className="h-6 w-6" strokeWidth={2.2} />,
        title: "Withdrawn",
        message: "The agent withdrew this proposal — nothing was applied.",
      };
  }
}

const OUTCOME_TONE: Record<
  "success" | "danger" | "muted",
  { ring: string; bg: string; text: string }
> = {
  success: {
    ring: "ring-success/25",
    bg: "bg-success/10",
    text: "text-success",
  },
  danger: { ring: "ring-danger/25", bg: "bg-danger/10", text: "text-danger" },
  muted: {
    ring: "ring-foreground/15",
    bg: "bg-foreground/[0.05]",
    text: "text-foreground/60",
  },
};

function Outcome({ status }: { status: string }) {
  const o = terminalOutcome(status);
  const tone = OUTCOME_TONE[o.tone];
  return (
    <div aria-live="polite" className="flex items-center gap-3">
      <span
        aria-hidden
        className={`flex h-10 w-10 items-center justify-center rounded-full ring-1 ring-inset ${tone.bg} ${tone.ring} ${tone.text}`}
      >
        {o.icon}
      </span>
      <div className="flex flex-col">
        <span className="text-[15px] font-medium text-foreground">
          {o.title}
        </span>
        <span className="text-[13px] leading-relaxed text-foreground/60">
          {o.message}
        </span>
      </div>
    </div>
  );
}

/** Approve / Reject-with-reason / "always approve" — the verbs, nothing else. */
function DecisionButtons({
  proposal: p,
  onDecided,
}: {
  proposal: ProposalReviewData;
  onDecided: () => void;
}) {
  const proposalId = p.id;
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const approve = trpc.proposals.approve.useMutation({
    onSuccess: () => {
      addToast({ title: "Proposal approved", color: "success" });
      onDecided();
    },
    onError: (e) =>
      addToast({
        title: "Could not approve",
        description: e.message,
        color: "danger",
      }),
  });

  const reject = trpc.proposals.reject.useMutation({
    onSuccess: () => {
      addToast({ title: "Proposal rejected", color: "success" });
      setRejecting(false);
      onDecided();
    },
    onError: (e) =>
      addToast({
        title: "Could not reject",
        description: e.message,
        color: "danger",
      }),
  });

  const busy = approve.isPending || reject.isPending;

  if (rejecting) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          value={reason}
          onValueChange={setReason}
          label="Reason (optional)"
          placeholder="Why are you rejecting this? The agent sees this."
          minRows={2}
        />
        <div className="flex items-center gap-2">
          <Button
            color="danger"
            className="min-h-10"
            isLoading={reject.isPending}
            onPress={() =>
              reject.mutate({
                proposalId,
                reason: reason.trim() || undefined,
              })
            }
          >
            Confirm reject
          </Button>
          <Button
            variant="light"
            className="min-h-10"
            isDisabled={reject.isPending}
            onPress={() => setRejecting(false)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        color="success"
        className="min-h-10"
        startContent={<Check size={16} />}
        isLoading={approve.isPending}
        isDisabled={busy}
        onPress={() => approve.mutate({ proposalId })}
      >
        Approve
      </Button>
      <Button
        color="danger"
        variant="flat"
        className="min-h-10"
        startContent={<X size={16} />}
        isDisabled={busy}
        onPress={() => setRejecting(true)}
      >
        Reject…
      </Button>
      <AlwaysApproveMenu proposal={p} disabled={busy} onDone={onDecided} />
    </div>
  );
}

/** Who decides, and where it is recorded — one quiet line by the verbs. */
function WhoDecides({ identity }: { identity?: string }) {
  const role = useConsoleRole();
  const audit = navItem("audit");
  const log =
    role === "admin" ? (
      <a
        href={audit.href}
        className="underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground/60"
      >
        {audit.label}
      </a>
    ) : (
      audit.label
    );
  return (
    <p className="text-[11.5px] text-foreground/55">
      {identity ? (
        <>
          You decide as <span className="text-foreground/75">{identity}</span>
          {" · recorded in the "}
        </>
      ) : (
        "Recorded in the "
      )}
      {log}
    </p>
  );
}

// ─── The review ──────────────────────────────────────────────────────────────

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
}: {
  proposal: ProposalReviewData;
  sourceExits: ProposalSourceExit[];
  workspaceName: string | null;
  /** Who the reader is signed in as, when the host knows it. */
  identity?: string;
  onDecided: () => void;
  barClassName?: string;
}) {
  const status = String(p.status ?? "pending");
  const payload = p.request.data ?? p.data;
  const { appConnect } = proposalHeading(p, payload);
  // A document edit carries its own before / after: the reviewer reads the
  // change, not the request's JSON.
  const docChanges = appConnect ? null : documentChanges(payload);
  const fields = appConnect
    ? []
    : fieldChangeRows(
        (p.review as { changes?: readonly ProposalChangeInput[] }).changes
      );
  const why = proposalWhy({
    governanceReason: p.governanceReason,
    reasoning: p.review.reasoning,
  });
  const policyMark = governanceMark(p.governanceReason);
  const actionable = isActionable(status);
  const consequence = approveConsequence(
    (p as { revertable?: boolean | null }).revertable
  );

  return (
    <div className="flex flex-col gap-5">
      <ProvenanceLine
        proposal={p}
        sourceExits={sourceExits}
        workspaceName={workspaceName}
      />

      {/* The change first. Absent when the pod sent nothing readable — the
          raw request is still in Advanced. */}
      {appConnect ? (
        <Section label="What it asks for">
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
        </Section>
      ) : docChanges ? (
        <Section label="What changes">
          <DocumentChanges changes={docChanges} />
        </Section>
      ) : fields.length > 0 ? (
        <Section label="What changes">
          <FieldChanges rows={fields} />
        </Section>
      ) : null}

      {/* Why: the policy's reason as a mark + its own sentence, never voiced
          as the proposer's; then the proposer's words, as theirs. Worded for
          every status: an approved proposal still needed approval. */}
      {(why.policy || why.proposer) && (
        <section aria-label="Why" className="flex flex-col gap-2.5">
          {why.policy && (
            <div className="flex flex-wrap items-start gap-2">
              {policyMark && (
                <MarkChip
                  mark={policyMark}
                  icon={
                    policyMark.tone === "warning" ? ShieldAlert : ShieldCheck
                  }
                />
              )}
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-foreground/70">
                {why.policy}
              </p>
            </div>
          )}
          {why.proposer && (
            <blockquote className="border-l-2 border-foreground/15 pl-3 text-[13px] leading-relaxed text-foreground/80">
              {why.proposer}
            </blockquote>
          )}
        </section>
      )}

      {actionable && (
        <div className="flex flex-wrap items-center gap-2">
          {consequence.mark && (
            <MarkChip
              mark={consequence.mark}
              icon={
                consequence.mark.tone === "success" ? RotateCcw : TriangleAlert
              }
            />
          )}
          <span className="text-[12.5px] text-foreground/65">
            {consequence.sentence}
          </span>
        </div>
      )}

      {/* The ONE Advanced: ids and the raw request, collapsed, last. */}
      <AdvancedPanel
        ids={[
          { label: "Proposal id", value: p.id },
          { label: "Change", value: `${p.targetType} · ${p.proposalType}` },
          ...(p.targetId ? [{ label: "Target id", value: p.targetId }] : []),
        ]}
        raw={p.request}
      />

      <div
        data-review-decision=""
        className={`flex flex-col gap-2 border-t border-foreground/[0.06] ${
          actionable ? "sticky z-10" : ""
        } ${barClassName}`}
      >
        {actionable ? (
          <DecisionButtons proposal={p} onDecided={onDecided} />
        ) : (
          <Outcome status={status} />
        )}
        <WhoDecides identity={identity} />
      </div>
    </div>
  );
}
