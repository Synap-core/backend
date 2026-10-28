"use client";

/**
 * What the session a proposal came from is FOR — drawn by the review under
 * its provenance line, in both hosts (the `/proposal` page and Review's
 * drawer). And, for the page alone, what to do once this one is decided.
 * Every rule lives in `proposal-session-model.ts`; this file only reads and
 * draws.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Button, Skeleton } from "@heroui/react";
import {
  ArrowRight,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  Inbox,
  Target,
  type LucideIcon,
} from "lucide-react";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { navHref } from "../../../lib/console-nav";
import { openIn, type Exit } from "../../../lib/open-in";
import {
  ExitFallback,
  PlacedFallback,
  rowHref,
  useAppOpenAttempt,
  usePlacedExit,
} from "../../../lib/exit-link";
import { kindIcon } from "../../_lib/object/kind-icon";
import { Pill } from "../../_lib/object/provenance-chips";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import type { TrpcErrorLike } from "../../_lib/object/load-failure";
import type { StatusKind } from "../../(admin)/components/status-pill";
import {
  NEEDS_YOU_PAGE_LIMIT,
  reviewRows,
  type ProposalFacts,
} from "../../(admin)/review/_lib/review-rows";
import {
  afterDecision,
  onSessionReview,
  othersWaiting,
  readOf,
  sessionContext,
  sessionReviewHref,
  waitingLabel,
} from "./proposal-session-model";

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

/** The verdict's tone as a glyph — the status palette `StatusPill` draws. */
const VERDICT_ICON: Record<StatusKind, { icon: LucideIcon; tone: string }> = {
  healthy: { icon: CircleCheck, tone: "text-status-healthy" },
  down: { icon: CircleX, tone: "text-status-down" },
  stale: { icon: CircleDashed, tone: "text-status-stale" },
  unknown: { icon: CircleDashed, tone: "text-foreground/55" },
};

const ICON = "h-3.5 w-3.5 shrink-0 text-foreground/55";

/**
 * The session's goal, its criteria progress, its track and project (doors),
 * and how much more from it waits for this reader (a door to Review, filtered
 * to it). Mounted only when `proposals.source` named a session — i.e. one
 * this reader may read.
 */
