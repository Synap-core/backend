"use client";

/**
 * What the session a proposal came from is FOR — drawn by the review under
 * its provenance line, in both hosts (the `/proposal` page and Review's
 * drawer). And, for the page alone, the next waiting proposal once this one
 * is decided. Every rule lives in `proposal-session-model.ts`; this file only
 * reads and draws.
 */

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
import { openIn, type Exit } from "../../../lib/open-in";
import { ExitFallback, rowHref, usePlacedExit } from "../../../lib/exit-link";
import { kindIcon } from "../../_lib/object/kind-icon";
import { Pill } from "../../_lib/object/provenance-chips";
import {
  reviewRows,
  type ProposalFacts,
} from "../../(admin)/review/_lib/review-rows";
import {
  WAITING_LIMIT,
  nextWaitingProposal,
  othersWaiting,
  readOf,
  sessionContext,
  sessionReviewHref,
  waitingLabel,
  type CriteriaMark,
} from "./proposal-session-model";

/** Review reads its rows without the per-proposal facts it needs for verbs. */
const NO_FACTS: ReadonlyMap<string, ProposalFacts> = new Map();

/** A part that could not be read: said, with its retry — never left out. */
function Unread({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-status-down">
      {text}
      <Button
        size="sm"
        variant="light"
        className="h-6 min-w-0 px-1.5 text-[12px]"
        onPress={onRetry}
      >
        Retry
      </Button>
    </span>
  );
}

const CRITERIA_ICON: Record<
  Extract<CriteriaMark, { kind: "progress" }>["tone"],
  { icon: LucideIcon; tone: string }
> = {
  success: { icon: CircleCheck, tone: "text-success" },
  warning: { icon: CircleX, tone: "text-warning" },
  default: { icon: CircleDashed, tone: "text-foreground/55" },
};

/**
 * The session's goal (one line), its criteria progress, its track and
 * project (doors), and how much more from it waits for this reader (a door
 * to Review, filtered to it). Mounted only when `proposals.source` named a
 * session — i.e. one this reader may read.
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
    { lens: "needs-you", sessionId, limit: WAITING_LIMIT },
    { staleTime: 15_000, retry: false }
  );
  const waiting = readOf(waitingQuery);

  if (session.state === "absent") return null;
  if (session.state === "loading") {
    return (
      <div aria-hidden className="flex flex-col gap-1.5 pl-3">
        <Skeleton className="h-4 w-2/3 rounded-md" />
        <Skeleton className="h-6 w-1/2 rounded-full" />
      </div>
    );
  }
  if (session.state === "failed" || !ctx) {
    return (
      <div className="border-l-2 border-foreground/10 pl-3">
        <Unread
          text="This session’s goal couldn’t be read."
          onRetry={() => void sessionQuery.refetch()}
        />
      </div>
    );
  }

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
    waiting.state === "ok"
      ? waitingLabel(
          othersWaiting(rows, proposalId),
          waiting.value.signals.length >= WAITING_LIMIT
        )
      : null;
  const TrackIcon = kindIcon("track");
  const ProjectIcon = kindIcon("project");

  return (
    <div
      role="group"
      aria-label="What this session is for"
      data-review-session=""
      className="flex flex-col gap-1.5 border-l-2 border-foreground/10 pl-3"
    >
      {ctx.goal && (
        <p
          title={ctx.goal}
          className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-foreground/70"
        >
          <Target
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-foreground/55"
          />
          <span className="truncate">{ctx.goal}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {ctx.criteria?.kind === "progress" && (
          <CriteriaPill mark={ctx.criteria} />
        )}
        {ctx.criteria?.kind === "unreadable" && (
          <Unread
            text="Its criteria couldn’t be read."
            onRetry={() => void sessionQuery.refetch()}
          />
        )}
        {track.state === "ok" && (
          <Pill exit={trackExit} title={resolveObjectNoun("track")}>
            <TrackIcon aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
            <span className="truncate">{track.value.name}</span>
          </Pill>
        )}
        {track.state === "failed" && (
          <Unread
            text="Its track couldn’t be read."
            onRetry={() => void trackQuery.refetch()}
          />
        )}
        {ctx.project?.kind === "named" && (
          <Pill exit={projectExit} title={resolveObjectNoun("project")}>
            <ProjectIcon
              aria-hidden
              className="h-3.5 w-3.5 text-foreground/55"
            />
            <span className="truncate">{ctx.project.name}</span>
          </Pill>
        )}
        {ctx.project?.kind === "unreadable" && (
          <Unread
            text="Its project couldn’t be read."
            onRetry={() => void sessionQuery.refetch()}
          />
        )}
        {more && (
          <Pill
            exit={{ href: sessionReviewHref(sessionId), isDesktopLink: false }}
          >
            <Inbox aria-hidden className="h-3.5 w-3.5 text-primary" />
            <span className="truncate">{more}</span>
          </Pill>
        )}
        {waiting.state === "failed" && (
          <Unread
            text="What else waits here couldn’t be read."
            onRetry={() => void waitingQuery.refetch()}
          />
        )}
      </div>
      {fallbackExit && <ExitFallback exit={fallbackExit} showWeb={false} />}
    </div>
  );
}

function CriteriaPill({
  mark,
}: {
  mark: Extract<CriteriaMark, { kind: "progress" }>;
}) {
  const { icon: Icon, tone } = CRITERIA_ICON[mark.tone];
  return (
    <Pill>
      <Icon aria-hidden className={`h-3.5 w-3.5 ${tone}`} />
      <span className="truncate">{mark.label}</span>
    </Pill>
  );
}

// ─── Next (the /proposal page) ───────────────────────────────────────────────

/**
 * After a decision on the `/proposal` page: a door to the next waiting
 * proposal, in Review's order (`nextWaitingProposal`), so a reviewer in an
 * overlay keeps going without navigating back. None left is the good outcome,
 * said calmly. Reads the SAME `signals.list` Review reads (its query key too).
 */
export function NextWaitingProposal({ proposalId }: { proposalId: string }) {
  const query = trpc.signals.list.useQuery(
    { lens: "needs-you", limit: WAITING_LIMIT },
    { staleTime: 15_000, retry: false }
  );
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
  const next = nextWaitingProposal(
    reviewRows(read.value.signals, NO_FACTS),
    proposalId
  );
  if (!next) {
    return (
      <p
        data-review-next="none"
        className="inline-flex items-center gap-1.5 text-[12.5px] text-foreground/70"
      >
        <Check aria-hidden className="h-3.5 w-3.5 text-success" />
        No other proposal waits for you.
      </p>
    );
  }
  return <NextDoor next={next.proposalId} title={next.title} />;
}

function NextDoor({ next, title }: { next: string; title: string }) {
  const href = rowHref(
    usePlacedExit(openIn({ kind: "object", objectKind: "proposal", id: next }))
  );
  if (href === null) return null;
  return (
    <Button
      as="a"
      href={href}
      data-review-next={next}
      color="primary"
      variant="flat"
      className="min-h-10 max-w-full justify-start self-start"
      endContent={<ArrowRight aria-hidden size={16} />}
    >
      <span className="truncate">Next: {title}</span>
    </Button>
  );
}
