"use client";

/**
 * The person's saved review settings (`uiPreferences.review`, founder B-4):
 * the grouping and each package's layout. Read through `preferences.get`,
 * written through `preferences.updateReview` (it MERGES into uiPreferences;
 * `preferences.update` would replace the whole JSONB). Review, Settings ›
 * Review and the onboarding step all read and write it here, so the three
 * can never disagree. The shape is read by `readReviewPreferences`
 * (`@synap-core/types`), the one reader browser and relay share (B-6).
 */

import { addToast } from "@heroui/react";
import {
  readReviewPreferences,
  reviewGroupByFor,
  reviewLayoutFor,
  type ReviewGroupBy,
  type ReviewLayout,
  type ReviewPackage,
  type ReviewPreferences,
} from "@synap-core/types/proposals/review-package";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";

export interface ReviewPreferencesState {
  /** The read is in flight: nothing is known yet (never "never chose"). */
  isLoading: boolean;
  /** The read failed: the page keeps its defaults and says nothing was saved. */
  isError: boolean;
  /** What the person saved, or null when they never chose. */
  saved: ReviewPreferences | null;
  groupBy: ReviewGroupBy;
  layoutOf: (pkg: ReviewPackage) => ReviewLayout;
  /** Save a whole choice (onboarding, Settings). */
  save: (next: ReviewPreferences) => Promise<void>;
  setGroupBy: (groupBy: ReviewGroupBy) => void;
  setLayout: (pkg: ReviewPackage, layout: ReviewLayout) => void;
  isSaving: boolean;
}

export function useReviewPreferences(): ReviewPreferencesState {
  const utils = trpc.useUtils();
  const prefs = trpc.preferences.get.useQuery(undefined, {
    staleTime: 60_000,
  });
  const mutation = trpc.preferences.updateReview.useMutation({
    // Shown at once; the read is refetched to what the pod kept.
    onMutate: (next) => {
      utils.preferences.get.setData(undefined, (old) =>
        old
          ? {
              ...old,
              uiPreferences: { ...(old.uiPreferences ?? {}), review: next },
            }
          : old
      );
    },
    onSettled: () => void utils.preferences.get.invalidate(),
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Your review settings were not saved",
        description: err.message,
        color: "danger",
      });
    },
  });

  const saved = readReviewPreferences(prefs.data?.uiPreferences);
  const groupBy = reviewGroupByFor(saved);

  async function save(next: ReviewPreferences) {
    await mutation.mutateAsync(next);
  }

  return {
    isLoading: prefs.isLoading,
    isError: prefs.isError,
    saved,
    groupBy,
    layoutOf: (pkg) => reviewLayoutFor(pkg, saved),
    save,
    setGroupBy: (next) =>
      void save({ ...(saved ?? {}), groupBy: next }).catch(() => {}),
    setLayout: (pkg, layout) =>
      void save({
        groupBy,
        layouts: { ...(saved?.layouts ?? {}), [pkg]: layout },
      }).catch(() => {}),
    isSaving: mutation.isPending,
  };
}
