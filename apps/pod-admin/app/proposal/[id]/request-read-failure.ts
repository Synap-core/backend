/**
 * A request that could not be shown, told apart (start-here: "an EMPTY result
 * and a FAILED read are different facts"). Until 2026-10-30 the request page
 * and the Review drawer folded every failure into "it may have been
 * withdrawn, or you may not have access", with no way to try again: a pod that
 * did not answer read as a request that was gone.
 *
 * The shape comes from the shared object door (`loadFailure`, what every
 * `/open` page uses); the titles and sentences are this page's, in its
 * catalog, so a French reader's first screen is French throughout. Only a
 * read that FAILED offers Try again: a missing request or a refusal answers
 * the same on every retry.
 */

import {
  loadFailure,
  notFound,
  type LoadFailure,
  type TrpcErrorLike,
} from "../../_lib/object/load-failure";
import { proposalPageT } from "./copy";

export interface RequestReadFailure extends LoadFailure {
  retry: boolean;
}

const ANSWERED_CODES: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
]);

/**
 * What to show when the request is not on screen: `null` while it is. A read
 * that succeeded with nothing is the request not being there.
 */
export function requestReadFailure(
  error: TrpcErrorLike,
  hasData: boolean
): RequestReadFailure | null {
  if (!error && hasData) return null;
  const t = proposalPageT();
  const wording = {
    inApp: false,
    notFound: t("read.notFound"),
    forbidden: t("read.forbidden"),
    failed: t("read.failed"),
    titles: {
      notFound: t("read.notFound.title"),
      forbidden: t("read.forbidden.title"),
      failed: t("read.failed.title"),
    },
  };
  if (!error) return { ...notFound("Request", wording), retry: false };
  // Shown for a beat before the page bounces to sign in.
  if (error.data?.code === "UNAUTHORIZED") {
    return {
      title: t("read.signIn.title"),
      message: t("read.signIn"),
      chip: t("read.signIn.title"),
      retry: false,
    };
  }
  const failure = loadFailure(error, "Request", wording)!;
  return {
    ...failure,
    retry: !ANSWERED_CODES.has(error.data?.code ?? ""),
  };
}