export function ProposalSessionContext({
  sessionId,
  proposalId,
}: {
  sessionId: string;
  proposalId: string;
}) {
  // The session page's own read and query key: opening the session after
  // this costs nothing.
  const sessionQuery = trpc.focusSessions.get.useQuery(
    { id: sessionId },
    { retry: false }
  );
  const session = readOf(sessionQuery);
  const ctx = session.state === "ok" ? sessionContext(session.value) : null;
  const trackId = ctx?.trackId ?? null;
  const trackQuery = trpc.tracks.get.useQuery(
    { id: trackId ?? "" },
    { enabled: !!trackId, retry: false }
  );
  const track = readOf(trackQuery, !!trackId);
  const waitingQuery = trpc.signals.list.useQuery(
    { lens: "needs-you", sessionId, limit: NEEDS_YOU_PAGE_LIMIT },
    { staleTime: 15_000, retry: false }
  );
  const waiting = readOf(waitingQuery);
  useReauthOnUnauthorized(
    sessionQuery.error as TrpcErrorLike,
    trackQuery.error as TrpcErrorLike,
    waitingQuery.error as TrpcErrorLike
  );
  const onThisReview = onSessionReview(
    usePathname(),
    useSearchParams()?.get("session") ?? null,
    sessionId
  );

  if (session.state === "absent") return null;
  if (session.state === "loading") {
    // The strip's own shape: a goal line, then a row of chips.
    return (
      <div aria-hidden className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-3/4 rounded-md" />
        <div className="flex gap-1.5">
          <Skeleton className="h-7 w-36 rounded-full" />
          <Skeleton className="h-7 w-24 rounded-full" />
          <Skeleton className="h-7 w-28 rounded-full" />
        </div>
      </div>
    );
  }
  if (session.state === "failed" || !ctx) {
    return (
      <Unread
        text="This session couldn’t be read."
        onRetry={() => void sessionQuery.refetch()}
      />
    );
  }

  const sessionExit = openIn({
    kind: "object",
    objectKind: "session",
    id: sessionId,
  });
  const trackExit =
    track.state === "ok"
      ? openIn({ kind: "object", objectKind: "track", id: track.value.id })
      : undefined;
  const projectExit =
    ctx.project?.kind === "named"
      ? openIn({ kind: "object", objectKind: "project", id: ctx.project.id })
      : undefined;
  // One fallback beneath the strip, as the provenance line does: a track and
  // a project open in the desktop app.
  const fallbackExit: Exit | undefined = [trackExit, projectExit].find(
    (e) => e?.isDesktopLink
  );
  const rows =
    waiting.state === "ok" ? reviewRows(waiting.value.signals, NO_FACTS) : [];
  const more =
    waiting.state === "ok" && !onThisReview
      ? waitingLabel(
          othersWaiting(rows, proposalId),
          waiting.value.signals.length >= NEEDS_YOU_PAGE_LIMIT
        )
      : null;
  // Criteria and project ride the session read; the track and the count are
  // their own. One line names the gap, one Retry re-asks each failed read.
  const sessionPartFailed =
    ctx.criteria === "unreadable" || ctx.project?.kind === "unreadable";
  const failed = [
    sessionPartFailed ? sessionQuery : null,
    track.state === "failed" ? trackQuery : null,
    waiting.state === "failed" ? waitingQuery : null,
  ].filter((q) => q !== null);
  const verdict = ctx.criteria === "unreadable" ? null : ctx.criteria;
  const TrackIcon = kindIcon("track");
  const ProjectIcon = kindIcon("project");

  return (
    <div
      role="group"
      aria-label="What this session is for"
      data-review-session=""
      className="flex flex-col gap-1.5"
    >
      {ctx.goal && (
        <p className="flex min-w-0 items-start gap-1.5 text-[12.5px] leading-snug text-foreground/70">
          <Target aria-hidden className={`mt-0.5 ${ICON}`} />
          <span className="line-clamp-2">{ctx.goal}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {verdict && (
          <Pill exit={sessionExit} title={verdict.state}>
            <VerdictIcon kind={verdict.kind} />
            <span className="truncate tabular-nums">{verdict.label}</span>
          </Pill>
        )}
        {track.state === "ok" && (
          <Pill exit={trackExit} title={resolveObjectNoun("track")}>
            <TrackIcon aria-hidden className={ICON} />
            <span className="truncate">{track.value.name}</span>
          </Pill>
        )}
        {ctx.project?.kind === "named" && (
          <Pill exit={projectExit} title={resolveObjectNoun("project")}>
            <ProjectIcon aria-hidden className={ICON} />
            <span className="truncate">{ctx.project.name}</span>
          </Pill>
        )}
        {more && (
          <Pill
            exit={{ href: sessionReviewHref(sessionId), isDesktopLink: false }}
            title="Review what else this session waits on"
          >
            <Inbox aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="truncate tabular-nums">{more}</span>
          </Pill>
        )}
      </div>
      {failed.length > 0 && (
        <Unread
          text="Part of this session couldn’t be read."
          onRetry={() => failed.forEach((q) => void q.refetch())}
        />
      )}
      {fallbackExit && <ExitFallback exit={fallbackExit} showWeb={false} />}
    </div>
  );
}

function VerdictIcon({ kind }: { kind: StatusKind }) {
  const { icon: Icon, tone } = VERDICT_ICON[kind];
  return <Icon aria-hidden className={`h-3.5 w-3.5 shrink-0 ${tone}`} />;
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
      <DoorButton
        exit={openIn({
          kind: "object",
          objectKind: "proposal",
          id: after.proposalId,
        })}
        marker={after.proposalId}
        focus={focus}
      >
        Next: {after.title}
      </DoorButton>
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
