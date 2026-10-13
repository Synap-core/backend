"use client";

/**
 * One run, on demand: `runs.get` (user-floored, the same door the desktop's
 * run detail and diagnose read) — its status, why it failed, who started it,
 * and the timeline of what it did. The acts are the ones the pod's doors take:
 * cancel a live template run (`playbookRuns.cancelRun`, person-only) and run a
 * rule again (`automations.trigger` — an operator's run starts directly; one
 * the pod routes to review comes back `proposed` and is said so).
 */

import { addToast, Button } from "@heroui/react";
import { useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { formatRelative, formatTimestamp } from "../../../../lib/format";
import { DetailDrawer } from "../../components/detail-drawer";
import { ConfirmModal } from "../../components/confirm-modal";
import { StatusPill } from "../../components/status-pill";
import {
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { statusPillFor } from "../../../_lib/object/tone";
import { runResultMessage } from "../../rules/_lib/rule-rows";
import { flowNoun, runActions, triggeredByLabel } from "./run-board";

export type RunFlowType =
  | "automation"
  | "playbook"
  | "capture"
  | "capability"
  | "session"
  | "chat"
  | "agent_write";

export interface RunTarget {
  flowType: RunFlowType;
  id: string;
  /** Shown while the run loads. */
  flowName: string;
}

/** Timeline entries drawn; the rest is one click away in the app. */
const TIMELINE_MAX = 30;

export function RunDrawer({
  target,
  onClose,
}: {
  target: RunTarget | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const detail = trpc.runs.get.useQuery(
    { flowType: target?.flowType ?? "automation", id: target?.id ?? "" },
    { enabled: target !== null, retry: false }
  );
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const cancel = trpc.playbookRuns.cancelRun.useMutation();
  const trigger = trpc.automations.trigger.useMutation();
  const [confirming, setConfirming] = useState<"cancel" | "again" | null>(null);
  const [actError, setActError] = useState<string | null>(null);

  const run = detail.data?.run;
  const acts = run ? runActions(run) : { cancel: false, runAgain: false };
  const pill = run ? statusPillFor(run.status) : null;
  const who = run
    ? triggeredByLabel(run.triggeredBy, me.data?.id ?? null)
    : null;
  const activity = (detail.data?.activity ?? []).slice(0, TIMELINE_MAX);

  async function confirmAct() {
    if (!run) return;
    setActError(null);
    try {
      if (confirming === "cancel") {
        await cancel.mutateAsync({ runId: run.id });
        addToast({ title: "Run cancelled", color: "default" });
      } else if (confirming === "again" && run.flowId) {
        const result = await trigger.mutateAsync({ id: run.flowId });
        addToast({
          title: runResultMessage(run.flowName, result),
          color: "default",
        });
      }
      setConfirming(null);
      await Promise.all([
        utils.runs.invalidate(),
        utils.automations.listPage.invalidate(),
      ]);
    } catch (err) {
      setActError(err instanceof Error ? err.message : "That didn’t work.");
    }
  }

  const close = () => {
    setConfirming(null);
    setActError(null);
    onClose();
  };

  return (
    <>
      <DetailDrawer
        isOpen={target !== null}
        onClose={close}
        title={run?.flowName ?? target?.flowName ?? "Run"}
        subtitle={target ? `${flowNoun(target.flowType)} run` : undefined}
        headerRight={
          pill ? <StatusPill kind={pill.kind} label={pill.label} /> : undefined
        }
        footer={
          acts.cancel || acts.runAgain ? (
            <div className="flex w-full flex-wrap justify-end gap-2">
              {acts.runAgain && (
                <Button
                  size="sm"
                  variant="flat"
                  radius="md"
                  onPress={() => setConfirming("again")}
                >
                  Run again
                </Button>
              )}
              {acts.cancel && (
                <Button
                  size="sm"
                  variant="flat"
                  radius="md"
                  color="warning"
                  onPress={() => setConfirming("cancel")}
                >
                  Cancel run
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {detail.isLoading ? (
          <ResourceRowSkeleton count={3} />
        ) : detail.isError || !run ? (
          <ResourceRowError
            message={
              detail.error?.data?.code === "NOT_FOUND"
                ? "This run isn’t visible to you, or no longer exists."
                : "The run couldn’t be loaded."
            }
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[12.5px]">
              <Fact label="Started" value={formatTimestamp(run.startedAt)} />
              <Fact
                label="Finished"
                value={
                  run.completedAt
                    ? formatRelative(run.completedAt)
                    : run.status === "running"
                      ? "Still running"
                      : "—"
                }
              />
              {who && <Fact label="Started by" value={who} />}
              {run.stepsCompleted !== null && (
                <Fact
                  label="Steps"
                  value={
                    run.stepsFailed
                      ? `${run.stepsCompleted} done · ${run.stepsFailed} failed`
                      : `${run.stepsCompleted} done`
                  }
                />
              )}
            </dl>

            {run.error?.trim() && (
              <section className="flex flex-col gap-1 rounded-lg bg-status-down/[0.06] px-3 py-2.5 ring-1 ring-inset ring-status-down/30">
                <h3 className="text-[12px] font-medium text-status-down">
                  Why it failed
                </h3>
                <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground/85">
                  {run.error.trim()}
                </p>
              </section>
            )}
            {/* A run's room is where its story was told (a chat turn's
                conversation, a rule's run channel). It opens in the app;
                `ExitLink` carries the install fallback with it. */}
            {run.channelId && (
              <ExitLink
                exit={openIn({
                  kind: "object",
                  objectKind: "channel",
                  id: run.channelId,
                })}
                label="Open the conversation in app"
              />
            )}
            {!run.error && run.summary?.trim() && (
              <p className="text-[12.5px] leading-relaxed text-foreground/80">
                {run.summary.trim()}
              </p>
            )}

            <section className="flex flex-col gap-2">
              <h3 className="text-[13px] font-medium text-foreground">
                What happened
              </h3>
              {activity.length === 0 ? (
                <p className="text-[12.5px] text-foreground/65">
                  This run left no step-by-step record.
                </p>
              ) : (
                <ol className="flex flex-col">
                  {activity.map((item) => {
                    const itemPill = statusPillFor(item.status);
                    return (
                      <li
                        key={item.id}
                        className="flex items-start gap-3 border-b border-foreground/[0.05] py-2 last:border-b-0"
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="break-words text-[12.5px] text-foreground">
                            {item.label}
                          </span>
                          <span className="text-[11.5px] text-foreground/65">
                            {formatRelative(item.at, { empty: "—" })}
                            {item.hint ? ` · ${item.hint}` : ""}
                          </span>
                        </div>
                        {itemPill && (
                          <StatusPill
                            kind={itemPill.kind}
                            label={itemPill.label}
                          />
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              {(detail.data?.activity.length ?? 0) > TIMELINE_MAX && (
                <p className="text-[12px] text-foreground/65">
                  The first {TIMELINE_MAX} of {detail.data?.activity.length}{" "}
                  entries.
                </p>
              )}
            </section>
          </div>
        )}
      </DetailDrawer>

      <ConfirmModal
        isOpen={confirming !== null}
        onClose={() => {
          setConfirming(null);
          setActError(null);
        }}
        onConfirm={() => void confirmAct()}
        title={
          confirming === "cancel"
            ? "Cancel this run?"
            : `Run “${run?.flowName ?? "this rule"}” again?`
        }
        consequence={
          confirming === "cancel" ? (
            <>
              The agent working on it is stopped and the run ends as cancelled.
              What it already made or changed stays.
            </>
          ) : (
            <>
              The rule runs its whole flow once more, as if its trigger had
              happened — including anything it sends or changes. If the pod
              needs someone to approve it, it is proposed instead and waits in
              Review.
            </>
          )
        }
        confirmLabel={confirming === "cancel" ? "Cancel run" : "Run again"}
        confirmColor="warning"
        isPending={cancel.isPending || trigger.isPending}
      >
        {actError && (
          <p className="text-[12.5px] text-status-down">{actError}</p>
        )}
      </ConfirmModal>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11.5px] text-foreground/65">{label}</dt>
      <dd className="break-words text-foreground">{value}</dd>
    </div>
  );
}
