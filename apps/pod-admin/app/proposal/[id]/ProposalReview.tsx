"use client";

import { useEffect, type ReactNode } from "react";
import { CardBody, CardHeader, Chip, Spinner } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { openIn } from "../../../lib/open-in";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../lib/exit-link";
import { ReceiverShell } from "../../_lib/receiver-shell";
/* Relative time is NOT vocabulary — `.claude/rules/vocabulary.md` excludes
   date/duration formatting on purpose. The shared helper accepts
   `Date | string`: `createdAt` is typed `Date` through superjson, and a helper
   that only accepts `Date` would be a lie the day a plain-JSON path feeds this
   page. */
import { formatRelative } from "../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { proposalHeading } from "./proposal-heading";
import {
  ProposalDecision,
  proposalRequestedParts,
  useProposalReview,
} from "./ProposalReviewCard";

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
  /* `requested` is opt-in for the same reason `footer` is: the loading,
     not-found and unauthorized cards have no request to describe, and a
     provenance line rendered over nothing is the guess this page exists to
     avoid. */
  const shell = (
    children: ReactNode,
    footer?: ReactNode,
    requested?: ReactNode
  ) => (
    <ReceiverShell
      podHost={podHost}
      identity={identity}
      requested={requested}
      footer={footer}
    >
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
  const requestedParts = proposalRequestedParts(
    p,
    workspaceName,
    formatRelative
  );
  const requested =
    requestedParts.length > 0 ? (
      <p className="text-[12px] text-foreground/65">
        {requestedParts.join(" · ")}
      </p>
    ) : undefined;

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

      <CardBody className="px-7 pb-7 pt-5">
        <ProposalDecision
          proposal={p}
          sourceExits={sourceExits}
          onDecided={() => void query.refetch()}
        />
      </CardBody>
    </>,
    openInApp,
    requested
  );
}
