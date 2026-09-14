/**
 * Document BASE VERSION — "was this edit drafted against the document as it is
 * now?"
 *
 * An AI document edit is drafted against one version of the document and
 * applied later: at approval (a proposal), or at the end of a request that read
 * the document first (the section write door). Anything a person saved in
 * between used to be silently overwritten — the approval uploaded the drafted
 * text over current storage and wrote `version + 1` without comparing.
 *
 * `documents.current_version` is the signal: every path that replaces stored
 * content bumps it (approval, version restore, the section door, snapshots).
 * The drafting side records the version it read; the applying side refuses when
 * the document has moved past it.
 */

import { TRPCError } from "@trpc/server";

/**
 * The base version a proposal payload recorded, or `undefined` when it has
 * none — a proposal filed before base versions were recorded. Such a proposal
 * applies exactly as it always did: there is nothing to compare against, and
 * refusing it would strand every pending edit on upgrade.
 */
export function readProposalBaseVersion(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>).baseVersion;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

/**
 * Throw CONFLICT when the document is no longer at `baseVersion`. Called BEFORE
 * any write, so a refused apply changes nothing.
 */
export function assertDocumentBaseVersion(
  baseVersion: number,
  currentVersion: number | null | undefined
): void {
  const current = currentVersion ?? 1;
  if (current === baseVersion) return;
  throw new TRPCError({
    code: "CONFLICT",
    message:
      `This document changed after the edit was drafted (drafted against version ${baseVersion}, ` +
      `now version ${current}). Nothing was applied — reload the document and draft the edit again.`,
  });
}
