"use client";

/**
 * One GOAL (a `project_tracks` row; people say "Goal") — drawn by
 * `/open/track/:id`. The page a goal link lands on: how close it is to done,
 * what its judge decides, and the work filed in it.
 *
 * Every decision is the shared goal model's (`@synap-core/types/goal`, the
 * desk's and the phone's): the header facts, the "Done when" rows and count,
 * which verbs this viewer has (the judge's Accept / Send back, Declare done,
 * the status moves), the verdict choice and how a write answered. This file
 * only lays them out (skills `ui-surface-design`, `lens-page`): Done when
 * first, then Drop it if, Who's on it, the goal's sessions.
 *
 * Reads: `tracks.get` (floored on the goal's project), `users.me` (who is
 * looking — no identity, no judge verb), `projects.get` (the project's name),
 * `focusSessions.list({ trackId })`. Writes: `tracks.acceptCriterion`,
 * `tracks.setStatus` (with `expectedStatus`), `tracks.reopen`. Editing the
 * goal, staffing it and its loop stay in the app ("Open in app").
 */

import {
  addToast,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Radio,
  RadioGroup,
  Textarea,
} from "@heroui/react";
import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import {
  goalViewFor,
  goalWriteFailure,
  readGoalWrite,
  verdictChoice,
  GOAL_VIEW_COPY,
  VERDICT_BAR_COPY,
  type GoalCriterionRow,
  type GoalStatusMove,
  type GoalView,
  type GoalWriteAct,
  type GoalWriteResult,
  type VerdictEnding,
} from "@synap-core/types/goal";
import type { TrackVerdict } from "@synap-core/types/units";
import { trpc } from "../../../../lib/trpc";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../(admin)/components/resource-row";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { CopyButton } from "../../copy-button";
import { couldNotLoad, loadFailure } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
import {
  GOAL_SESSIONS_CAP,
  goalPill,
  goalSessionRows,
  goalSummaryText,
  goalWriteNotice,
} from "../goal-page-model";
import type { ObjectFrame } from "./object-frame";

