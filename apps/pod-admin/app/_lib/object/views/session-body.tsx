"use client";

/**
 * One session — the ONE body, drawn in two frames: `/open/session/:id`
 * (the receiver card, any reader of the session) and `/sessions/:id` (the
 * console, with a breadcrumb back to the list). The frame owns only the
 * chrome — how loading, a failure and the page itself are wrapped, and where a
 * session lives in it; everything the reader sees and can do is decided here,
 * once, so the two pages cannot drift.
 *
 * Read door: `focusSessions.get` (user-floored; a member of a shared session
 * reads it too). `viewerRole` decides the acts — a member reads, never writes
 * (decision C), so a member sees no buttons at all rather than buttons that
 * fail. For the owner:
 *   • The status moves (`sessionMoves`, `../session-status.ts`): the next one
 *     is the header's primary — Accept on a draft, Close on a running
 *     session, Resume on a paused one, Start on an appointment — and the rest
 *     sit in the overflow menu. Each goes through its own door
 *     (`useSessionMoves`); ending moves (close, cancel, discard) confirm.
 *   • Run again — once it has ended: a NEW session that re-reads this one's
 *     stored sources, added on top (`mode: "add"`). The dry run answers first
 *     and its plan is the confirm's impact preview; `replace`
 *     (revert-then-rerun) stays in the app.
 *   • Revert — undo what this session applied. Secondary: in the danger zone.
 * The Intake Room (`?view=room`) is the app's; links to it keep bouncing.
 *
 * Under the header, top → down: who started it and where it lives (chips,
 * each a door); its room (the session channel, from the continuation packet's
 * `room` — a door to `/open/channel/:id`); what it owes (declared
 * deliverables) and its criteria; then what it left — its outputs
 * (`focusSessions.outputs`) and its report (`focusSessions.document`). Every
 * section with nothing in it is OMITTED; a section whose read failed says so.
 * All doors read through the same session floor as `get`.
 */

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
} from "@heroui/react";
import {
  Activity,
  Ban,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Layers,
  MoreHorizontal,
  Pause,
  Play,
  TriangleAlert,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import {
  resolveObjectNoun,
  resolveProvenanceLabel,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { trpc } from "../../../../lib/trpc";
import { openIn } from "../../../../lib/open-in";
import {
  formatRelative,
  formatTimestamp,
  isUuid,
} from "../../../../lib/format";
import { ConfirmModal } from "../../../(admin)/components/confirm-modal";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { ErrorNote, errorDetail } from "../../copy-button";
import {
  sessionCanCancel,
  sessionCanRevert,
  sessionSummary,
  shortDescription,
} from "../object-summaries";
import { kindIcon } from "../kind-icon";
import { AgentMark, Pill } from "../provenance-chips";
import {
  criterionRows,
  deliverableRows,
  draftSummary,
  holdsRun,
  sessionMoves,
  sessionRoom,
  sessionStarter,
  sessionStatusMark,
  type CriterionRow,
  type DeliverableRow,
  type SessionGlyph,
  type SessionMove,
  type SessionMoveKey,
  type SessionRoom,
  type SessionStarter,
} from "../session-status";
import { useSessionMoves } from "../use-session-moves";
import { couldNotLoad, loadFailure } from "../load-failure";
import { OpenInAppLink } from "../open-in-app-link";
import { useReauthOnUnauthorized } from "../use-reauth";
import type { ObjectFrame } from "./object-frame";
import { SectionCard } from "../../../(admin)/components/section-card";
import { ContentBlock, DocumentContentSection } from "../content/content-block";
import { documentContent } from "../content/document-model";
import { objectPage, prepareContent } from "../content/markdown-model";

/** Outputs listed here; the rest are in the app. */
const OUTPUTS_SHOWN = 20;
/** Deliverables and criteria shown before "Show all". */
const LIST_CAP = 5;

/** The mark's glyph, as an icon. */
const GLYPH_ICON: Record<SessionGlyph, LucideIcon> = {
  draft: CircleDashed,
  moving: Activity,
  paused: Pause,
  scheduled: Clock,
  done: Check,
  stopped: Ban,
  failed: TriangleAlert,
};

/** Each move's icon in the overflow menu. */
const MOVE_ICON: Record<SessionMoveKey, LucideIcon> = {
  accept: Check,
  discard: CircleX,
  start: Play,
  pause: Pause,
  resume: Play,
  close: CircleCheck,
  cancel: Ban,
};

export function SessionBody({ id, frame }: { id: string; frame: ObjectFrame }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const query = trpc.focusSessions.get.useQuery({ id }, { retry: false });
  const report = trpc.focusSessions.document.useQuery(
    { sessionId: id },
    { enabled: Boolean(query.data), retry: false }
  );
  const outputs = trpc.focusSessions.outputs.useQuery(
    { sessionId: id },
    { enabled: Boolean(query.data), retry: false }
  );
  // The space's name; a pod-wide session has none (`workspaceId` is TEXT,
  // `workspaces.get` takes a uuid — hence the guard).
  const workspaceId = query.data?.workspaceId ?? null;
  const workspace = trpc.workspaces.get.useQuery(
    { id: workspaceId ?? "" },
    { enabled: !!workspaceId && isUuid(workspaceId), retry: false }
  );
  // The room's name. Its messages come with the session (the packet's room).
  const channelId = query.data?.channelId ?? null;
  const channel = trpc.chat.getChannel.useQuery(
    { channelId: channelId ?? "", includeContext: false },
    { enabled: !!channelId, retry: false }
  );
  // A revert changes the session, the lists it sits in and what the pod says
  // needs attention.
  const invalidate = () =>
    Promise.all([
      utils.focusSessions.get.invalidate({ id }),
      utils.focusSessions.browse.invalidate(),
      utils.focusSessions.owed.invalidate(),
      utils.signals.invalidate(),
    ]);

  const moves = useSessionMoves(id);
  const [confirming, setConfirming] = useState<SessionMove | null>(null);

  // Two mutations, not one with a flag: the dry run's pending state must
  // never spin the real run's confirm button (`ConfirmModal.isPending`).
  const rerunPreview = trpc.focusSessions.rerun.useMutation();
  const rerun = trpc.focusSessions.rerun.useMutation({
    onSuccess: (result) => {
      if (result.ok && result.status !== "dry_run") {
        rerunPreview.reset();
        const next = frame.pathFor?.("session", result.sessionId);
        if (next) router.push(next);
      }
    },
  });
  const revert = trpc.focusSessions.revert.useMutation({
    onSuccess: invalidate,
  });

  useReauthOnUnauthorized(
    query.error,
    report.error,
    outputs.error,
    workspace.error,
    channel.error,
    ...moves.errors,
    rerunPreview.error,
    rerun.error,
    revert.error
  );

  if (query.isLoading) return frame.loading("Loading session…");
  const session = query.data;
  const fail = loadFailure(query.error, "Session");
  if (fail || !session) {
    return frame.failure({
      kind: "session",
      id,
      failure: fail ?? couldNotLoad("Session"),
    });
  }

  const title = resolveSessionTitle(session) || "Untitled session";
  const owner = session.viewerRole === "owner";
  const mark = sessionStatusMark(session);
  const { primary, more } = sessionMoves(session);
  const starter = sessionStarter(session);
  const room = sessionRoom(
    session.continuation.room,
    session.channelId,
    session.participants,
    owner
  );
  const evaluation = session.continuation.evaluation;
  const criteria =
    evaluation.status === "ok"
      ? criterionRows(evaluation.criteria, evaluation.evaluations)
      : [];
  const deliverables = deliverableRows(session.expectedOutputs);
  const project =
    session.continuation.project.status === "ok"
      ? session.continuation.project.project
      : null;
  // Picking a move that ends work opens its confirm; the rest go straight
  // through their door.
  const pick = (m: SessionMove) =>
    m.confirm ? setConfirming(m) : moves.run(m);
  const canRerun =
    owner && !sessionCanCancel(session.status) && session.rerun?.available;
  const canRevert = owner && sessionCanRevert(session.status);
  // Named, not inlined: `exit-door.test.ts` reads "Pending: x." as a dead
  // control naming a missing procedure.
  const reverting = revert.isPending;
  const goal = shortDescription(session.goal);
  const preview = rerunPreview.data;
  const refusal =
    rerun.data && !rerun.data.ok
      ? rerun.data.message
      : preview && !preview.ok
        ? preview.message
        : null;

  return frame.object({
    header: {
      breadcrumb: frame.breadcrumb?.(title),
      kind: "session",
      title,
      // Only the owner decides a draft, so only the owner is told how.
      summary:
        mark?.draft && owner
          ? draftSummary(starter, holdsRun(session.metadata))
          : sessionSummary(session),
      status: mark
        ? {
            kind: mark.kind,
            label: mark.label,
            icon: mark.glyph ? GLYPH_ICON[mark.glyph] : undefined,
          }
        : null,
      primaryAction: primary ? (
        <Button
          size="sm"
          radius="md"
          color="primary"
          variant="solid"
          isLoading={moves.pending === primary.key}
          isDisabled={moves.pending !== null && moves.pending !== primary.key}
          onPress={() => pick(primary)}
        >
          {primary.label}
        </Button>
      ) : canRerun ? (
        <Button
          size="sm"
          radius="md"
          color="primary"
          variant="flat"
          isLoading={rerunPreview.isPending}
          onPress={() =>
            rerunPreview.mutate({ sessionId: id, mode: "add", dryRun: true })
          }
        >
          Run again
        </Button>
      ) : undefined,
      secondaryActions: (
        <>
          {more.length > 0 && (
            <MoreMoves
              moves={more}
              busy={moves.pending !== null}
              onPick={pick}
            />
          )}
          <OpenInAppLink type="session" id={id} />
        </>
      ),
    },
    facts: [
      ...(session.createdAt
        ? [{ label: "Started", value: <When at={session.createdAt} /> }]
        : []),
      ...(session.closedAt
        ? [{ label: "Ended", value: <When at={session.closedAt} /> }]
        : session.updatedAt
          ? [{ label: "Updated", value: <When at={session.updatedAt} /> }]
          : []),
      ...(session.liveness?.status === "ok" &&
      session.liveness.lastAgentActivityAt
        ? [
            {
              label: "Agent last acted",
              value: <When at={session.liveness.lastAgentActivityAt} />,
            },
          ]
        : []),
    ],
    advanced: {
      ids: [
        { label: "Session id", value: session.id },
        ...(session.workspaceId
          ? [{ label: "Space id", value: session.workspaceId }]
          : []),
        ...(session.channelId
          ? [{ label: "Room id", value: session.channelId }]
          : []),
      ],
    },
    danger: canRevert
      ? [
          {
            key: "revert",
            label: "Revert this session",
            description: "Undo the changes this session applied.",
            consequence: (
              <>
                Every change this session applied is undone, newest first,
                through the same revert a single proposal uses. Anything edited
                since is left in place and named. A message or email it already
                sent cannot be unsent. The session itself stays, with a record
                of what was reverted.
              </>
            ),
            confirmLabel: "Revert changes",
            confirmColor: "danger",
            isPending: reverting,
            onConfirm: () => revert.mutateAsync({ sessionId: id }),
          },
        ]
      : undefined,
    children: (
      <>
        <Provenance
          starter={starter}
          space={
            session.workspaceId
              ? {
                  id: session.workspaceId,
                  name: workspace.data?.name ?? null,
                }
              : null
          }
          project={project}
        />
        {goal && goal !== title && (
          <p className="text-[13px] leading-relaxed text-foreground/80">
            {goal}
          </p>
        )}
        {!owner && (
          <p className="text-[12.5px] text-foreground/65">
            You can read this session. Only its owner can change it.
          </p>
        )}
        {revert.data && (
          <p className="text-[12.5px] text-foreground/65" role="status">
            Reverted {revert.data.counts.reverted}
            {revert.data.counts.partial > 0
              ? ` · ${revert.data.counts.partial} partly (edited since)`
              : ""}
            {revert.data.counts.skipped > 0
              ? ` · ${revert.data.counts.skipped} left as they were`
              : ""}
            {revert.data.counts.failed > 0
              ? ` · ${revert.data.counts.failed} failed`
              : ""}
            .
          </p>
        )}
        {refusal && <ErrorNote message={refusal} />}
        {moves.notice && (
          <p
            role="status"
            className={
              moves.notice.warning
                ? "text-[12.5px] text-warning"
                : "text-[12.5px] text-foreground/65"
            }
          >
            {moves.notice.text}
          </p>
        )}

        <RoomSection
          room={room}
          name={channel.data?.channel.title?.trim() || null}
          onRetry={() => void query.refetch()}
        />
        <DeliverablesSection rows={deliverables} />
        <CriteriaSection
          rows={criteria}
          failed={evaluation.status === "unavailable"}
          onRetry={() => void query.refetch()}
        />

        {report.isLoading ? (
          <DocumentContentSection title="Report" content={null} />
        ) : report.error ? (
          <DocumentContentSection
            title="Report"
            content={documentContent(report.error, undefined)}
          />
        ) : report.data?.content?.trim() ? (
          <ContentBlock
            title="Report"
            prepared={prepareContent(report.data.content, "markdown")}
            openInApp={<OpenInAppLink type="session" id={id} />}
          />
        ) : null}

        {(outputs.data?.outputs.length ?? 0) > 0 && (
          <SectionCard variant="flat" title="What it made">
            <ul className="flex flex-col">
              {outputs.data!.outputs.slice(0, OUTPUTS_SHOWN).map((output) => {
                const href = objectPage(output.kind, output.refId);
                const noun =
                  output.entityProfile?.displayName ??
                  resolveObjectNoun(output.kind);
                return (
                  <li
                    key={output.id}
                    className="flex flex-wrap items-baseline gap-x-2 border-b border-foreground/[0.05] py-2 last:border-b-0"
                  >
                    <span className="text-[12px] text-foreground/65">
                      {noun}
                    </span>
                    {href ? (
                      <Link
                        href={href}
                        className="break-words rounded-sm text-[13px] text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {output.title || "Untitled"}
                      </Link>
                    ) : (
                      <span className="break-words text-[13px] text-foreground/85">
                        {output.title || "Untitled"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {outputs.data!.outputs.length > OUTPUTS_SHOWN && (
              <p className="text-[12.5px] text-foreground/65">
                And {outputs.data!.outputs.length - OUTPUTS_SHOWN} more in the
                app.
              </p>
            )}
          </SectionCard>
        )}
        {[...moves.errors, rerunPreview.error, rerun.error, revert.error].map(
          (err, i) =>
            err && err.data?.code !== "UNAUTHORIZED" ? (
              <ErrorNote
                key={i}
                message={
                  err.data?.code === "FORBIDDEN"
                    ? "You can’t change this session."
                    : "That didn’t go through. Try again."
                }
                detail={errorDetail(err)}
              />
            ) : null
        )}

        {confirming && (
          <ConfirmModal
            isOpen
            onClose={() => setConfirming(null)}
            onConfirm={() => moves.run(confirming, () => setConfirming(null))}
            {...confirmCopy(confirming.key, title)}
            confirmColor="warning"
            isPending={moves.pending === confirming.key}
          />
        )}
        <ConfirmModal
          isOpen={Boolean(preview?.ok && preview.status === "dry_run")}
          onClose={() => rerunPreview.reset()}
          onConfirm={() => rerun.mutate({ sessionId: id, mode: "add" })}
          title="Run this session again?"
          consequence={
            preview?.ok && preview.status === "dry_run" ? (
              <>
                A new session re-reads {preview.plan.sources.selected}{" "}
                {preview.plan.sources.selected === 1 ? "source" : "sources"}{" "}
                with the current guidelines and adds its results on top of what
                this one applied — nothing here is reverted. About{" "}
                {preview.plan.estimatedStructureCalls} AI{" "}
                {preview.plan.estimatedStructureCalls === 1 ? "call" : "calls"}
                {preview.plan.cap.withinCap
                  ? "."
                  : `, over the ${preview.plan.cap.max}-call limit — it won’t start.`}
              </>
            ) : null
          }
          confirmLabel="Run again"
          confirmColor="warning"
          isConfirmDisabled={
            !(
              preview?.ok &&
              preview.status === "dry_run" &&
              preview.availability.available &&
              preview.plan.cap.withinCap
            )
          }
          isPending={rerun.isPending}
        />
      </>
    ),
  });
}

/** A relative time, the absolute one on hover. */
function When({ at }: { at: Date | string | null | undefined }) {
  const d = at instanceof Date ? at : at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return <>{formatRelative(at)}</>;
  return (
    <time dateTime={d.toISOString()} title={formatTimestamp(d)}>
      {formatRelative(d)}
    </time>
  );
}

/** The moves after the primary, in the header's overflow menu. */
function MoreMoves({
  moves,
  busy,
  onPick,
}: {
  moves: SessionMove[];
  busy: boolean;
  onPick: (m: SessionMove) => void;
}) {
  return (
    <Dropdown>
      <DropdownTrigger>
        <Button
          isIconOnly
          size="sm"
          variant="light"
          radius="md"
          aria-label="Change status"
          title="Change status"
          isDisabled={busy}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label="Change status"
        onAction={(key) => {
          const m = moves.find((x) => x.key === key);
          if (m) onPick(m);
        }}
      >
        {moves.map((m) => {
          const Icon = MOVE_ICON[m.key];
          return (
            <DropdownItem
              key={m.key}
              color={m.confirm ? "warning" : "default"}
              startContent={<Icon aria-hidden className="h-3.5 w-3.5" />}
            >
              {m.label}
            </DropdownItem>
          );
        })}
      </DropdownMenu>
    </Dropdown>
  );
}

/** What an ending move asks before it goes through. */
function confirmCopy(
  key: SessionMoveKey,
  title: string
): { title: string; consequence: ReactNode; confirmLabel: string } {
  switch (key) {
    case "discard":
      return {
        title: "Discard this draft?",
        consequence: (
          <>
            “{title}” ends as cancelled. Nothing is deleted: it, its room and
            its history stay readable. Changes waiting on its work are
            withdrawn.
          </>
        ),
        confirmLabel: "Discard draft",
      };
    case "close":
      return {
        title: "Close this session?",
        consequence: (
          <>
            “{title}” is marked closed and leaves the open list. Whatever it
            already applied stays; if it declared criteria that are not met, the
            close records that.
          </>
        ),
        confirmLabel: "Close session",
      };
    default:
      return {
        title: "Cancel this session?",
        consequence: (
          <>
            Work still in flight is stopped where it can be. Anything that
            already applied stays; the session records what was stopped and what
            will still finish. You can revert what applied afterwards.
          </>
        ),
        confirmLabel: "Cancel session",
      };
  }
}

/**
 * Who started it and where it lives, as one line of chips — each a door to
 * its own page when the row names the object. OMITTED when the row names
 * none of them.
 */
function Provenance({
  starter,
  space,
  project,
}: {
  starter: SessionStarter | null;
  space: { id: string; name: string | null } | null;
  project: { id: string; name: string } | null;
}) {
  if (!starter && !space && !project) return null;
  const ProjectIcon = kindIcon("project");
  return (
    <div
      role="group"
      aria-label="Who started it and where it lives"
      className="flex flex-wrap items-center gap-1.5"
    >
      {starter && <StarterChip starter={starter} />}
      {space && (
        <Pill
          exit={openIn({
            kind: "object",
            objectKind: "workspace",
            id: space.id,
          })}
          title={resolveObjectNoun("workspace")}
        >
          <Layers aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
          <span className="truncate">
            {space.name ?? resolveObjectNoun("workspace")}
          </span>
        </Pill>
      )}
      {project && (
        <Pill
          exit={openIn({
            kind: "object",
            objectKind: "project",
            id: project.id,
          })}
          title={resolveObjectNoun("project")}
        >
          <ProjectIcon aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
          <span className="truncate">{project.name}</span>
        </Pill>
      )}
    </div>
  );
}

function StarterChip({ starter }: { starter: SessionStarter }) {
  const by = <span className="text-foreground/55">Started by</span>;
  if (starter.by === "agent") {
    const name = starter.name ?? resolveProvenanceLabel("agent");
    return (
      <Pill
        exit={
          starter.id
            ? openIn({ kind: "object", objectKind: "agent", id: starter.id })
            : undefined
        }
      >
        {by}
        <AgentMark name={name} />
        <span className="truncate font-medium text-foreground">{name}</span>
      </Pill>
    );
  }
  if (starter.by === "person") {
    return (
      <Pill>
        {by}
        <UserRound aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
        <span className="truncate font-medium text-foreground">
          {starter.you ? "You" : resolveProvenanceLabel("human")}
        </span>
      </Pill>
    );
  }
  const Icon = kindIcon(starter.by);
  return (
    <Pill
      exit={
        starter.id
          ? openIn({ kind: "object", objectKind: starter.by, id: starter.id })
          : undefined
      }
    >
      {by}
      <Icon aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
      <span className="truncate font-medium text-foreground">
        {resolveObjectNoun(starter.by)}
      </span>
    </Pill>
  );
}

const ROW =
  "flex items-start gap-3 rounded-lg bg-foreground/[0.02] px-3 py-2.5 ring-1 ring-inset ring-foreground/10";
const DOOR =
  "rounded-sm text-[12.5px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/**
 * The session's room: its name, when the newest message landed and what it
 * said, and a door to the room's page. OMITTED when the session has no room;
 * a room that could not be read says so, with a retry, and keeps its door.
 */
function RoomSection({
  room,
  name,
  onRetry,
}: {
  room: SessionRoom;
  name: string | null;
  onRetry: () => void;
}) {
  if (room.state === "none") return null;
  const href = room.channelId ? objectPage("channel", room.channelId) : null;
  const RoomIcon = kindIcon("channel");
  const label = name ?? resolveObjectNoun("channel");
  return (
    <SectionCard
      variant="flat"
      title="Room"
      actions={
        href ? (
          <Link href={href} className={DOOR}>
            Open room
          </Link>
        ) : undefined
      }
    >
      {room.state === "failed" ? (
        <ResourceRowError
          message="Its room couldn’t be read."
          onRetry={onRetry}
        />
      ) : (
        <div className={ROW}>
          <RoomIcon
            aria-hidden
            className="mt-0.5 h-4 w-4 shrink-0 text-foreground/55"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="flex flex-wrap items-baseline gap-x-2">
              {href ? (
                <Link
                  href={href}
                  className="break-words rounded-sm text-[13px] font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {label}
                </Link>
              ) : (
                <span className="text-[13px] font-medium text-foreground">
                  {label}
                </span>
              )}
              <span className="text-[12px] text-foreground/65">
                {room.lastAt ? (
                  <>
                    last message <When at={room.lastAt} />
                  </>
                ) : (
                  "No messages yet"
                )}
              </span>
            </p>
            {room.latest && (
              <p className="line-clamp-2 break-words text-[12.5px] text-foreground/75">
                <span className="font-medium text-foreground/85">
                  {room.latest.author}:
                </span>{" "}
                {room.latest.text}
              </p>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/** A capped list with "Show all N" (ui-composition §4). */
function CappedList<T extends { key: string }>({
  items,
  noun,
  render,
}: {
  items: T[];
  noun: string;
  render: (item: T) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, LIST_CAP);
  return (
    <>
      <ul className="flex flex-col">
        {shown.map((item) => (
          <li
            key={item.key}
            className="flex items-start gap-2 border-b border-foreground/[0.05] py-2 last:border-b-0"
          >
            {render(item)}
          </li>
        ))}
      </ul>
      {!all && items.length > LIST_CAP && (
        <button type="button" onClick={() => setAll(true)} className={DOOR}>
          Show all {items.length} {noun}
        </button>
      )}
    </>
  );
}

/** One row's mark: an icon in the state's tone (the word sits beside it). */
function RowMark({ icon: Icon, tone }: { icon: LucideIcon; tone: string }) {
  return <Icon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />;
}

/** What the session declared it would deliver. OMITTED when it declared none. */
function DeliverablesSection({ rows }: { rows: DeliverableRow[] }) {
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.done).length;
  return (
    <SectionCard
      variant="flat"
      title="Deliverables"
      hint={`${done} of ${rows.length} delivered`}
    >
      <CappedList
        items={rows}
        noun="deliverables"
        render={(r) => (
          <>
            <RowMark
              icon={r.done ? CircleCheck : CircleDashed}
              tone={r.done ? "text-success" : "text-foreground/45"}
            />
            <span className="min-w-0 flex-1 break-words text-[13px] text-foreground/85">
              {r.label}
            </span>
            <span className="shrink-0 text-[12px] text-foreground/65">
              {resolveStatusLabel(r.done ? "done" : "pending")}
            </span>
          </>
        )}
      />
    </SectionCard>
  );
}

const VERDICT_MARK: Record<
  NonNullable<CriterionRow["verdict"]>,
  { icon: LucideIcon; tone: string }
> = {
  pass: { icon: CircleCheck, tone: "text-success" },
  fail: { icon: CircleX, tone: "text-danger" },
  unmeasured: { icon: CircleDashed, tone: "text-warning" },
};

/**
 * What "done" means for this session, criterion by criterion, with the
 * current verdict. OMITTED when it declares none; a failed read says so.
 */
function CriteriaSection({
  rows,
  failed,
  onRetry,
}: {
  rows: CriterionRow[];
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <SectionCard variant="flat" title="Criteria">
        <ResourceRowError
          message="Its criteria couldn’t be read."
          onRetry={onRetry}
        />
      </SectionCard>
    );
  }
  if (rows.length === 0) return null;
  const met = rows.filter((r) => r.verdict === "pass").length;
  return (
    <SectionCard
      variant="flat"
      title="Criteria"
      hint={`${met} of ${rows.length} met`}
    >
      <CappedList
        items={rows}
        noun="criteria"
        render={(r) => {
          const mark = r.verdict
            ? VERDICT_MARK[r.verdict]
            : { icon: CircleDashed, tone: "text-foreground/45" };
          const word = resolveStatusLabel(r.verdict ?? "pending");
          return (
            <>
              <RowMark icon={mark.icon} tone={mark.tone} />
              <span className="min-w-0 flex-1 break-words text-[13px] text-foreground/85">
                {r.statement}
                {!r.required && (
                  <span className="text-foreground/55"> · optional</span>
                )}
              </span>
              <span className="shrink-0 text-[12px] text-foreground/65">
                {word}
              </span>
            </>
          );
        }}
      />
    </SectionCard>
  );
}
