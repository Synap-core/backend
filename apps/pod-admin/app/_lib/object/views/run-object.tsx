"use client";

/**
 * One run, the one body — drawn by `/open/run/:id` as an object page in the
 * receiver card (`RunObject`) and by the console's run drawer (`RunDrawer`,
 * opened from Runs, a rule or a template). Both read the run through
 * `useRunDetail` and draw it with `RunDetailBody`, `RunActButtons` and
 * `RunActConfirm`, so the two never disagree on what a run says or allows.
 *
 * `runs.get` is user-floored (the same door the desktop's run detail and
 * diagnose read). The acts are the ones the pod's doors take: cancel a live
 * template run (`playbookRuns.cancelRun`, person-only) and run a rule again
 * (`automations.trigger` — an operator's run starts directly; one the pod
 * routes to review comes back `proposed` and is said so).
 *
 * A run is addressed by `{flowType, id}`. A link that lost its flow type is
 * read through the resolver (`runFlowTypeOf`); when neither can tell, the page
 * says so instead of guessing the automation reader.
 */

import { addToast, Button } from "@heroui/react";
import { useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { formatRelative, formatTimestamp } from "../../../../lib/format";
import { FactsGrid } from "../facts-grid";
import { ConfirmModal } from "../../../(admin)/components/confirm-modal";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { statusPillFor } from "../../../(admin)/components/status-tone";
import { runResultMessage } from "../../../(admin)/rules/_lib/rule-rows";
import {
  flowNoun,
  runActions,
  triggeredByLabel,
} from "../../../(admin)/runs/_lib/run-board";
import { runFlowTypeOf, type RunFlowType } from "../../../open/open-model";
import { couldNotLoad, loadFailure } from "../load-failure";
import { OpenInAppLink } from "../open-in-app-link";
import { useReauthOnUnauthorized } from "../use-reauth";
import type { ObjectFrame } from "./object-frame";

export interface RunAddress {
  flowType: RunFlowType;
  id: string;
}

/** Timeline entries drawn; the rest is one click away in the app. */
const TIMELINE_MAX = 30;
/** How often an open run is re-read while it is still going. */
const LIVE_POLL_MS = 5_000;

/** A run's read, its acts and their confirm state — one per drawn run. */
export function useRunDetail(target: RunAddress | null) {
  const utils = trpc.useUtils();
  const detail = trpc.runs.get.useQuery(
    { flowType: target?.flowType ?? "automation", id: target?.id ?? "" },
    {
      enabled: target !== null,
      retry: false,
      // A live run's status, steps and timeline move while it is open.
      refetchInterval: (query) =>
        query.state.data?.run.status === "running" ? LIVE_POLL_MS : false,
    }
  );
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const cancel = trpc.playbookRuns.cancelRun.useMutation();
  const trigger = trpc.automations.trigger.useMutation();
  const [confirming, setConfirming] = useState<"cancel" | "again" | null>(null);
  const [actError, setActError] = useState<string | null>(null);

  const run = detail.data?.run;

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

  return {
    detail,
    run,
    acts: run ? runActions(run) : { cancel: false, runAgain: false },
    pill: run ? statusPillFor(run.status) : null,
    who: run ? triggeredByLabel(run.triggeredBy, me.data?.id ?? null) : null,
    activity: (detail.data?.activity ?? []).slice(0, TIMELINE_MAX),
    activityTotal: detail.data?.activity.length ?? 0,
    confirming,
    ask: (act: "cancel" | "again") => setConfirming(act),
    dismiss: () => {
      setConfirming(null);
      setActError(null);
    },
    confirmAct,
    actError,
    isActing: cancel.isPending || trigger.isPending,
  };
}

export type RunDetailState = ReturnType<typeof useRunDetail>;

/** "Run again" / "Cancel run", when the run allows either. */
export function RunActButtons({ state }: { state: RunDetailState }) {
  const { acts } = state;
  if (!acts.cancel && !acts.runAgain) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {acts.runAgain && (
        <Button
          size="sm"
          variant="flat"
          radius="md"
          onPress={() => state.ask("again")}
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
          onPress={() => state.ask("cancel")}
        >
          Cancel run
        </Button>
      )}
    </div>
  );
}

/** The confirm both acts go through, with the pod's refusal under it. */
export function RunActConfirm({ state }: { state: RunDetailState }) {
  const { confirming, run } = state;
  return (
    <ConfirmModal
      isOpen={confirming !== null}
      onClose={state.dismiss}
      onConfirm={() => void state.confirmAct()}
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
            happened — including anything it sends or changes. If the pod needs
            someone to approve it, it is proposed instead and waits in Review.
          </>
        )
      }
      confirmLabel={confirming === "cancel" ? "Cancel run" : "Run again"}
      confirmColor="warning"
      isPending={state.isActing}
    >
      {state.actError && (
        <p className="text-[12.5px] text-status-down">{state.actError}</p>
      )}
    </ConfirmModal>
  );
}

