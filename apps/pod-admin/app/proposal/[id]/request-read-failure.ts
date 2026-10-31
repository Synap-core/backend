/**
 * A request that could not be shown, told apart (start-here: "an EMPTY result
 * and a FAILED read are different facts"). Until 2026-10-30 the request page
 * and the Review drawer folded every failure into "it may have been
 * withdrawn, or you may not have access", with no way to try again: a pod that
 * did not answer read as a request that was gone.
 *
 * The titles come from the shared object door (`loadFailure`, the words every
 * `/open` page uses); the sentences are this page's, in its catalog. Only a
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
  };
  if (!error) return { ...notFound("Request", wording), retry: false };
  const failure = loadFailure(error, "Request", wording)!;
  return {
    ...failure,
    retry: !ANSWERED_CODES.has(error.data?.code ?? ""),
  };
}
