"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CardBody, Spinner } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import { trpc } from "../../../lib/trpc";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { DECISION_BAR_PIN } from "../../_lib/review/decision-bar";
import { ReviewHeader } from "../../_lib/review/review-header";
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

  const status = reviewStatus(p);
  /* The heading names what APPROVING WILL DO, so the verb is imperative —
     "Create workspace", not "Created workspace". Until 2026-09-06 this printed
     `p.proposalType` verbatim, so the highest-stakes page in the product, the
     one a stranger reaches from an email, greeted them with `entity.create`.
     That exact leak is named in .claude/rules/vocabulary.md. */
  const { heading } = proposalHeading(p, p.request.data ?? p.data);

  return shell(
    <>
      <ReviewHeader icon={ShieldCheck} heading={heading} status={status} />

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
