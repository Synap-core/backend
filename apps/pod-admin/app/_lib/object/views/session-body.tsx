"use client";

/**
 * One session — the ONE body, drawn in two frames (D6): `/open/session/:id`
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
 *   • Cancel — stops what is still in flight (de-escalation), behind a confirm.
 *   • Run again — a NEW session that re-reads this one's stored sources, added
 *     on top (`mode: "add"`). The dry run answers first and its plan is the
 *     confirm's impact preview; `replace` (revert-then-rerun) stays in the app.
 *   • Revert — undo what this session applied. Secondary: in the danger zone.
 * The Intake Room (`?view=room`) is the app's; links to it keep bouncing.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { trpc } from "../../../../lib/trpc";
import { formatRelative } from "../../../../lib/format";
import { ConfirmModal } from "../../../(admin)/components/confirm-modal";
import { ErrorNote, errorDetail } from "../../copy-button";
import { statusPillFor } from "../../../(admin)/components/status-tone";
import {
  sessionCanCancel,
  sessionCanRevert,
  sessionSummary,
  shortDescription,
} from "../../../open/open-model";
import { couldNotLoad, loadFailure } from "../load-failure";
import { OpenInAppLink } from "../open-in-app-link";
import { useReauthOnUnauthorized } from "../use-reauth";
import type { ObjectFrame } from "./object-frame";

export function SessionBody({ id, frame }: { id: string; frame: ObjectFrame }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const query = trpc.focusSessions.get.useQuery({ id }, { retry: false });
  const invalidate = () => utils.focusSessions.get.invalidate({ id });

  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancel = trpc.focusSessions.cancel.useMutation({
    onSuccess: async () => {
      setConfirmCancel(false);
      await invalidate();
    },
  });

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
    cancel.error,
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
  const canCancel = owner && sessionCanCancel(session.status);
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
      summary: sessionSummary(session),
      status: statusPillFor(session.status),
      primaryAction: canCancel ? (
        <Button
          size="sm"
          radius="md"
          color="warning"
          variant="flat"
          onPress={() => setConfirmCancel(true)}
        >
          Cancel session
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
      secondaryActions: <OpenInAppLink type="session" id={id} />,
    },
    facts: [
      ...(session.createdAt
        ? [{ label: "Started", value: formatRelative(session.createdAt) }]
        : []),
      ...(session.closedAt
        ? [{ label: "Ended", value: formatRelative(session.closedAt) }]
        : []),
      ...(session.liveness?.status === "ok" &&
      session.liveness.lastAgentActivityAt
        ? [
            {
              label: "Agent last acted",
              value: formatRelative(session.liveness.lastAgentActivityAt),
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
        {[cancel.error, rerunPreview.error, rerun.error, revert.error].map(
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

        <ConfirmModal
          isOpen={confirmCancel}
          onClose={() => setConfirmCancel(false)}
          onConfirm={() => cancel.mutate({ sessionId: id })}
          title="Cancel this session?"
          consequence={
            <>
              Work still in flight is stopped where it can be. Anything that
              already applied stays; the session records what was stopped and
              what will still finish. You can revert what applied afterwards.
            </>
          }
          confirmLabel="Cancel session"
          confirmColor="warning"
          isPending={cancel.isPending}
        />
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
