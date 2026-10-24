"use client";

/**
 * What a session waits on the reader for, on the session's own page — the
 * two sections under its header (Session room order: header → Needs you →
 * Produced → Happening):
 *
 *   • Needs you — the AI's questions and blockers for THIS session. ONE read:
 *     `signals.list({ lens: "needs-you", sessionId })`, the population Review
 *     reads narrowed to the session, shaped by Review's own rows
 *     (`reviewRows`). A question on a slot is answered in place by the SAME
 *     `AskAnswer` Review's detail draws — the same doors, the same stale and
 *     refusal handling; never a second answer path. Anything else owed opens
 *     where it is decided.
 *   • Proposed changes — the pending proposals filed in this session
 *     (`proposals.list({ sessionId, status: "pending" })`), each a door to its
 *     review at `/proposal/<id>`. Never approved from the row: the review page
 *     is where a twin or a removal is shown before anyone decides.
 *
 * Both are OMITTED when nothing waits; a read that failed says so, with a
 * retry, and is never drawn as "nothing waits".
 */

import { useState } from "react";
import Link from "next/link";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { formatRelative } from "../../../../lib/format";
import { ExitLink } from "../../../../lib/exit-link";
import { SectionCard } from "../../../(admin)/components/section-card";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { AskAnswer } from "../../../(admin)/review/_lib/ask-answer";
import {
  exitOf,
  liveAskSlot,
  reviewRows,
  type ReviewRow,
} from "../../../(admin)/review/_lib/review-rows";
import { proposalHeading } from "../../../proposal/[id]/proposal-heading";
import { proposalRequester } from "../../../proposal/[id]/proposal-requester";
import { objectPage } from "../content/markdown-model";
import { kindIcon, kindLabel } from "../kind-icon";
import { OpenInAppLink } from "../open-in-app-link";
import { useReauthOnUnauthorized } from "../use-reauth";

/** The most rows one needs-you read returns (Review's page size). */
const NEEDS_YOU_LIMIT = 100;
/** Questions drawn open before "Show all": each carries its whole answer. */
const ASKS_SHOWN = 3;
/** Pending proposals read for one session. */
const PROPOSALS_LIMIT = 100;
/** Proposals listed before "Show all". */
const PROPOSALS_SHOWN = 5;

const DOOR =
  "rounded-sm text-[12.5px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const BOX =
  "rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10";

/** This session's asks, in the server's order — Review's rows, narrowed. */
function sessionAskRows(
  signals: Parameters<typeof reviewRows>[0]
): ReviewRow[] {
  return reviewRows(signals, new Map()).filter((r) => r.group === "asks");
}

export function NeedsYouSection({ sessionId }: { sessionId: string }) {
  const signals = trpc.signals.list.useQuery(
    { lens: "needs-you", sessionId, limit: NEEDS_YOU_LIMIT },
    { staleTime: 15_000, refetchInterval: 60_000, retry: false }
  );
  // Answered here: gone at once, until a read newer than the answer says
  // otherwise (the agent asked again, or the answer did not land).
  const [answeredAt, setAnsweredAt] = useState<Map<string, number>>(
    () => new Map()
  );
  const [all, setAll] = useState(false);
  useReauthOnUnauthorized(signals.error);

  if (signals.isLoading) return null;
  if (signals.error) {
    return (
      <SectionCard variant="flat" title="Needs you">
        <ResourceRowError
          message="What this session is waiting on you for couldn’t be read."
          onRetry={() => void signals.refetch()}
        />
      </SectionCard>
    );
  }
  const readAt = signals.dataUpdatedAt;
  const rows = sessionAskRows(signals.data?.signals ?? []);
  const owed = rows.filter((r) => (answeredAt.get(r.key) ?? -1) < readAt);
  // negctl: always drawn
  const settle = (key: string) =>
    setAnsweredAt((prev) => new Map(prev).set(key, Date.now()));
  const shown = all ? owed : owed.slice(0, ASKS_SHOWN);

  return (
    <SectionCard
      variant="flat"
      title="Needs you"
      hint={`${owed.length} waiting on you`}
    >
      <ul className="flex flex-col gap-3">
        {shown.map((row) => (
          <li key={row.key} className={`${BOX} px-4 pt-4`}>
            {row.detail?.kind === "ask" ? (
              <AskAnswer
                key={`${row.detail.sessionId}:${row.detail.label}`}
                slot={row.detail.slot}
                live={liveAskSlot(rows, row.detail)}
                occurredAt={row.occurredAt}
                onSettled={() => settle(row.key)}
                onClose={() => settle(row.key)}
                sessionDoor={false}
              />
            ) : (
              <OwedRow row={row} sessionId={sessionId} />
            )}
          </li>
        ))}
      </ul>
      {!all && owed.length > ASKS_SHOWN && (
        <button type="button" onClick={() => setAll(true)} className={DOOR}>
          Show all {owed.length}
        </button>
      )}
    </SectionCard>
  );
}

