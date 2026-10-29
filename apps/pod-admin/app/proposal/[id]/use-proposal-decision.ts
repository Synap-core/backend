"use client";

/**
 * The review's ONE approve and reject path. Every verb on the review — the
 * plain Approve, a duplicate's "Keep both" / "Use existing" / …, a capture
 * graph's Approve with one choice per item — sends `proposals.approve`
 * through here, so the resolution a reviewer chose is exactly what reaches
 * the pod (`identityResolution` for a single create, `identityResolutionByRef`
 * keyed by the item's ref for a graph — `routers/proposals.ts` approve input).
 */

import { addToast } from "@heroui/react";
import type { DuplicateResolution } from "@synap-core/types/proposals";
import { trpc } from "../../../lib/trpc";
import { showApprovalProgressToast } from "../../_lib/approval-progress/approval-progress-toast";

/** What one approve carries beyond the proposal: the reviewer's twin choice. */
export interface ApproveChoice {
  identityResolution?: DuplicateResolution;
  identityResolutionByRef?: Record<string, DuplicateResolution>;
  /** A graph's ONE answer for every twin not chosen one by one. */
  identityResolutionForTwins?: "keep_existing" | "separate";
}

/**
 * The revision this page rendered: the length of the proposal's revision
 * history as read. Sent with every approve so a revise that landed after the
 * page drew is refused (CONFLICT) instead of approved unseen; the pod refuses
 * an approve that turns something on without it.
 */
export function renderedRevision(proposal: {
  revisionHistory?: unknown;
}): number | undefined {
  return Array.isArray(proposal.revisionHistory)
    ? proposal.revisionHistory.length
    : undefined;
}

/** The `proposals.approve` input for a choice — only the keys it carries. */
export function approveInput(
  proposalId: string,
  choice: ApproveChoice = {},
  expectedRevision?: number
) {
  return {
    proposalId,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(choice.identityResolution
      ? { identityResolution: choice.identityResolution }
      : {}),
    ...(choice.identityResolutionByRef &&
    Object.keys(choice.identityResolutionByRef).length > 0
      ? { identityResolutionByRef: choice.identityResolutionByRef }
      : {}),
    ...(choice.identityResolutionForTwins
      ? { identityResolutionForTwins: choice.identityResolutionForTwins }
      : {}),
  };
}

export function useProposalDecision(
  proposalId: string,
  onDecided: () => void,
  {
    onRejected,
    expectedRevision,
  }: {
    onRejected?: () => void;
    /** `renderedRevision` of the proposal this page drew. */
    expectedRevision?: number;
  } = {}
) {
  const utils = trpc.useUtils();
  const approveMutation = trpc.proposals.approve.useMutation({
    onSuccess: (result) => {
      void utils.proposals.approvalProgress.invalidate({ proposalId });
      // A LARGE graph is applied in the background: the request returned as
      // soon as the gates passed, so "approved" would be a lie. The live
      // toast carries the real count until it finishes or fails.
      if ((result as { queued?: boolean }).queued) {
        showApprovalProgressToast(proposalId);
      } else {
        addToast({ title: "Proposal approved", color: "success" });
      }
      onDecided();
    },
    onError: (e) =>
      addToast({
        title: "Could not approve",
        description: e.message,
        color: "danger",
      }),
  });

  const rejectMutation = trpc.proposals.reject.useMutation({
    onSuccess: () => {
      addToast({ title: "Proposal rejected", color: "success" });
      onRejected?.();
      onDecided();
    },
    onError: (e) =>
      addToast({
        title: "Could not reject",
        description: e.message,
        color: "danger",
      }),
  });

  return {
    approve: (choice?: ApproveChoice) =>
      approveMutation.mutate(
        approveInput(proposalId, choice, expectedRevision)
      ),
    reject: (reason?: string) =>
      rejectMutation.mutate({
        proposalId,
        reason: reason?.trim() || undefined,
      }),
    approving: approveMutation.isPending,
    rejecting: rejectMutation.isPending,
    busy: approveMutation.isPending || rejectMutation.isPending,
  };
}
