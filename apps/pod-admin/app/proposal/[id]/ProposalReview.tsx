"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  CardBody,
  CardHeader,
  Chip,
  Spinner,
  Textarea,
  addToast,
} from "@heroui/react";
import { Check, X, ShieldCheck } from "lucide-react";
import { openIn } from "../../../lib/open-in";
import {
  buildObjectActionTitle,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../lib/exit-link";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { AlwaysApproveMenu } from "./AlwaysApproveMenu";

/**
 * `pending` and `approval_failed` are the two states a reviewer can still decide;
 * everything else is terminal (already approved / rejected / reverted / withdrawn).
 */
function isActionable(status: string): boolean {
  return status === "pending" || status === "approval_failed";
}

const STATUS_COLOR: Record<
  string,
  "default" | "success" | "danger" | "warning"
> = {
  pending: "warning",
  approval_failed: "warning",
  approved: "success",
  auto_approved: "success",
  rejected: "danger",
  reverted: "default",
  withdrawn: "default",
};

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

export function ProposalReview({
  proposalId,
  podHost,
  identity,
}: {
  proposalId: string;
  podHost?: string;
  identity?: string;
}) {
  const query = trpc.proposals.get.useQuery({ proposalId });
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  // A session that expired mid-review returns tRPC UNAUTHORIZED — bounce to
  // login and back. Run it as an effect (not during render, matching
  // my-connections/page.tsx) so render stays pure.
  useEffect(() => {
    if (query.error) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.error, proposalId]);

  const approve = trpc.proposals.approve.useMutation({
    onSuccess: () => {
      addToast({ title: "Proposal approved", color: "success" });
      void query.refetch();
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
      void query.refetch();
    },
    onError: (e) =>
      addToast({
        title: "Could not reject",
        description: e.message,
        color: "danger",
      }),
  });

  /* Resolved through the one door rather than hand-written, so this link is
     covered by the same fallback rule as every other exit: a synap:// href
     does nothing at all when the app isn't installed, and this page is often
     someone's FIRST contact with Synap — arriving from an email or a CLI
     link — so "nothing happened" is the worst possible outcome here. */
  const appExit = openIn({
    kind: "objectInApp",
    objectKind: "proposal",
    id: proposalId,
  });
  const openInApp = (
    <ExitLink exit={appExit} label="Open in the Synap desktop app" />
  );

  /* Shared with the other inbound routes — /open, invite, agent approval and
     OAuth consent — so a reader who lands on two of them recognises the
     second. `connection-requests` and `connect` still render their own. */
  /* `footer` is opt-in per branch. Passing it unconditionally offered "Open in
     the Synap desktop app" on the loading, not-found and unauthorized cards —
     a link into nothing for a proposal that does not exist or that the reader
     is not allowed to see. */
  const shell = (children: ReactNode, footer?: ReactNode) => (
    <ReceiverShell podHost={podHost} identity={identity} footer={footer}>
      {children}
    </ReceiverShell>
  );

  if (query.isLoading) {
    return shell(
      <CardBody className="items-center gap-3 px-7 py-16">
        <Spinner label="Loading proposal…" />
      </CardBody>
    );
  }

  const p = query.data;
  if (query.error || !p) {
    return shell(
      <CardBody className="gap-4 px-7 py-8">
        <p className="text-[13px] leading-relaxed text-foreground/70">
          This proposal couldn&apos;t be loaded — it may have been withdrawn, or
          you may not have access to it.
        </p>
        {openInApp}
      </CardBody>
    );
  }

  const status = String(p.status ?? "pending");
  const proposalType = String(p.proposalType ?? "change");
  /* The heading names what APPROVING WILL DO, so the verb is imperative —
     "Create workspace", not "Created workspace". Until 2026-09-06 this printed
     `p.proposalType` verbatim, so the highest-stakes page in the product, the
     one a stranger reaches from an email, greeted them with `entity.create`.
     That exact leak is named in .claude/rules/vocabulary.md. */
  const heading = buildObjectActionTitle({
    action: proposalType,
    objectKind: String(p.targetType ?? ""),
    objectName: p.targetName ? String(p.targetName) : undefined,
  });
  const reasoning =
    typeof p.review.reasoning === "string" && p.review.reasoning.trim()
      ? p.review.reasoning
      : undefined;
  const payload = p.request.data ?? p.data;
  const actionable = isActionable(status);
  const busy = approve.isPending || reject.isPending;

  return shell(
    <>
      <CardHeader className="flex items-start justify-between gap-3 px-7 pb-0 pt-7">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
          >
            <ShieldCheck className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
              Proposal review
            </p>
            <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
              {heading}
            </h1>
          </div>
        </div>
        <Chip
          color={STATUS_COLOR[status] ?? "default"}
          variant="flat"
          size="sm"
        >
          {resolveStatusLabel(status)}
        </Chip>
      </CardHeader>

      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {reasoning && (
          <p className="text-[13px] leading-relaxed text-foreground/65">
            {reasoning}
          </p>
        )}

        <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
          <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/45">
            Details
          </p>
          <pre className="max-h-96 overflow-auto text-xs leading-relaxed text-foreground/75">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>

        {actionable ? (
          !rejecting ? (
            <div className="flex items-center gap-2">
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
                onDone={() => void query.refetch()}
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
      </CardBody>
    </>,
    openInApp
  );
}
