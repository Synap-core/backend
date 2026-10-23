"use client";

import { useEffect, type ReactNode } from "react";
import { CardBody, CardHeader, Chip, Spinner } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { openIn } from "../../../lib/open-in";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../lib/exit-link";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { proposalHeading } from "./proposal-heading";
import { ProposalReviewBody, useProposalReview } from "./ProposalReviewCard";

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

export function ProposalReview({
  proposalId,
  podHost,
  identity,
}: {
  proposalId: string;
  podHost?: string;
  identity?: string;
}) {
  const { query, sourceExits, workspaceName } = useProposalReview(proposalId);

  // A session that expired mid-review returns tRPC UNAUTHORIZED — bounce to
  // login and back. Run it as an effect (not during render, matching
  // my-connections/page.tsx) so render stays pure.
  useEffect(() => {
    if (query.error) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.error, proposalId]);

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
  /* Who asked, for whom, where and when is drawn INSIDE the card, by the
     review itself (`ProposalReviewBody`) — the same line the Review drawer
     shows, so the shell's `requested` slot stays empty here. */
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
  /* The heading names what APPROVING WILL DO, so the verb is imperative —
     "Create workspace", not "Created workspace". Until 2026-09-06 this printed
     `p.proposalType` verbatim, so the highest-stakes page in the product, the
     one a stranger reaches from an email, greeted them with `entity.create`.
     That exact leak is named in .claude/rules/vocabulary.md. */
  const { heading } = proposalHeading(p, p.request.data ?? p.data);

  return shell(
    <>
      <CardHeader className="flex items-start justify-between gap-3 px-7 pb-0 pt-7">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
          >
            <ShieldCheck className="h-5 w-5" strokeWidth={2} />
          </span>
          <h1 className="min-w-0 break-words font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
            {heading}
          </h1>
        </div>
        <Chip
          color={STATUS_COLOR[status] ?? "default"}
          variant="flat"
          size="sm"
        >
          {resolveStatusLabel(status)}
        </Chip>
      </CardHeader>

      <CardBody className="px-7 pb-7 pt-5">
        <ProposalReviewBody
          proposal={p}
          sourceExits={sourceExits}
          workspaceName={workspaceName}
          identity={identity}
          onDecided={() => void query.refetch()}
          barClassName="bottom-0 pt-4"
        />
      </CardBody>
    </>,
    openInApp
  );
}
