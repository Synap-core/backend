/**
 * Document BASE REVISION — "was this edit drafted against the document as it is
 * now?"
 *
 * An AI document edit is drafted against one state of the document and applied
 * later: at approval (a proposal), or at the end of a request that read the
 * document first (the section write door). Anything a person saved in between
 * used to be silently overwritten.
 *
 * `documents.content_revision` is the signal: EVERY content write moves it,
 * because every content write goes through `claimDocumentRevision`
 * (@synap/database) — human autosaves included. The drafting side records the
 * revision it read (`baseRevision`); the applying side passes it to the claim,
 * whose compare-and-set refuses when the document moved.
 *
 * LEGACY: proposals filed before 0275 carry only `baseVersion`, the checkpoint
 * (`current_version`) they read. They are still compared on it — the check they
 * always had — and a proposal with neither applies unchecked, as it always did.
 * The pre-checks below run BEFORE any write so a refused apply changes
 * nothing; the claim's compare-and-set is what closes the race.
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

/** The content revision a proposal payload recorded, or `undefined` (filed before 0275). */
export function readProposalBaseRevision(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>).baseRevision;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

/** Throw CONFLICT when the document's content moved past `baseRevision`. */
export function assertDocumentBaseRevision(
  baseRevision: number,
  contentRevision: number
): void {
  if (contentRevision === baseRevision) return;
  throw new TRPCError({
    code: "CONFLICT",
    message:
      `This document changed after the edit was drafted (drafted against revision ${baseRevision}, ` +
      `now revision ${contentRevision}). Nothing was applied — reload the document and draft the edit again.`,
  });
}
