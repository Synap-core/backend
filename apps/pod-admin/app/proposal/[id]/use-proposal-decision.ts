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

/** What one approve carries beyond the proposal: the reviewer's twin choice. */
export interface ApproveChoice {
  identityResolution?: DuplicateResolution;
  identityResolutionByRef?: Record<string, DuplicateResolution>;
}

/** The `proposals.approve` input for a choice — only the keys it carries. */
export function approveInput(proposalId: string, choice: ApproveChoice = {}) {
  return {
    proposalId,
    identityResolution: choice.identityResolution ?? {
      verb: "separate" as const,
    },
    ...(choice.identityResolutionByRef &&
    Object.keys(choice.identityResolutionByRef).length > 0
      ? { identityResolutionByRef: choice.identityResolutionByRef }
      : {}),
  };
}

export function useProposalDecision(
  proposalId: string,
  onDecided: () => void,
  { onRejected }: { onRejected?: () => void } = {}
) {
  const approveMutation = trpc.proposals.approve.useMutation({
    onSuccess: () => {
      addToast({ title: "Proposal approved", color: "success" });
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
      approveMutation.mutate(approveInput(proposalId, choice)),
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
