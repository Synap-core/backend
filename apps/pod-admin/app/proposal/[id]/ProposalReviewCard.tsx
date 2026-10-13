"use client";

/**
 * The proposal DECISION, shared by the `/proposal/[id]` receiver page and the
 * console's Review drawer: the same reads, the same words, the same verbs.
 *
 *   `useProposalReview` — the proposal, where it came from, and its space.
 *   `ProposalDecision`  — why it needs approval, what it asks for, and
 *                         Approve / Reject-with-reason / "always approve", or
 *                         the outcome once decided.
 *
 * Each host draws its own frame around them (the receiver's card header, the
 * drawer's title and trust signals); neither re-implements the decision.
 */

import { useState, type ReactNode } from "react";
import { Button, Textarea, addToast } from "@heroui/react";
import { Check, ExternalLink, X } from "lucide-react";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { openIn, type Exit } from "../../../lib/open-in";
import { ExitFallback, externalProps } from "../../../lib/exit-link";
/* The pod's own uuid predicate, not a fourth regex. `workspaceId` is a TEXT
   column while `workspaces.get` takes `.uuid()` — without this guard a
   non-uuid workspace ref would fire a request that can only fail. */
import { isUuid } from "../../open/open-params";
import { trpc } from "../../../lib/trpc";
import { AlwaysApproveMenu } from "./AlwaysApproveMenu";
import { proposalHeading } from "./proposal-heading";
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

  /* Provenance targets, resolved through the ONE exit door. Every kind
     `source` can return (session, channel, automation, skill, playbook, agent)
     lives in the desktop app, so each resolves to a `synap://` link. */
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

/** "Requested by Acme (for Ana) · in Builder · 2h ago" — only parts the pod resolved. */
export function proposalRequestedParts(
  p: ProposalReviewData,
  workspaceName: string | null,
  when: (at: Date | string) => string
): string[] {
  /* Built from fields the payload GENUINELY carries. `authorName` is the
     enrichment's resolved display name (the raw row has only ids); a segment
     whose source is missing is dropped, never defaulted, so this line can
     never assert a requester nobody resolved. An Application is the requester
     — name it, and keep the human it acts for. `appName` rides the display
     projection; read defensively because the published types may lag. */
  const appName = (p as { appName?: string }).appName;
  return [
    appName
      ? `Requested by ${appName}${p.authorName ? ` (for ${p.authorName})` : ""}`
      : p.authorName
        ? `Requested by ${p.authorName}`
        : undefined,
    workspaceName ? `in ${workspaceName}` : undefined,
    p.createdAt ? when(p.createdAt) : undefined,
  ].filter((part): part is string => !!part);
}

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

/**
 * Why it needs approval, what it asks for, and the verbs — or the outcome.
 * `onDecided` fires after an approve or reject lands (the receiver refetches;
 * the drawer refreshes Review and closes).
 */
export function ProposalDecision({
  proposal: p,
  sourceExits,
  onDecided,
}: {
  proposal: ProposalReviewData;
  sourceExits: ProposalSourceExit[];
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

  const status = String(p.status ?? "pending");
  const payload = p.request.data ?? p.data;
  const { appConnect } = proposalHeading(p, payload);
  const why = proposalWhy({
    governanceReason: p.governanceReason,
    reasoning: p.review.reasoning,
  });
  const actionable = isActionable(status);
  const busy = approve.isPending || reject.isPending;

  /* One fallback beneath the LIST, not one per row — six rows must not tell
     the reader to install the app six times (the defect `exit-link.tsx`
     documents). Same shape as the workspaces row menu. */
  const sourceFallbackExit: Exit | undefined = sourceExits.find(
    ({ exit }) => exit.isDesktopLink
  )?.exit;

  return (
    <div className="flex flex-col gap-5">
      {why.proposer && (
        <p className="text-[13px] leading-relaxed text-foreground/65">
          {why.proposer}
        </p>
      )}

      {/* The policy's WHY, never voiced as the proposer's. Worded for every
          status: an approved proposal still needed approval. */}
      {why.policy && (
        <p className="text-[12.5px] leading-relaxed text-foreground/65">
          <span className="font-medium text-foreground/80">
            Why this needs approval:
          </span>{" "}
          {why.policy}
        </p>
      )}

      {/* Absent, not empty: a proposal with no resolvable lineage renders no
          section at all. An "Where this came from — (none)" box would be a
          claim about provenance dressed as an admission of ignorance. */}
      {sourceExits.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
          <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
            Where this came from
          </p>
          <ul className="flex flex-col gap-1">
            {sourceExits.map(({ target, exit }) => (
              <li
                key={`${target.kind}:${target.id}`}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <span className="text-[12px] text-foreground/65">
                  {resolveObjectNoun(target.kind)}
                </span>
                <a
                  href={exit.href}
                  {...externalProps(exit.href)}
                  className="inline-flex items-center gap-1.5 rounded-sm text-[13px] text-foreground/75 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {target.label}
                  {/* Same promise the shared link makes: the icon means
                      "this leaves pod-admin". A desktop hand-off does. */}
                  {exit.isDesktopLink && <ExternalLink size={14} aria-hidden />}
                </a>
              </li>
            ))}
          </ul>
          {sourceFallbackExit && <ExitFallback exit={sourceFallbackExit} />}
        </div>
      )}

      {appConnect ? (
        <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
          <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
            Asks for
          </p>
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
        </div>
      ) : (
        /* The raw request is evidence for the reader who wants it — never
           the first thing a reviewer reads. Collapsed, last. */
        <details className="rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
          <summary className="cursor-pointer select-none text-[12px] font-medium text-foreground/65">
            Advanced · raw request
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto text-xs leading-relaxed text-foreground/75">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </details>
      )}

      {actionable ? (
        !rejecting ? (
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
            <AlwaysApproveMenu
              proposal={p}
              disabled={busy}
              onDone={onDecided}
            />
          </div>
        ) : (
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
        )
      ) : (
        (() => {
          const o = terminalOutcome(status);
          const tone = OUTCOME_TONE[o.tone];
          return (
            <div
              aria-live="polite"
              className="flex items-center gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10"
            >
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
        })()
      )}
    </div>
  );
}
