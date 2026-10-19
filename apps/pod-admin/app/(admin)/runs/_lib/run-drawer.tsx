"use client";

/**
 * One run, on demand, in a drawer over the list it was opened from (Runs, a
 * rule, a template). The body is the shared run body (`useRunDetail`,
 * `RunDetailBody`, `RunActButtons`, `RunActConfirm` in
 * `app/_lib/object/views/run-object.tsx`) that `/open/run/:id` draws as a page;
 * this file is only the drawer frame around it.
 */

import { DetailDrawer } from "../../components/detail-drawer";
import {
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { StatusPill } from "../../components/status-pill";
import {
  RunActButtons,
  RunActConfirm,
  RunDetailBody,
  useRunDetail,
} from "../../../_lib/object/views/run-object";
import type { RunFlowType } from "../../../open/open-model";
import { flowNoun } from "./run-board";

export interface RunTarget {
  flowType: RunFlowType;
  id: string;
  /** Shown while the run loads. */
  flowName: string;
}

export function RunDrawer({
  target,
  onClose,
}: {
  target: RunTarget | null;
  onClose: () => void;
}) {
  const state = useRunDetail(target);
  const { detail, run, pill, acts } = state;

  const close = () => {
    state.dismiss();
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
            <div className="flex w-full justify-end">
              <RunActButtons state={state} />
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
          <RunDetailBody state={state} />
        )}
      </DetailDrawer>
      <RunActConfirm state={state} />
    </>
  );
}