export function GoalObject({ id, frame }: { id: string; frame: ObjectFrame }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const query = trpc.tracks.get.useQuery({ id }, { retry: false });
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const projectId = query.data?.projectId ?? null;
  const project = trpc.projects.get.useQuery(
    { id: projectId ?? "" },
    { enabled: Boolean(projectId), retry: false, staleTime: 60_000 }
  );
  const sessions = trpc.focusSessions.list.useQuery(
    { trackId: id, order: "open_first", limit: GOAL_SESSIONS_CAP + 1 },
    { enabled: query.isSuccess, retry: false }
  );
  const acceptCriterion = trpc.tracks.acceptCriterion.useMutation();
  const setStatus = trpc.tracks.setStatus.useMutation();
  const reopen = trpc.tracks.reopen.useMutation();
  const [declaring, setDeclaring] = useState(false);
  useReauthOnUnauthorized(query.error, sessions.error);

  const goal = query.data;
  const viewerId = me.data?.id ?? null;
  const view = useMemo(
    () =>
      goal
        ? goalViewFor(goal, { viewer: { userId: viewerId, kind: "person" } })
        : null,
    [goal, viewerId]
  );

  if (query.isLoading) return frame.loading("Loading goal…");
  const fail = loadFailure(query.error, "Goal");
  if (fail || !goal || !view) {
    return frame.failure({
      kind: "track",
      id,
      failure: fail ?? couldNotLoad("Goal"),
    });
  }

  const refresh = () =>
    Promise.all([
      utils.tracks.get.invalidate({ id }),
      utils.focusSessions.list.invalidate({ trackId: id }),
    ]);

  /** Say how a write answered; a failure keeps the page and says so plainly. */
  const settle = async (
    act: GoalWriteAct,
    done: string,
    write: () => Promise<GoalWriteResult>
  ): Promise<GoalWriteResult | null> => {
    try {
      const result = await write();
      const notice = goalWriteNotice(done, result);
      addToast({ title: notice.title, color: "default" });
      await refresh();
      return result;
    } catch {
      addToast({ title: goalWriteFailure(act), color: "danger" });
      return null;
    }
  };

  const judge = (
    row: GoalCriterionRow,
    decision: "accepted" | "changes_asked",
    note?: string
  ) =>
    settle(
      decision === "accepted" ? "accept" : "send_back",
      decision === "accepted" ? "Accepted." : "Sent back.",
      async () =>
        readGoalWrite(
          await acceptCriterion.mutateAsync({
            id,
            criterionKey: row.key,
            decision,
            ...(note?.trim() ? { note: note.trim() } : {}),
          })
        )
    );

  const move = (m: Extract<GoalStatusMove, { kind: "move" }>) =>
    settle(
      m.verb === "pause" ? "pause" : m.verb === "resume" ? "resume" : "move",
      `${m.label} — done.`,
      async () =>
        readGoalWrite(
          await setStatus.mutateAsync({
            id,
            status: m.to,
            expectedStatus: goal.status as typeof m.to,
          })
        )
    );

  const reopenGoal = async () => {
    const result = await settle("reopen", "A new version is open.", async () =>
      readGoalWrite(await reopen.mutateAsync({ id }))
    );
    if (result?.goalId && result.goalId !== id) {
      router.push(
        openIn({ kind: "object", objectKind: "track", id: result.goalId }).href
      );
    }
  };

  const openSession = (sessionId: string) =>
    router.push(
      openIn({ kind: "object", objectKind: "session", id: sessionId }).href
    );

  const header = view.header;
  const projectName = project.data?.project.name ?? null;
  const plainMoves = view.moves.filter(
    (m): m is Extract<GoalStatusMove, { kind: "move" }> => m.kind === "move"
  );
  const reopenMove = view.moves.find((m) => m.kind === "reopen");
  const appExit = (
    <ExitLink
      exit={openIn({ kind: "objectInApp", objectKind: "track", id })}
      label="Open in app"
    />
  );
  const moving = setStatus.isPending;
  const reopening = reopen.isPending;

  return (
    <>
      {frame.object({
        header: {
          kind: "track",
          title: goal.name,
          summary: header.purpose ?? undefined,
          status: goalPill(header.status),
          breadcrumb: frame.breadcrumb?.(goal.name),
          primaryAction: view.declare ? (
            <Button
              size="sm"
              radius="md"
              color={view.declare.primary ? "primary" : "default"}
              variant={view.declare.primary ? "solid" : "flat"}
              onPress={() => setDeclaring(true)}
            >
              {view.declare.label}
            </Button>
          ) : (
            appExit
          ),
          secondaryActions: (
            <>
              {plainMoves.map((m) => (
                <Button
                  key={`${m.verb}-${m.to}`}
                  size="sm"
                  radius="md"
                  variant="flat"
                  isLoading={moving}
                  onPress={() => void move(m)}
                >
                  {m.label}
                </Button>
              ))}
              {reopenMove && (
                <Button
                  size="sm"
                  radius="md"
                  variant="flat"
                  isLoading={reopening}
                  onPress={() => void reopenGoal()}
                >
                  {reopenMove.label}
                </Button>
              )}
              {view.declare && appExit}
            </>
          ),
        },
        facts: [
          ...(projectName && projectId
            ? [
                {
                  label: "Project",
                  value: (
                    <Link
                      href={
                        openIn({
                          kind: "object",
                          objectKind: "project",
                          id: projectId,
                        }).href
                      }
                      className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                    >
                      {projectName}
                    </Link>
                  ),
                },
              ]
            : []),
          ...(header.owner?.label
            ? [{ label: header.owner.role, value: header.owner.name ?? "" }]
            : []),
          ...(header.judge?.label
            ? [{ label: header.judge.role, value: header.judge.name ?? "" }]
            : []),
          ...(view.count.label
            ? [{ label: "Done when", value: view.count.label }]
            : []),
          ...(header.kind
            ? [{ label: "Kind of work", value: header.kind.mark.label }]
            : []),
        ],
        factColumns: 3,
        children: (
          <div className="flex flex-col gap-6">
            {header.marks.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {header.marks.map((m) => (
                  <StatusPill key={m.state} {...goalPill(m)} />
                ))}
              </div>
            )}
            <DoneWhen view={view} onJudge={judge} onOpenSession={openSession} />
            {view.dropConditions && (
              <section className="flex flex-col gap-2">
                <h2 className="text-[13px] font-medium text-foreground">
                  {view.dropConditions.label}
                </h2>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-foreground/85">
                  {view.dropConditions.items.map((c) => (
                    <li key={c.key}>{c.text}</li>
                  ))}
                </ul>
              </section>
            )}
            <WhoIsOnIt view={view} />
            <section className="flex flex-col gap-2">
              <h2 className="text-[13px] font-medium text-foreground">
                Sessions
              </h2>
              {sessions.isLoading ? (
                <ResourceRowSkeleton count={2} />
              ) : sessions.isError ? (
                <ResourceRowError
                  message="Its sessions couldn’t be loaded."
                  onRetry={() => void sessions.refetch()}
                />
              ) : (
                <GoalSessions
                  rows={goalSessionRows(sessions.data ?? [])}
                  onOpen={openSession}
                  appExit={appExit}
                />
              )}
            </section>
            <div>
              <CopyButton
                text={goalSummaryText(goal.name, view)}
                label="Copy goal summary"
              />
            </div>
          </div>
        ),
        advanced: {
          ids: [
            { label: "Goal id", value: goal.id },
            { label: "Project id", value: goal.projectId },
          ],
          raw: goal,
        },
      })}
      {view.declare && (
        <DeclareDone
          open={declaring}
          onClose={() => setDeclaring(false)}
          view={view}
          onDeclare={async (declaration) => {
            const result = await settle(
              declaration.verdict === "retired"
                ? "retire"
                : declaration.to === "archived"
                  ? "drop"
                  : "close",
              "Declared.",
              async () =>
                readGoalWrite(
                  await setStatus.mutateAsync({
                    id,
                    status: declaration.to,
                    verdict: declaration.verdict,
                    expectedStatus: goal.status as typeof declaration.to,
                    ...(declaration.verdictReason
                      ? { verdictReason: declaration.verdictReason }
                      : {}),
                  })
                )
            );
            if (result) setDeclaring(false);
          }}
        />
      )}
    </>
  );
}

