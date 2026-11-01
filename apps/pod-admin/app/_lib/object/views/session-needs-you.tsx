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
 *   • A criterion's grade (`CriterionGrade`) — an escalated criterion's slot
 *     is graded under the criterion in the page's rail, through that same
 *     `AskAnswer`, and Needs you then leaves it out (`gradedInRail`), so the
 *     reader meets each grade once.
 *   • Proposed changes — the pending proposals filed in this session
 *     (`proposals.list({ sessionId, status: "pending" })`), each a door to its
 *     review at `/proposal/<id>`. Never approved from the row: the review page
 *     is where a twin or a removal is shown before anyone decides.
 *
 * Both are OMITTED when nothing waits; a read that failed says so, with a
 * retry, and is never drawn as "nothing waits". A poll that fails after a
 * good read keeps the rows on screen (and any half-made answer in them) and
 * says beside them that the refresh failed.
 */

import { useState } from "react";
import { Button, Input, addToast } from "@heroui/react";
import { Check, X } from "lucide-react";
import { ASK_COPY, classifyAskRefusal } from "@synap-core/types/ask";
import Link from "next/link";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import {
  CRITERION_SLOT_KIND,
  isCriterionGradeAsk,
} from "@synap-core/types/focus-sessions";
import { trpc } from "../../../../lib/trpc";
import { formatRelative } from "../../../../lib/format";
import { ExitLink } from "../../../../lib/exit-link";
import { SectionCard } from "../../../(admin)/components/section-card";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import {
  AskAnswer,
  refreshAfterAnswer,
} from "../../../(admin)/review/_lib/ask-answer";
import {
  answerCall,
  askView,
  type AskSlot,
} from "../../../(admin)/review/_lib/ask-detail";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { ErrorNote } from "../../copy-button";
import {
  exitOf,
  liveAskSlot,
  reviewRows,
  type ReviewRow,
} from "../../../(admin)/review/_lib/review-rows";
import { proposalHeading } from "../../../proposal/[id]/proposal-heading";
import { proposalRequester } from "../../../proposal/[id]/proposal-requester";
import { proposalSubjectKind } from "../../../proposal/[id]/proposal-subject-kind";
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

/** Where a row pod admin cannot act on is acted on (decision 94cd8636). */
const ACT_ELSEWHERE = "Act on it in Relay or the Synap app.";

const DOOR =
  "rounded-sm text-[12.5px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const BOX =
  "rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10";

type SessionSignals = Parameters<typeof reviewRows>[0];

/** This session's asks, in the server's order — Review's rows, narrowed. */
function sessionAskRows(signals: SessionSignals): ReviewRow[] {
  return reviewRows(signals, new Map()).filter((r) => r.group === "asks");
}

/**
 * Each escalated criterion the person grades in place: criterion key → the
 * signal id of its owed slot. Only a slot whose ask IS the grade
 * (`isCriterionGradeAsk`) — the one `askSlotOf` lets the answer door take;
 * any other ask on a criterion slot stays a Needs you row that opens where it
 * is graded.
 */
export function criterionGradeSignals(
  signals: SessionSignals,
  sessionId: string
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of signals) {
    if (
      s.kind === "owed-slot" &&
      s.target?.kind === "session" &&
      s.target.id === sessionId &&
      s.slotKind === CRITERION_SLOT_KIND &&
      s.criterionKey &&
      isCriterionGradeAsk(s.ask)
    ) {
      out.set(s.criterionKey, s.id);
    }
  }
  return out;
}

/** The one needs-you read of a session; Needs you and each grade share it. */
function useSessionSignals(sessionId: string) {
  return trpc.signals.list.useQuery(
    { lens: "needs-you", sessionId, limit: NEEDS_YOU_LIMIT },
    { staleTime: 15_000, refetchInterval: 60_000, retry: false }
  );
}

