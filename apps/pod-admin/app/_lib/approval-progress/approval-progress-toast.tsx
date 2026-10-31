"use client";

/**
 * The toast a LARGE approval keeps on screen while the pod applies it in the
 * background: "Creating records: 1,240 of 4,222", live, until it finished or
 * failed. Built on the app's ONE toast system (HeroUI `addToast`, mounted in
 * `app/providers.tsx` INSIDE the tRPC provider so the toast's own content can
 * poll — HeroUI cannot update a toast in place, so the content updates
 * itself).
 *
 *   `showApprovalProgressToast(proposalId)` — once per proposal (a second call
 *     while it shows is a no-op); called after an approve that came back
 *     `queued`, and by the review when it opens on a proposal still applying.
 *   The toast polls `proposals.approvalProgress` every 2 s; when the run ends
 *   it closes itself and leaves the outcome: done (with a door to what was
 *   created) or stopped (with Resume — approving again, which links what the
 *   first attempt created and creates only the rest).
 *
 * The words come from `approval-progress-model.ts`, shared with the review's
 * decision bar.
 */

import { useEffect } from "react";
import { Button, Progress, addToast, closeToast } from "@heroui/react";
import { trpc } from "../../../lib/trpc";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import {
  decisionFailure,
  decisionReceipt,
  readApproveAnswer,
} from "../receipt/decision-receipt";
import { showReceipt } from "../receipt/decision-receipt-toast";
import {
  approvalProgressCopy,
  isApplying,
  progressUnavailable,
  type ApprovalProgressCopy,
  type ApprovalRun,
} from "./approval-progress-model";

/** Polling cadence while it applies; slower while the read itself fails. */
const POLL_MS = 2_000;
const POLL_FAILING_MS = 5_000;

/**
 * proposalId → its live toast, and when it opened. Module state: toasts are
 * app-global. `openedAt` keeps a cached answer from BEFORE the approve (no
 * run yet) from closing a toast that just opened.
 */
const liveToasts = new Map<string, { key: string; openedAt: number }>();

/** The progress of one proposal's background approval, polled while it applies. */
export function useApprovalProgress(proposalId: string, enabled = true) {
  return trpc.proposals.approvalProgress.useQuery(
    { proposalId },
    {
      enabled,
      // Progress is a report about NOW: never served stale from a cache.
      staleTime: 0,
      retry: 1,
      refetchInterval: (query) => {
        if (query.state.status === "error") return POLL_FAILING_MS;
        return isApplying(query.state.data as ApprovalRun | null | undefined)
          ? POLL_MS
          : false;
      },
    }
  );
}

/** Show the live toast for this proposal's background approval (once). */
export function showApprovalProgressToast(proposalId: string): void {
  if (liveToasts.has(proposalId)) return;
  const openedAt = Date.now();
  const key = addToast({
    title: <ApprovalProgressTitle proposalId={proposalId} />,
    description: <ApprovalProgressBody proposalId={proposalId} />,
    // Stays until the run ends: no timeout, no close button. It closes itself.
    timeout: 0,
    hideCloseButton: true,
    shouldShowTimeoutProgress: false,
    onClose: () => liveToasts.delete(proposalId),
  });
  if (key) liveToasts.set(proposalId, { key, openedAt });
}

function copyFor(
  query: ReturnType<typeof useApprovalProgress>
): ApprovalProgressCopy | null {
  if (query.isError) return progressUnavailable;
  const run = query.data as ApprovalRun | null | undefined;
  return run ? approvalProgressCopy(run) : null;
}

function ApprovalProgressTitle({ proposalId }: { proposalId: string }) {
  const copy = copyFor(useApprovalProgress(proposalId));
  return <span>{copy?.title ?? "Approving…"}</span>;
}

function ApprovalProgressBody({ proposalId }: { proposalId: string }) {
  const query = useApprovalProgress(proposalId);
  const utils = trpc.useUtils();
  const run = query.data as ApprovalRun | null | undefined;
  const copy = copyFor(query);

  // The run ended (or there is none): close this toast, leave the outcome.
  // Only on an answer read AFTER the toast opened.
  useEffect(() => {
    if (query.isError || query.isFetching || isApplying(run)) return;
    const live = liveToasts.get(proposalId);
    if (!live || query.dataUpdatedAt < live.openedAt) return;
    liveToasts.delete(proposalId);
    closeToast(live.key);
    void utils.proposals.get.invalidate({ proposalId });
    void utils.proposals.list.invalidate();
    if (run) showApprovalOutcomeToast(run);
  }, [
    query.isError,
    query.isFetching,
    query.dataUpdatedAt,
    run,
    proposalId,
    utils,
  ]);

  if (!copy) return null;
  return (
    <ApprovalProgressLines
      copy={copy}
      onRetry={query.isError ? () => void query.refetch() : undefined}
    />
  );
}

/** The detail line + bar, shared by the toast and the review's decision bar. */
export function ApprovalProgressLines({
  copy,
  onRetry,
}: {
  copy: ApprovalProgressCopy;
  onRetry?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {copy.busy && (
        <Progress
          aria-label={copy.title}
          size="sm"
          color={copy.tone === "warning" ? "warning" : "primary"}
          value={copy.percent ?? undefined}
          isIndeterminate={copy.percent === null}
        />
      )}
      {copy.detail && (
        <span className="text-[12px] leading-relaxed text-foreground/70">
          {copy.detail}
        </span>
      )}
      {onRetry && (
        <Button
          size="sm"
          variant="flat"
          className="self-start"
          onPress={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

/** The outcome toast: done with its door, or stopped with Resume. */
function showApprovalOutcomeToast(run: ApprovalRun): void {
  const copy = approvalProgressCopy(run);
  const door = copy.door ? openIn(copy.door) : null;
  // The key, for Resume to close this toast once the new attempt started.
  const self: { key: string | null } = { key: null };
  self.key = addToast({
    title: copy.title,
    description: (
      <div className="flex min-w-0 flex-col gap-1.5">
        {copy.detail && (
          <span className="text-[12px] leading-relaxed text-foreground/70">
            {copy.detail}
          </span>
        )}
        {door && <ExitLink exit={door} label="See what was created" />}
        {copy.resumable && (
          <ResumeButton
            proposalId={run.proposalId}
            onStarted={() => self.key && closeToast(self.key)}
          />
        )}
      </div>
    ),
    color: copy.tone,
    // A stopped approval waits for the person; a finished one can go.
    timeout: copy.resumable ? 0 : 10_000,
  });
}

/** Approve again: the same door, which links what landed and creates the rest. */
function ResumeButton({
  proposalId,
  onStarted,
}: {
  proposalId: string;
  onStarted: () => void;
}) {
  const utils = trpc.useUtils();
  const approve = trpc.proposals.approve.useMutation({
    onSuccess: (result) => {
      onStarted();
      void utils.proposals.get.invalidate({ proposalId });
      if ((result as { queued?: boolean }).queued) {
        showApprovalProgressToast(proposalId);
      } else {
        showReceipt(decisionReceipt(readApproveAnswer(result)));
      }
    },
    onError: (e) => showReceipt(decisionReceipt(decisionFailure("approve", e))),
  });
  return (
    <Button
      size="sm"
      color="primary"
      variant="flat"
      className="self-start"
      isLoading={approve.isPending}
      isDisabled={approve.isSuccess}
      onPress={() => approve.mutate({ proposalId })}
    >
      Resume
    </Button>
  );
}
