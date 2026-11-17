"use client";

/**
 * WHERE ITS WORK STANDS — the work on a session or a thing, drawn on its page
 * (session page: the run itself; thing page: the sessions and runs on it).
 * ONE read: `lifecycle.statusOf({ ids: [id], include: ["work"] })`, shaped by
 * the pure model (`../work-model.ts`). Nothing here re-derives a stage, a
 * gate or a next move.
 *
 * Each item, attention first:
 *   1. the gates waiting on a person: Approve / Send back, through the
 *      review's one decision path (`useProposalDecision`), only when the
 *      read says this reader may decide it (`canReview`);
 *   2. a run that stopped before its last stage: "Stopped at Script", why it
 *      stopped, and Continue (the door `focusSessions.continueRun`), only
 *      when the read says THIS reader may (`continue.canAct`, the door's own
 *      check); flat while a gate or an ask still waits on them;
 *   3. the stages: done, current, left, each gated one with its gate's state;
 *   4. the hold, the asks it owes (answered on the session page, in Needs
 *      you) and the next move.
 * Empty: the section is OMITTED. A failed read says so, with a retry.
 * The run's ids sit in Advanced on the session page, never here.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import {
  Check,
  Circle,
  CircleDot,
  CirclePause,
  Lock,
  OctagonPause,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { StatusOfWorkItem } from "@synap-core/types/units";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { SectionCard } from "../../../(admin)/components/section-card";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { ErrorNote } from "../../copy-button";
import { useReauthOnUnauthorized } from "../use-reauth";
import { useProposalDecision } from "../../../proposal/[id]/use-proposal-decision";
import { objectPage } from "../content/markdown-model";
import {
  afterGateDecision,
  asksOwed,
  continueButton,
  continueEmphasis,
  gatesWaiting,
  holdLine,
  nextMoveLine,
  stagesLeftLine,
  workHold,
  workStages,
  workToShow,
  type GateDecided,
  type WorkRead,
  type WorkStageMark,
} from "../work-model";

const DOOR =
  "inline-flex min-w-0 items-center gap-1.5 rounded-sm text-[13px] [overflow-wrap:anywhere] text-foreground/80 underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

const POSITION_ICON: Record<WorkStageMark["position"], LucideIcon> = {
  done: Check,
  current: CircleDot,
  left: Circle,
};

const POSITION_WORD: Record<WorkStageMark["position"], string> = {
  done: "done",
  current: "current stage",
  left: "not reached",
};

/**
 * THE work read of one subject (`statusOf` include work). The session page
 * reads it too (the header's restart, the proposed-changes list): the same
 * query key, so one request serves both.
 */
export function useWorkRead(subjectId: string) {
  const query = trpc.lifecycle.statusOf.useQuery(
    { ids: [subjectId], include: ["work"] },
    { retry: false, staleTime: 15_000 }
  );
  const answer = query.data?.[0] as unknown as { work?: WorkRead } | undefined;
  return { query, read: answer?.work };
}