/**
 * Something owed that is not answered here (a criterion to grade, a run to
 * look at): what it is, what it waits on, and its door. A door back to this
 * very session would lead nowhere new, so that one opens it in the app.
 */
function OwedRow({ row, sessionId }: { row: ReviewRow; sessionId: string }) {
  const Icon = kindIcon(row.nounKind);
  const door = row.detail?.kind === "open" ? row.detail.door : null;
  const here = door?.kind === "session" && door.id === sessionId;
  return (
    <div className="flex items-start gap-3 pb-4">
      <Icon
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-foreground/55"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="break-words text-[13px] font-medium text-foreground">
          {row.title}
        </p>
        {(row.reason || row.occurredAt) && (
          <p className="text-[12px] text-foreground/65">
            {[row.reason, formatRelative(row.occurredAt, { empty: "" })]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {door &&
          (here ? (
            <OpenInAppLink type="session" id={sessionId} />
          ) : (
            <ExitLink exit={exitOf({ kind: "open", door })} label="Open" />
          ))}
      </div>
    </div>
  );
}

export function ProposedChangesSection({ sessionId }: { sessionId: string }) {
  const list = trpc.proposals.list.useQuery(
    { sessionId, status: "pending", limit: PROPOSALS_LIMIT },
    { staleTime: 15_000, retry: false }
  );
  const [all, setAll] = useState(false);
  useReauthOnUnauthorized(list.error);

  if (list.isLoading) return null;
  if (list.error) {
    return (
      <SectionCard variant="flat" title="Proposed changes">
        <ResourceRowError
          message="The changes this session proposed couldn’t be read."
          onRetry={() => void list.refetch()}
        />
      </SectionCard>
    );
  }
  const items = list.data?.items ?? [];
  if (items.length === 0) return null;
  const more = list.data?.pagination.hasMore ? "+" : "";
  const shown = all ? items : items.slice(0, PROPOSALS_SHOWN);

  return (
    <SectionCard
      variant="flat"
      title="Proposed changes"
      hint={`${items.length}${more} waiting for review`}
    >
      <ul className="flex flex-col">
        {shown.map((p) => {
          const { heading } = proposalHeading(p, p.request?.data ?? p.data);
          const Icon = kindIcon(p.targetType);
          const href = objectPage("proposal", p.id);
          // `pending` reads both waiting and approved-but-failed-to-apply.
          const failed = p.status !== "pending";
          return (
            <li
              key={p.id}
              className="flex items-start gap-3 border-b border-foreground/[0.05] py-2 last:border-b-0"
            >
              <Icon
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-foreground/55"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {href ? (
                  <Link
                    href={href}
                    className="break-words rounded-sm text-[13px] text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {heading}
                  </Link>
                ) : (
                  <span className="break-words text-[13px] text-foreground/85">
                    {heading}
                  </span>
                )}
                <span className="text-[12px] text-foreground/65">
                  {[
                    kindLabel(p.targetType),
                    proposalRequester(p),
                    formatRelative(p.createdAt, { empty: "" }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              {failed && (
                <span className="shrink-0 text-[12px] text-warning">
                  {resolveStatusLabel(p.status)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {!all && items.length > PROPOSALS_SHOWN && (
        <button type="button" onClick={() => setAll(true)} className={DOOR}>
          Show all {items.length}
          {more}
        </button>
      )}
    </SectionCard>
  );
}