// ── Done when ───────────────────────────────────────────────────────────────

function DoneWhen({
  view,
  onJudge,
  onOpenSession,
}: {
  view: GoalView;
  onJudge: (
    row: GoalCriterionRow,
    decision: "accepted" | "changes_asked",
    note?: string
  ) => Promise<unknown>;
  onOpenSession: (id: string) => void;
}) {
  const { doneWhen, criteria, count, period } = view;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-foreground">Done when</h2>
        {count.label && (
          <span className="tabular text-[12.5px] text-foreground/65">
            {count.label}
          </span>
        )}
      </div>
      {doneWhen.endState && (
        <p className="text-[13.5px] leading-relaxed text-foreground/90">
          {doneWhen.endState}
        </p>
      )}
      {period && (
        <p className="flex items-center gap-2 text-[12.5px] text-foreground/75">
          {period.label}
          <StatusPill {...goalPill(period.markView)} />
        </p>
      )}
      {doneWhen.lasting && (
        <p className="text-[12.5px] text-foreground/65">
          {doneWhen.lasting.title}
          {doneWhen.lasting.tone === "explain"
            ? ` ${doneWhen.lasting.description}`
            : " Add them in the app."}
        </p>
      )}
      {criteria.length > 0 && (
        <ol className="flex flex-col divide-y divide-foreground/[0.06] rounded-lg ring-1 ring-inset ring-foreground/10">
          {criteria.map((row) => (
            <CriterionItem
              key={row.key}
              row={row}
              onJudge={onJudge}
              onOpenSession={onOpenSession}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function CriterionItem({
  row,
  onJudge,
  onOpenSession,
}: {
  row: GoalCriterionRow;
  onJudge: (
    row: GoalCriterionRow,
    decision: "accepted" | "changes_asked",
    note?: string
  ) => Promise<unknown>;
  onOpenSession: (id: string) => void;
}) {
  // The note the judge is writing: sending back (what should change) or
  // accepting an outside decision (who or what decided it).
  const [asking, setAsking] = useState<"send_back" | "source" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (decision: "accepted" | "changes_asked", text?: string) => {
    setBusy(true);
    try {
      await onJudge(row, decision, text);
      setAsking(null);
      setNote("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <StatusPill {...goalPill(row.mark)} />
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground">
          {row.statement}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-foreground/65">
        <span>{row.meaning.label}</span>
        {row.aboutMethod && <span>{GOAL_VIEW_COPY.aboutMethod}</span>}
        {!row.required && <span>{GOAL_VIEW_COPY.optional}</span>}
        {row.currentValue && <span>{row.currentValue}</span>}
      </div>
      {row.acceptance && (
        <p className="text-[12.5px] text-foreground/80">
          <span className="font-medium">{row.acceptance.label}</span>
          {row.acceptance.note ? ` — ${row.acceptance.note}` : ""}
        </p>
      )}
      {row.claim && (
        <div className="flex flex-col gap-1 rounded-md bg-foreground/[0.04] px-3 py-2 text-[12.5px] text-foreground/80">
          <span>
            {row.claim.by}
            {row.claim.session && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => onOpenSession(row.claim!.session!.id)}
                  className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {row.claim.session.title}
                </button>
              </>
            )}
          </span>
          {row.claim.evidence && (
            <span className="break-words text-foreground/70">
              {row.claim.evidence}
            </span>
          )}
          {row.claim.note && (
            <span className="break-words text-foreground/70">
              {row.claim.note}
            </span>
          )}
        </div>
      )}
      {(row.judgeable || row.acceptWithSource) && asking === null && (
        <div className="flex flex-wrap gap-2">
          {row.judgeable && (
            <>
              <Button
                size="sm"
                radius="md"
                color="primary"
                isLoading={busy}
                onPress={() => void run("accepted")}
              >
                Accept
              </Button>
              <Button
                size="sm"
                radius="md"
                variant="flat"
                onPress={() => setAsking("send_back")}
              >
                Send back
              </Button>
            </>
          )}
          {row.acceptWithSource && (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              onPress={() => setAsking("source")}
            >
              {GOAL_VIEW_COPY.acceptWithSource}
            </Button>
          )}
        </div>
      )}
      {asking && (
        <div className="flex flex-col gap-2">
          <Textarea
            minRows={1}
            label={
              asking === "send_back"
                ? GOAL_VIEW_COPY.sendBackAsk
                : GOAL_VIEW_COPY.sourceAsk
            }
            value={note}
            onValueChange={setNote}
            autoFocus
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              radius="md"
              color="primary"
              isDisabled={!note.trim()}
              isLoading={busy}
              onPress={() =>
                void run(
                  asking === "send_back" ? "changes_asked" : "accepted",
                  note
                )
              }
            >
              {asking === "send_back" ? "Send back" : "Accept"}
            </Button>
            <Button
              size="sm"
              radius="md"
              variant="light"
              onPress={() => {
                setAsking(null);
                setNote("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Who's on it ─────────────────────────────────────────────────────────────

function WhoIsOnIt({ view }: { view: GoalView }) {
  const rows = view.participants;
  // Not read: say so. The owner alone: the header already names them (OMIT).
  if (rows === null) {
    return (
      <p className="text-[12.5px] text-foreground/65">
        Who’s on it couldn’t be read.
      </p>
    );
  }
  if (rows.length <= 1) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[13px] font-medium text-foreground">Who’s on it</h2>
      <ul className="flex flex-col gap-2">
        {rows.map((p) => (
          <li
            key={p.key}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
          >
            <span className="font-medium text-foreground">
              {p.name ?? p.roles}
            </span>
            {p.name && <span className="text-foreground/65">{p.roles}</span>}
            {p.commitment && (
              <span className="text-foreground/75">· {p.commitment}</span>
            )}
            {p.commitmentMark && <StatusPill {...goalPill(p.commitmentMark)} />}
            {p.silence && <StatusPill {...goalPill(p.silence)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Sessions ────────────────────────────────────────────────────────────────

function GoalSessions({
  rows,
  onOpen,
  appExit,
}: {
  rows: ReturnType<typeof goalSessionRows>;
  onOpen: (id: string) => void;
  appExit: ReactNode;
}) {
  if (rows.length === 0) {
    return <ResourceRowEmpty message="No session is filed in this goal yet." />;
  }
  const shown = rows.slice(0, GOAL_SESSIONS_CAP);
  return (
    <div className="flex flex-col gap-2">
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        {shown.map((s) => (
          <ResourceRow
            key={s.id}
            Icon={MessageSquare}
            primary={s.title}
            status={s.status}
            onSelect={() => onOpen(s.id)}
            wrap
          />
        ))}
      </div>
      {rows.length > GOAL_SESSIONS_CAP && (
        <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-foreground/65">
          More sessions in this goal. {appExit}
        </p>
      )}
    </div>
  );
}

// ── Declare done ────────────────────────────────────────────────────────────

function DeclareDone({
  open,
  onClose,
  view,
  onDeclare,
}: {
  open: boolean;
  onClose: () => void;
  view: GoalView;
  onDeclare: (
    declaration: NonNullable<ReturnType<typeof verdictChoice>["declaration"]>
  ) => Promise<void>;
}) {
  const [ending, setEnding] = useState<VerdictEnding | null>(null);
  const [picked, setPicked] = useState<TrackVerdict | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const bar = verdictChoice({
    verdicts: view.verdicts,
    ending,
    picked,
    reason,
    replacementId: null,
  });
  const switchSide = () => {
    setEnding(bar.ending === "close" ? "drop" : "close");
    setPicked(null);
    setReason("");
  };
  return (
    <Modal isOpen={open} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{view.declare?.label}</ModalHeader>
        <ModalBody className="flex flex-col gap-4">
          {!bar.shown ? (
            <p className="text-[13px] text-foreground/75">
              {view.verdicts.refusal}
            </p>
          ) : (
            <>
              <RadioGroup
                label={bar.legend}
                value={picked ?? ""}
                onValueChange={(v) => setPicked(v as TrackVerdict)}
              >
                {bar.choices.map((c) => (
                  <Radio
                    key={c.verdict}
                    value={c.verdict}
                    isDisabled={c.unavailable !== null}
                    description={c.unavailable ?? c.consequence}
                  >
                    {c.label}
                  </Radio>
                ))}
              </RadioGroup>
              {bar.ask?.kind === "text" && (
                <Textarea
                  minRows={1}
                  label={bar.ask.label}
                  value={reason}
                  onValueChange={setReason}
                />
              )}
              {bar.ask?.kind === "goal" && (
                <p className="text-[12.5px] text-foreground/65">
                  {bar.ask.label} Pick it in the app.
                </p>
              )}
              {bar.switchLabel && (
                <div>
                  <Button size="sm" variant="light" onPress={switchSide}>
                    {bar.switchLabel}
                  </Button>
                </div>
              )}
            </>
          )}
        </ModalBody>
        <ModalFooter className="flex flex-wrap items-center justify-end gap-2">
          {bar.blocked && (
            <span className="mr-auto text-[12px] text-foreground/65">
              {bar.blocked}
            </span>
          )}
          <Button variant="light" onPress={onClose}>
            {VERDICT_BAR_COPY.notYet}
          </Button>
          <Button
            color="primary"
            isDisabled={!bar.declaration}
            isLoading={busy}
            onPress={async () => {
              if (!bar.declaration) return;
              setBusy(true);
              try {
                await onDeclare(bar.declaration);
              } finally {
                setBusy(false);
              }
            }}
          >
            {bar.confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