/** What the run did: when, who, why it failed, and its timeline. */
export function RunDetailBody({
  state,
  showFacts = true,
}: {
  state: RunDetailState;
  /** An object page draws the facts in its own grid, above the body. */
  showFacts?: boolean;
}) {
  const { run, activity } = state;
  if (!run) return null;
  return (
    <div className="flex flex-col gap-5">
      {showFacts && <FactsGrid columns={2} facts={runFacts(state)} />}

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
          conversation, a rule's run channel). It reads on its own console
          page; replying stays in the app. */}
      {run.channelId && (
        <ExitLink
          exit={openIn({
            kind: "object",
            objectKind: "channel",
            id: run.channelId,
          })}
          label="Read the conversation"
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
                    <StatusPill kind={itemPill.kind} label={itemPill.label} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {state.activityTotal > TIMELINE_MAX && (
          <p className="text-[12px] text-foreground/65">
            The first {TIMELINE_MAX} of {state.activityTotal} entries.
          </p>
        )}
      </section>
    </div>
  );
}

function runFacts(state: RunDetailState) {
  const { run, who } = state;
  if (!run) return [];
  return [
    { label: "Started", value: formatTimestamp(run.startedAt) },
    {
      label: "Finished",
      value: run.completedAt
        ? formatTimestamp(run.completedAt)
        : run.status === "running"
          ? "Still running"
          : "—",
    },
    ...(who ? [{ label: "Started by", value: who }] : []),
    ...(run.stepsCompleted !== null
      ? [
          {
            label: "Steps",
            value: run.stepsFailed
              ? `${run.stepsCompleted} done · ${run.stepsFailed} failed`
              : `${run.stepsCompleted} done`,
          },
        ]
      : []),
  ];
}

const PLACEHOLDER_UUID = "00000000-0000-4000-8000-000000000000";

/**
 * The run as an object page. `flowType` is the link's raw `?flowType=`; a
 * missing or unknown one is read through the resolver.
 */
export function RunObject({
  id,
  flowType,
  frame,
}: {
  id: string;
  flowType: string | undefined;
  frame: ObjectFrame;
}) {
  const fromLink = runFlowTypeOf(flowType, undefined);
  const resolved = trpc.diagnose.resolveOpen.useQuery(
    { id: fromLink ? PLACEHOLDER_UUID : id },
    { enabled: !fromLink, retry: false }
  );
  useReauthOnUnauthorized(resolved.error);

  if (!fromLink && resolved.isLoading) return frame.loading("Loading run…");
  const address = runFlowTypeOf(flowType, resolved.data);
  if (!address) {
    return frame.failure({
      kind: "run",
      id,
      failure: loadFailure(resolved.error, "Run") ?? {
        title: "This run can’t be told apart",
        message:
          "The link doesn’t say what kind of run this is, and the pod couldn’t tell. Open it in the Synap app, or open it from Runs.",
        chip: "Unknown run",
      },
    });
  }
  return <RunPage id={id} flowType={address} frame={frame} />;
}

function RunPage({ id, flowType, frame }: RunAddress & { frame: ObjectFrame }) {
  const state = useRunDetail({ flowType, id });
  const { detail, run, pill } = state;
  useReauthOnUnauthorized(detail.error);

  if (detail.isLoading) return frame.loading("Loading run…");
  const fail = loadFailure(detail.error, "Run");
  if (fail || !run) {
    return frame.failure({
      kind: "run",
      id,
      failure: fail ?? couldNotLoad("Run"),
    });
  }
  const noun = `${flowNoun(flowType)} run`;
  const title = run.flowName || noun;
  return (
    <>
      {frame.object({
        header: {
          kind: "run",
          noun,
          title,
          summary: run.error?.trim()
            ? "It failed. Why is below."
            : run.status === "running"
              ? "It is still running."
              : undefined,
          status: pill,
          breadcrumb: frame.breadcrumb?.(title),
          primaryAction: <RunActButtons state={state} />,
          secondaryActions: (
            <OpenInAppLink type="run" id={id} params={{ flowType }} />
          ),
        },
        facts: runFacts(state),
        children: <RunDetailBody state={state} showFacts={false} />,
        advanced: {
          ids: [
            { label: "Run id", value: run.id },
            ...(run.flowId ? [{ label: "Flow id", value: run.flowId }] : []),
          ],
        },
      })}
      <RunActConfirm state={state} />
    </>
  );
}