export function NeedsYouSection({
  sessionId,
  gradedInRail,
}: {
  sessionId: string;
  /**
   * The criteria the page's rail grades (`CriterionGrade`): their slots are
   * answered there, so they are not drawn here a second time.
   */
  gradedInRail?: ReadonlySet<string>;
}) {
  const signals = useSessionSignals(sessionId);
  // Answered here: gone at once, until a read newer than the answer says
  // otherwise (the agent asked again, or the answer did not land).
  const [answeredAt, setAnsweredAt] = useState<Map<string, number>>(
    () => new Map()
  );
  const [all, setAll] = useState(false);
  useReauthOnUnauthorized(signals.error);

  if (signals.isLoading) return null;
  // A failed poll must never swap the rows (and a half-made answer) away.
  const failure = signals.error ? (
    <ResourceRowError
      message="What this session is waiting on you for couldn’t be read."
      onRetry={() => void signals.refetch()}
    />
  ) : null;
  const readAt = signals.dataUpdatedAt;
  const read = signals.data?.signals ?? [];
  const rows = sessionAskRows(read);
  const inRail = new Set(
    [...criterionGradeSignals(read, sessionId)]
      .filter(([criterionKey]) => gradedInRail?.has(criterionKey))
      .map(([, signalId]) => signalId)
  );
  const owed = rows.filter(
    (r) => !inRail.has(r.key) && (answeredAt.get(r.key) ?? -1) < readAt
  );
  if (owed.length === 0) {
    return failure ? (
      <SectionCard variant="flat" title="Needs you">
        {failure}
      </SectionCard>
    ) : null;
  }
  const settle = (key: string) =>
    setAnsweredAt((prev) => new Map(prev).set(key, Date.now()));
  const shown = all ? owed : owed.slice(0, ASKS_SHOWN);

  return (
    <SectionCard
      variant="flat"
      title="Needs you"
      hint={`${owed.length} waiting on you`}
    >
      {failure}
      <ul className="flex flex-col gap-3">
        {shown.map((row) => (
          <li key={row.key} className={`${BOX} px-4 pt-4`}>
            {row.detail?.kind === "ask" ? (
              <AskAnswer
                key={`${row.detail.sessionId}:${row.detail.label}`}
                slot={row.detail.slot}
                live={liveAskSlot(rows, row.detail)}
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
 * A criterion's grade, drawn under the criterion in the page's rail: two
 * buttons, Pass and Fail, each the whole answer (founder, 2026-10-30: "just
 * two clicks"). The statement above already says what is graded, so nothing
 * else is drawn: no asker line, no radio list, no Send answer. "Add a note"
 * opens one line that rides with the click, as the grade's rationale.
 *
 * The grade goes through `focusSessions.answerOutput` like any answer (the
 * pod records it as the grade, `gradeCriterionAsOwner`), with the fingerprint
 * of the ask the reader saw, so a question the agent changed is refused as
 * stale. Drawn only for a slot whose ask IS the grade (`criterionGradeSignals`,
 * `isCriterionGradeAsk`); nothing when no grade waits on the person. Its read
 * is Needs you's own (one query key, one request).
 */
export function CriterionGrade({
  sessionId,
  criterionKey,
}: {
  sessionId: string;
  criterionKey: string;
}) {
  const signals = useSessionSignals(sessionId);
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
  const read = signals.data?.signals ?? [];
  const signalId = criterionGradeSignals(read, sessionId).get(criterionKey);
  const row = signalId
    ? sessionAskRows(read).find((r) => r.key === signalId)
    : undefined;
  if (!row || row.detail?.kind !== "ask") return null;
  // Answered here: gone until a read newer than the answer says otherwise.
  if (answeredAt !== null && answeredAt >= signals.dataUpdatedAt) return null;
  return (
    <CriterionVerdictButtons
      key={`${row.detail.sessionId}:${row.detail.label}`}
      slot={row.detail.slot}
      onSettled={() => setAnsweredAt(Date.now())}
    />
  );
}

/** The grade's two buttons, in the order the ask lists them. */
function CriterionVerdictButtons({
  slot,
  onSettled,
}: {
  slot: AskSlot;
  onSettled: () => void;
}) {
  const utils = trpc.useUtils();
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const answer = trpc.focusSessions.answerOutput.useMutation({
    onSuccess: () => {
      refreshAfterAnswer(utils, slot.sessionId);
      onSettled();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      const refusal = classifyAskRefusal(err.message);
      if (refusal.kind === "failed") {
        setFailure(refusal.message);
        return;
      }
      addToast({
        title:
          refusal.kind === "ask_changed"
            ? ASK_COPY.askChanged
            : ASK_COPY.movedOn,
        color: "default",
      });
      refreshAfterAnswer(utils, slot.sessionId);
    },
  });
  const control = askView(slot).control;
  if (control.mode !== "choose") return null;

  const grade = (key: string) => {
    setFailure(null);
    const built = answerCall(slot, {
      type: "choose",
      key,
      other: "",
      note: note ?? "",
    });
    if (!built.ok) {
      setFailure(built.message);
      return;
    }
    answer.mutate(built.call);
  };

  return (
    <div className="mt-1 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {control.options.map((o) => {
          // A grade ask's option key IS its value (`askOptionKey`): pass / fail.
          const pass = o.key === "pass";
          return (
            <Button
              key={o.key}
              size="sm"
              radius="md"
              variant="flat"
              color={pass ? "success" : "danger"}
              startContent={
                pass ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />
              }
              isDisabled={answer.isPending}
              onPress={() => grade(o.key)}
            >
              {o.label}
            </Button>
          );
        })}
        {note === null && (
          <Button
            size="sm"
            radius="md"
            variant="light"
            isDisabled={answer.isPending}
            onPress={() => setNote("")}
          >
            Add a note
          </Button>
        )}
      </div>
      {note !== null && (
        <Input
          size="sm"
          aria-label="Note with your grade"
          placeholder="Why (optional), sent with Pass or Fail"
          value={note}
          onValueChange={setNote}
          isDisabled={answer.isPending}
          autoFocus
        />
      )}
      {failure && <ErrorNote message={failure} />}
    </div>
  );
}

/**
 * Something owed that is not answered here (a criterion to grade, a run to
 * look at): what it is, what it waits on, and its door. A door back to this
 * very session would lead nowhere new: pod admin runs the pod and cannot act
 * on it (decision 94cd8636), so the row says where the work is done, Relay or
 * the Synap app, beside the door into the app (founder, 2026-11-01, decision
 * 869b2cd6: keep the panel, explain the rows it cannot act on).
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
            <div
              data-acted-elsewhere=""
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
            >
              <span className="text-[12px] text-foreground/65">
                {ACT_ELSEWHERE}
              </span>
              <OpenInAppLink type="session" id={sessionId} />
            </div>
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
  const failure = list.error ? (
    <ResourceRowError
      message="The changes this session proposed couldn’t be read."
      onRetry={() => void list.refetch()}
    />
  ) : null;
  const items = list.data?.items ?? [];
  if (items.length === 0) {
    return failure ? (
      <SectionCard variant="flat" title="Proposed changes">
        {failure}
      </SectionCard>
    ) : null;
  }
  const more = list.data?.pagination.hasMore ? "+" : "";
  const shown = all ? items : items.slice(0, PROPOSALS_SHOWN);

  return (
    <SectionCard
      variant="flat"
      title="Proposed changes"
      hint={`${items.length}${more} waiting for review`}
    >
      {failure}
      <ul className="flex flex-col">
        {shown.map((p) => {
          const payload = p.request?.data ?? p.data;
          const { heading } = proposalHeading(p, payload);
          const kind = proposalSubjectKind(p, payload);
          const Icon = kindIcon(kind);
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
                    kindLabel(kind),
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
