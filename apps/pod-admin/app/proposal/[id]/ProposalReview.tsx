"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CardBody, CardHeader, Chip, Spinner } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { openIn } from "../../../lib/open-in";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../lib/exit-link";
import { trpc } from "../../../lib/trpc";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { proposalHeading } from "./proposal-heading";
import {
  isActionable,
  ProposalReviewBody,
  reviewStatus,
  useProposalReview,
} from "./ProposalReviewCard";
import { AfterDecision } from "./ProposalSessionContext";
import { afterDecisionShown } from "./proposal-session-model";
import { proposalPageT } from "./copy";
import { requestReadFailure } from "./request-read-failure";
import { RequestUnreadable } from "./RequestUnreadable";

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
  expired: "default",
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
  const utils = trpc.useUtils();
  // Decided HERE — what `afterDecisionShown` reads.
  const [decided, setDecided] = useState(false);

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
  const t = proposalPageT();
  const appExit = openIn({
    kind: "objectInApp",
    objectKind: "proposal",
    id: proposalId,
  });
  const openInApp = <ExitLink exit={appExit} label={t("openInDesktop")} />;

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
  const shell = (children: ReactNode, footer?: ReactNode, pinsBar = false) => (
    <ReceiverShell
      podHost={podHost}
      identity={identity}
      footer={footer}
      pinsBar={pinsBar}
    >
      {children}
    </ReceiverShell>
  );

  if (query.isLoading) {
    return shell(
      <CardBody className="items-center gap-3 px-7 py-16">
        <Spinner label={t("read.loading")} />
      </CardBody>
    );
  }

  const p = query.data;
  const failure = requestReadFailure(query.error, !!p);
  if (failure || !p) {
    /* A read that failed may still open in the Synap app, where the work is
       done (decision 94cd8636). A missing request or a refusal answers the
       same there: no link into nothing. */
    return shell(
      <CardBody className="gap-4 px-7 py-8">
        <RequestUnreadable
          failure={failure}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
        {failure?.retry ? openInApp : null}
      </CardBody>
    );
  }

  const status = reviewStatus(p);
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

      {/* Clips nothing, so the decision bar pins to the window. */}
      <CardBody className="overflow-visible px-7 pb-7 pt-5">
        <ProposalReviewBody
          proposal={p}
          sourceExits={sourceExits}
          workspaceName={workspaceName}
          identity={identity}
          onDecided={() => {
            setDecided(true);
            // What waits — this session's count and the next door — moved.
            void utils.signals.invalidate();
            void query.refetch();
          }}
          barClassName={DECISION_BAR_PIN}
          /* The reader often arrives in an overlay (a Glance of `/open/<id>`)
             with no list behind it: once this one is decided, the next one
             is a door here, not a trip back to Review. */
          afterDecision={
            afterDecisionShown(decided, isActionable(status)) ? (
              <AfterDecision proposalId={p.id} focus={decided} />
            ) : undefined
          }
        />
      </CardBody>
    </>,
    openInApp,
    true
  );
}

/**
 * The decision bar pinned to the window's bottom: Approve and Reject stay in
 * reach under a long review (a 106-record capture read 34,545 px). Spans the
 * card body's padding, on the card's own ground made opaque (the page under
 * it plus the card's 4% tint), so nothing scrolls visibly beneath it.
 */
const DECISION_BAR_PIN =
  "bottom-0 -mx-7 bg-background bg-[linear-gradient(hsl(var(--heroui-foreground)/0.04),hsl(var(--heroui-foreground)/0.04))] px-7 py-3";
