"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Spinner,
  Textarea,
  addToast,
} from "@heroui/react";
import { Check, X, ExternalLink, ShieldCheck } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";

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

export function ProposalReview({ proposalId }: { proposalId: string }) {
  const query = trpc.proposals.get.useQuery({ proposalId });
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  // A session that expired mid-review returns tRPC UNAUTHORIZED — bounce to
  // login and back. Run it as an effect (not during render, matching
  // my-connections/page.tsx) so render stays pure.
  useEffect(() => {
    if (query.error) {
      redirectToLoginIfUnauthorized(query.error, `/proposal/${proposalId}`);
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

  const openInApp = (
    <a
      href={`synap://open/proposal/${proposalId}`}
      className="inline-flex min-h-10 items-center gap-1.5 text-[13px] text-foreground/50 transition-colors hover:text-foreground/75"
    >
      Open in the Synap desktop app <ExternalLink size={14} />
    </a>
  );

  const shell = (children: ReactNode) => (
    <main className="flex min-h-screen items-start justify-center px-6 py-16">
      <Card
        radius="lg"
        shadow="none"
        className="w-full max-w-2xl bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10"
      >
        {children}
      </Card>
    </main>
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
  const targetLabel = String(p.targetName ?? p.targetType ?? "");
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
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/45">
              Proposal review
            </p>
            <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
              {proposalType}
              {targetLabel ? (
                <span className="text-foreground/60"> · {targetLabel}</span>
              ) : null}
            </h1>
          </div>
        </div>
        <Chip
          color={STATUS_COLOR[status] ?? "default"}
          variant="flat"
          size="sm"
        >
          {status.replace(/_/g, " ")}
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

        <div className="pt-1">{openInApp}</div>
      </CardBody>
    </>
  );
}
