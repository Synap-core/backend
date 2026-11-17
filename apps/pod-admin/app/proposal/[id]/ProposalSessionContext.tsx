"use client";

/**
 * For the `/proposal` page alone, what to do once this one is decided. (What
 * the session is FOR left the request page on 17 Nov 2026: pod admin is not
 * a work surface; the head's session chip is the door to it.) Every rule
 * lives in `proposal-session-model.ts`; this file only reads and draws.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { ArrowRight, Check } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { navHref } from "../../../lib/console-nav";
import { openIn, type Exit } from "../../../lib/open-in";
import {
  PlacedFallback,
  rowHref,
  useAppOpenAttempt,
  usePlacedExit,
} from "../../../lib/exit-link";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import type { TrpcErrorLike } from "../../_lib/object/load-failure";
import {
  NEEDS_YOU_PAGE_LIMIT,
  reviewRows,
  type ProposalFacts,
} from "../../(admin)/review/_lib/review-rows";
import { afterDecision, readOf } from "./proposal-session-model";

/** Review reads its rows without the per-proposal facts it needs for verbs. */
const NO_FACTS: ReadonlyMap<string, ProposalFacts> = new Map();

/**
 * What could not be read, said once, with ONE retry that re-asks every read
 * that failed — the pattern the console's other unreadable sections use
 * (`agent-object.tsx`), never a red line and a retry per part.
 */
function Unread({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-[12.5px] text-status-down">{text}</p>
      <Button size="sm" variant="flat" radius="md" onPress={onRetry}>
        Retry
      </Button>
    </div>
  );
}

// ─── After the decision (the /proposal page) ─────────────────────────────────

/**
 * Once this proposal is decided on the `/proposal` page: a door to the next
 * waiting proposal in Review's order, else a door to Review while other
 * things still wait there, else a calm done — so a reviewer in an overlay
 * keeps going without navigating back. Reads the SAME `signals.list` Review
 * reads (its query key too). `focus` moves the keyboard to the door the
 * moment the reader decided here.
 */
export function AfterDecision({
  proposalId,
  focus = false,
}: {
  proposalId: string;
  focus?: boolean;
}) {
  const query = trpc.signals.list.useQuery(
    { lens: "needs-you", limit: NEEDS_YOU_PAGE_LIMIT },
    { staleTime: 15_000, retry: false }
  );
  useReauthOnUnauthorized(query.error as TrpcErrorLike);
  const read = readOf(query);
  if (read.state === "loading" || read.state === "absent") return null;
  if (read.state === "failed") {
    return (
      <Unread
        text="What waits next couldn’t be read."
        onRetry={() => void query.refetch()}
      />
    );
  }
  const after = afterDecision(
    reviewRows(read.value.signals, NO_FACTS),
    proposalId,
    read.value.signals.length >= NEEDS_YOU_PAGE_LIMIT
  );
  if (after.kind === "next") {
    return (
      <QueueRow label="Next in your queue">
        <DoorButton
          exit={openIn({
            kind: "object",
            objectKind: "proposal",
            id: after.proposalId,
          })}
          marker={after.proposalId}
          focus={focus}
        >
          {after.title}
        </DoorButton>
      </QueueRow>
    );
  }
  if (after.kind === "review") {
    return (
      <DoorButton
        exit={{ href: navHref("review"), isDesktopLink: false }}
        marker="review"
        focus={focus}
      >
        <span className="tabular-nums">
          {after.capped ? `${after.count}+` : after.count} more waiting in
          Review
        </span>
      </DoorButton>
    );
  }
  // Worded like Review's own empty list ("Nothing is waiting on you.").
  return (
    <p
      data-review-next="none"
      className="inline-flex items-center gap-1.5 text-[12.5px] text-foreground/70"
    >
      <Check aria-hidden className="h-3.5 w-3.5 text-success" />
      Nothing else is waiting on you.
    </p>
  );
}

/**
 * The next item waiting on you, set apart from this proposal's own outcome
 * (what it created, its link) and named as the queue's: it is not a follow-up
 * of what was just decided.
 */
function QueueRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      data-review-queue=""
      className="mt-1 flex min-w-0 flex-col gap-1.5 border-t border-foreground/[0.06] pt-3"
    >
      <span className="text-[12.5px] font-medium text-foreground/70">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * The one primary once the decision is made. A device that cannot follow the
 * exit gets the fallback line `ExitLink` gives, never a silent nothing.
 */
function DoorButton({
  exit,
  marker,
  focus,
  children,
}: {
  exit: Exit;
  marker: string;
  focus: boolean;
  children: ReactNode;
}) {
  const placed = usePlacedExit(exit);
  const open = useAppOpenAttempt(placed);
  const href = rowHref(placed);
  // HeroUI types `ref` for the button it renders by default; with `as="a"`
  // the node is an anchor, so a callback ref takes it as an HTMLElement.
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  if (href === null) return <PlacedFallback placed={placed} />;
  return (
    <>
      <Button
        as="a"
        ref={(node: HTMLElement | null) => {
          ref.current = node;
        }}
        href={href}
        onPress={open.onOpen}
        data-review-next={marker}
        color="primary"
        variant="flat"
        className="min-h-10 max-w-full justify-start self-start"
        endContent={<ArrowRight aria-hidden size={16} />}
      >
        <span className="truncate">{children}</span>
      </Button>
      {open.offer}
    </>
  );
}
