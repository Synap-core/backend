"use client";

/**
 * WHERE ITS WORK STANDS — the work on a session or a thing, drawn on its page
 * (session page: the run itself; thing page: the sessions and runs on it).
 * ONE read: `lifecycle.statusOf({ ids: [id], include: ["work"] })`, shaped by
 * the pure model (`../work-model.ts`). Nothing here re-derives a stage, a
 * gate or a next move.
 *
 * Each item, attention first:
 *   1. a run that stopped before its last stage: "Stopped at Script", the
 *      stages left, why it stopped, and Continue (the door
 *      `focusSessions.continueRun`, offered only when the read says so);
 *   2. the gates waiting on a person: Approve / Send back, through the
 *      review's one decision path (`useProposalDecision`);
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
  asksOwed,
  gatesWaiting,
  holdLine,
  nextMoveLine,
  stagesLeftLine,
  workHold,
  workStages,
  workToShow,
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

export function WorkSection({
  subjectId,
  self,
  canAct,
  sessionHref,
}: {
  /** The session or thing whose work this is. */
  subjectId: string;
  /** The page IS the session: its item is not named or linked again. */
  self: boolean;
  /** The reader may move it (the owner): Continue, Approve, Send back. */
  canAct: boolean;
  /** A session's page in this frame; null = none to open. */
  sessionHref: (sessionId: string) => string | null;
}) {
  const query = trpc.lifecycle.statusOf.useQuery(
    { ids: [subjectId], include: ["work"] },
    { retry: false, staleTime: 15_000 }
  );
  useReauthOnUnauthorized(query.error);

  if (query.isLoading) return null;
  const answer = query.data?.[0] as unknown as { work?: WorkRead } | undefined;
  const shown = query.error
    ? { kind: "failed" as const }
    : workToShow(answer?.work);
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
              canAct={canAct}
              href={sessionHref(item.sessionId)}
              onMoved={() => void query.refetch()}
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
  canAct,
  href,
  onMoved,
}: {
  item: StatusOfWorkItem;
  self: boolean;
  canAct: boolean;
  href: string | null;
  onMoved: () => void;
}) {
  const utils = trpc.useUtils();
  const stages = workStages(item);
  const gates = gatesWaiting(item);
  const asks = asksOwed(item);
  const hold = workHold(item);
  const next = nextMoveLine(item);
  const left = stagesLeftLine(item);
  const cont = trpc.focusSessions.continueRun.useMutation({
    onSuccess: async (result) => {
      if (!result.ok) return;
      onMoved();
      await Promise.all([
        utils.focusSessions.get.invalidate({ id: item.sessionId }),
        utils.focusSessions.browse.invalidate(),
        utils.signals.invalidate(),
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
          {canAct && item.continue && (
            <div>
              <Button
                size="sm"
                radius="md"
                color="primary"
                variant="solid"
                isLoading={cont.isPending}
                onPress={() => cont.mutate({ sessionId: item.sessionId })}
              >
                {item.continue.label}
              </Button>
            </div>
          )}
          {refused && <ErrorNote message={refused} />}
        </div>
      )}
      {continued && (
        <p role="status" className="text-[12.5px] text-foreground/75">
          Continued
          {continued.at ? ` at ${continued.at.name}` : ""}: a new turn of the
          run started here.
          {continued.warnings.length > 0
            ? ` ${continued.warnings.join(" ")}`
            : ""}
        </p>
      )}

      {gates.map((g) => (
        <GateCard
          key={g.proposalId}
          stageName={g.stageName}
          proposalId={g.proposalId}
          canAct={canAct}
          onDecided={onMoved}
        />
      ))}

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

      {asks !== null && asks > 0 && (
        <p className="text-[12.5px] text-foreground/75">
          {asks === 1 ? "1 question waits" : `${asks} questions wait`} for you
          {self || !href ? (
            " in Needs you."
          ) : (
            <>
              {": "}
              <Link href={href} className={DOOR}>
                answer on the session
              </Link>
            </>
          )}
        </p>
      )}
      {asks === null && (
        <p className="text-[12.5px] text-status-down">
          What it asks of you couldn’t be read.
        </p>
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
        const Icon = POSITION_ICON[s.position];
        return (
          <li key={s.key} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="h-px w-3 bg-foreground/20" />
            )}
            <span
              className={[
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px]",
                s.position === "current"
                  ? "bg-primary/10 font-medium text-foreground ring-1 ring-inset ring-primary/30"
                  : s.position === "done"
                    ? "text-foreground/75"
                    : "text-foreground/55",
              ].join(" ")}
            >
              <Icon
                aria-hidden
                className="h-3 w-3 shrink-0"
                strokeWidth={2.25}
              />
              {s.name}
              <span className="sr-only">, {POSITION_WORD[s.position]}</span>
              {s.gate && s.gate.state !== "not_reached" && (
                <span className="inline-flex items-center gap-0.5 text-foreground/60">
                  {s.gate.state === "pending" ? (
                    <CirclePause aria-hidden className="h-3 w-3" />
                  ) : (
                    <Lock aria-hidden className="h-3 w-3" />
                  )}
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

/** A gate waiting on the person: Approve / Send back, the review's own path. */
function GateCard({
  stageName,
  proposalId,
  canAct,
  onDecided,
}: {
  stageName: string;
  proposalId: string;
  canAct: boolean;
  onDecided: () => void;
}) {
  const [decided, setDecided] = useState<"approved" | "sent_back" | null>(null);
  const decision = useProposalDecision(
    proposalId,
    () => {
      setDecided("approved");
      onDecided();
    },
    {
      onRejected: () => {
        setDecided("sent_back");
        onDecided();
      },
    }
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
              : "waits for your approval."}
        </span>
      </span>
      {canAct && !decided && (
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