export function WorkSection({
  subjectId,
  self,
  sessionHref,
}: {
  /** The session or thing whose work this is. */
  subjectId: string;
  /** The page IS the session: its item is not named or linked again. */
  self: boolean;
  /** A session's page in this frame; null = none to open. */
  sessionHref: (sessionId: string) => string | null;
}) {
  const { query, read } = useWorkRead(subjectId);
  const utils = trpc.useUtils();
  useReauthOnUnauthorized(query.error);
  // A decision or a Continue moves this read, the proposals list beside it
  // (a decided gate leaves it) and the Needs you counts.
  const onMoved = () => {
    void query.refetch();
    void utils.proposals.list.invalidate();
    void utils.signals.invalidate();
  };

  if (query.isLoading) return null;
  const shown = query.error ? { kind: "failed" as const } : workToShow(read);
  if (shown.kind === "none") return null;
  const title = self ? "Where it stands" : "Work on it";
  if (shown.kind === "failed") {
    return (
      <SectionCard variant="flat" title={title}>
        <ResourceRowError
          message="Where its work stands couldn’t be read."
          onRetry={() => void query.refetch()}
        />
      </SectionCard>
    );
  }
  return (
    <SectionCard
      variant="flat"
      title={title}
      count={self ? null : shown.items.length}
      hint={shown.truncated ? "The most recent work on it." : undefined}
    >
      <ul className="flex flex-col gap-4">
        {shown.items.map((item) => (
          <li key={item.sessionId}>
            <WorkItem
              item={item}
              self={self}
              href={sessionHref(item.sessionId)}
              onMoved={onMoved}
            />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function WorkItem({
  item,
  self,
  href,
  onMoved,
}: {
  item: StatusOfWorkItem;
  self: boolean;
  href: string | null;
  onMoved: () => void;
}) {
  const utils = trpc.useUtils();
  const stages = workStages(item);
  const gates = gatesWaiting(item);
  const asks = asksOwed(item);
  const hold = workHold(item);
  const next = nextMoveLine(item);
  // The stepper draws the stages left; the sentence only stands without it.
  const left = stages && stages.length > 0 ? null : stagesLeftLine(item);
  const again = continueButton(item);
  const cont = trpc.focusSessions.continueRun.useMutation({
    onSuccess: async (result) => {
      if (!result.ok) return;
      onMoved();
      await Promise.all([
        utils.focusSessions.get.invalidate({ id: item.sessionId }),
        utils.focusSessions.browse.invalidate(),
      ]);
    },
  });
  useReauthOnUnauthorized(cont.error);
  const refused = cont.data && !cont.data.ok ? cont.data.message : null;
  const continued = cont.data?.ok ? cont.data : null;

  return (
    <div className="flex flex-col gap-2.5">
      {!self && (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {href ? (
            <Link href={href} className={DOOR}>
              {item.name || "Untitled session"}
            </Link>
          ) : (
            <span className="text-[13px] text-foreground/80">
              {item.name || "Untitled session"}
            </span>
          )}
          <span className="text-[12px] text-foreground/65">{item.label}</span>
        </div>
      )}

      {gates.map((g) => (
        <GateCard
          key={g.proposalId}
          stageName={g.stageName}
          proposalId={g.proposalId}
          canReview={g.canReview}
          onDecided={onMoved}
        />
      ))}

      {item.stopped && !continued && (
        <div
          className="flex flex-col gap-2 rounded-medium bg-warning/10 p-3 ring-1 ring-inset ring-warning/30"
          role="status"
        >
          <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            <OctagonPause
              aria-hidden
              className="h-4 w-4 shrink-0 text-warning"
            />
            {item.stopped.label}
          </span>
          {left && (
            <span className="text-[12.5px] text-foreground/75">{left}</span>
          )}
          {item.run && "id" in item.run && item.run.error && (
            <span className="text-[12.5px] text-foreground/65">
              {item.run.error}
            </span>
          )}
          {again && (
            <div>
              <Button
                size="sm"
                radius="md"
                color="primary"
                variant={continueEmphasis(item)}
                isLoading={cont.isPending}
                isDisabled={cont.isPending}
                onPress={() => {
                  if (cont.isPending) return;
                  cont.mutate({ sessionId: item.sessionId });
                }}
              >
                {again.label}
              </Button>
            </div>
          )}
          {refused && <ErrorNote message={refused} />}
        </div>
      )}
      {continued && (
        <div role="status" className="flex flex-col gap-1">
          <p className="text-[12.5px] text-foreground/75">
            Continued{continued.at ? ` from ${continued.at.name}` : ""}. It is
            working on it now.
          </p>
          {continued.warnings.map((w) => (
            <p key={w} className="text-[12.5px] text-warning-700">
              {w}
            </p>
          ))}
        </div>
      )}

      {stages === null ? (
        <ResourceRowError
          message="Its stages couldn’t be read."
          onRetry={onMoved}
        />
      ) : (
        stages.length > 0 && <StageList stages={stages} />
      )}

      {hold && (
        <p className="text-[12.5px] text-foreground/75">{holdLine(hold)}</p>
      )}

      {/* On the session page Needs you sits right below and answers them. */}
      {!self && asks !== null && asks > 0 && (
        <p className="text-[12.5px] text-foreground/75">
          {asks === 1 ? "1 question waits" : `${asks} questions wait`} on the
          session
          {href ? (
            <>
              {": "}
              <Link href={href} className={DOOR}>
                answer it there
              </Link>
            </>
          ) : (
            "."
          )}
        </p>
      )}
      {asks === null && (
        <ResourceRowError
          message="What it asks of you couldn’t be read."
          onRetry={onMoved}
        />
      )}

      {next && !(item.stopped && next.label === item.stopped.label) && (
        <p className="text-[12.5px] text-foreground/75">
          <span className="font-medium text-foreground">
            {next.yours ? "Your move: " : "Next: "}
          </span>
          {next.label}
        </p>
      )}
    </div>
  );
}

function StageList({ stages }: { stages: WorkStageMark[] }) {
  return (
    <ol
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
      aria-label="Stages"
    >
      {stages.map((s, i) => {
        const Icon = s.stoppedHere ? OctagonPause : POSITION_ICON[s.position];
        return (
          <li key={s.key} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="h-px w-3 bg-foreground/20" />
            )}
            <span
              className={[
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px]",
                s.stoppedHere
                  ? "bg-warning/10 font-medium text-foreground ring-1 ring-inset ring-warning/30"
                  : s.position === "current"
                    ? "bg-primary/10 font-medium text-foreground ring-1 ring-inset ring-primary/30"
                    : s.position === "done"
                      ? "text-foreground/75"
                      : "text-foreground/55",
              ].join(" ")}
            >
              <Icon
                aria-hidden
                className={[
                  "h-3 w-3 shrink-0",
                  s.stoppedHere ? "text-warning" : "",
                ].join(" ")}
                strokeWidth={2.25}
              />
              {s.name}
              <span className="sr-only">
                , {s.stoppedHere ? "stopped here" : POSITION_WORD[s.position]}
              </span>
              {s.gate && s.gate.state !== "not_reached" && (
                <span className="inline-flex items-center gap-0.5 text-foreground/60">
                  <GateIcon state={s.gate.state} />
                  <span className="sr-only">gate: </span>
                  {resolveStatusLabel(s.gate.state)}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** A gate's state as a mark: approved a check, sent back an undo, pending a pause. */
function GateIcon({ state }: { state: string }) {
  const Icon =
    state === "approved"
      ? Check
      : state === "rejected"
        ? Undo2
        : state === "pending"
          ? CirclePause
          : Lock;
  return <Icon aria-hidden className="h-3 w-3" />;
}

/**
 * A gate waiting on a person. Approve / Send back, the review's own path,
 * only when the read says THIS reader may decide it (`canReview`).
 */
function GateCard({
  stageName,
  proposalId,
  canReview,
  onDecided,
}: {
  stageName: string;
  proposalId: string;
  canReview: boolean;
  onDecided: () => void;
}) {
  const [decided, setDecided] = useState<GateDecided | null>(null);
  // The review's path calls `onRejected` and THEN the common callback: the
  // state follows `afterGateDecision`, and the page moves once.
  const decision = useProposalDecision(
    proposalId,
    () => {
      setDecided((d) => afterGateDecision(d, "decided"));
      onDecided();
    },
    { onRejected: () => setDecided((d) => afterGateDecision(d, "rejected")) }
  );
  const href = objectPage("proposal", proposalId);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-medium bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/10">
      <span className="min-w-0 flex-1 text-[13px] text-foreground">
        {href ? (
          <Link href={href} className={DOOR}>
            {stageName}
          </Link>
        ) : (
          stageName
        )}{" "}
        <span className="text-foreground/75">
          {decided === "approved"
            ? "approved."
            : decided === "sent_back"
              ? "sent back."
              : canReview
                ? "waits for your approval."
                : "waits for approval."}
        </span>
      </span>
      {canReview && !decided && (
        <span className="flex gap-2">
          <Button
            size="sm"
            radius="md"
            color="primary"
            variant="solid"
            isLoading={decision.approving}
            isDisabled={decision.busy && !decision.approving}
            onPress={() => decision.approve()}
          >
            Approve
          </Button>
          <Button
            size="sm"
            radius="md"
            variant="flat"
            isLoading={decision.rejecting}
            isDisabled={decision.busy && !decision.rejecting}
            onPress={() => decision.reject()}
          >
            Send back
          </Button>
        </span>
      )}
    </div>
  );
}
