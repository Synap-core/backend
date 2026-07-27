/**
 * Enrichment — shared core for "run an enrichment verb, then propose its data".
 *
 * The `capabilities.enrichEntity` door ("Enrich this record") and the
 * `capabilities.importContact` door (import-from-a-LinkedIn-URL) do the SAME two
 * governed things: (1) run an enrichment VERB through the shared `executeCapability`
 * core, then (2) file the scraped fields onto a target entity as a reviewable
 * proposal via the ONE governance door (`checkPermissionOrPropose`, `forcePropose`
 * — machine-sourced data is always reviewed, never silently written), stamped with
 * a run session so the write groups under one reviewable card.
 *
 * These helpers are that shared spine — extracted so the two doors compose them
 * instead of copy-pasting the verb-outcome mapping and the propose/session logic.
 */

import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { executeCapability } from "./execute-capability.js";

// ─── Enrichment result normalization ──────────────────────────────────────────

/**
 * Run-metadata envelope keys a verb result carries ALONGSIDE the real entity
 * properties (`code` verbs return `{ matched, fields, url, … }` around their
 * normalized fields; a `declarative` verb returns a pure scalar map, for which
 * this is a no-op). This is the single copy — both enrichment doors strip through
 * this normalizer rather than re-deriving the meta-key set.
 */
export const ENRICH_META_KEYS = new Set([
  "matched",
  "fields",
  "success",
  "proposed",
  "proposalId",
  "url",
  // The scraped person NAME is the entity TITLE, not a property — the
  // create-from-URL flow (importContact) uses it to title a new contact; on the
  // update path it must never leak in as a redundant `scrapedName` property.
  "scrapedName",
]);

/** Strip the run-metadata envelope + empty values → writable entity properties. */
export function normalizeVerbResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const mapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (ENRICH_META_KEYS.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    mapped[k] = v;
  }
  return mapped;
}

// ─── Verb run ──────────────────────────────────────────────────────────────────

/**
 * The outcome of running an enrichment verb through the shared governed core,
 * mapped to the enrichment doors' vocabulary:
 *   - `ran`           the verb reached its handler and succeeded; `result` carries
 *                     the raw scraped payload (title `scrapedName` + fields).
 *   - `setup_required` the capability isn't installed/connected here (`not_found`);
 *                     the UI routes this to Settings.
 *   - `denied`        governance denied the run.
 *   - `failed`        the verb ran and its handler FAILED (provider 400, etc.).
 *   - `verb_proposed` the verb's OWN run was governance-queued (a non-owner
 *                     running a pod-wide verb); there is no data to write yet —
 *                     surface the verb proposal so the client renders the review.
 */
export type EnrichmentVerbOutcome =
  | { status: "ran"; result: unknown }
  | { status: "setup_required"; message?: string }
  | { status: "denied"; message: string }
  | { status: "failed"; message: string }
  | { status: "verb_proposed"; proposalId: string; reviewUrl: string };

/**
 * Run an enrichment verb through `executeCapability` (the shared governed core)
 * and map its discriminated result to `EnrichmentVerbOutcome`. The session opens
 * only AFTER a `ran` outcome in the caller: a `setup_required`/`denied`/`failed`
 * must not litter the feed with an empty receipt.
 */
export async function runEnrichmentVerb(input: {
  verbId: string;
  parameters?: Record<string, unknown>;
  /** Where the run + gate are scoped (the ENTITY's own workspace, or pod-wide). */
  workspaceId: string | null;
  userId: string;
}): Promise<EnrichmentVerbOutcome> {
  const res = await executeCapability({
    verbId: input.verbId,
    parameters: input.parameters,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  switch (res.kind) {
    // `not_found` = "capability isn't installed/connected here" → Settings.
    case "not_found":
      return { status: "setup_required", message: res.message };
    case "deny":
      return { status: "denied", message: res.reason };
    // The verb RAN and its handler FAILED (a code skill's sandbox returned
    // success:false, or a declarative provider verb returned an error envelope).
    // executeCapability surfaces this as the ONE `kind:"error"` channel, so the
    // failure text never leaks into the entity as a proposed `error` property.
    case "error":
      return { status: "failed", message: res.message };
    // The verb's own run was governance-queued (non-owner running a pod-wide verb).
    case "proposed":
      return {
        status: "verb_proposed",
        proposalId: res.proposalId,
        reviewUrl: res.reviewUrl,
      };
    case "run":
      // executeCapability already UNWRAPPED the sandbox envelope: a successful
      // code verb hands back its DATA directly as `res.result`.
      return { status: "ran", result: res.result };
    // `dry-run` is never requested by the enrichment doors. Fail loud if the
    // executor's contract ever grows a case a door doesn't handle.
    default:
      throw new Error(
        `runEnrichmentVerb: unexpected verb result "${(res as { kind: string }).kind}"`
      );
  }
}

// ─── Proposal filing ─────────────────────────────────────────────────────────

/** The outcome of filing scraped fields onto an entity as a governed proposal. */
export type FileEnrichmentOutcome =
  | { status: "empty"; fieldCount: 0 }
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl: string;
      fieldCount: number;
    };

/** Denied by governance — the caller may not write to this entity's workspace. */
export class EnrichmentProposalDeniedError extends Error {}

/**
 * File the normalized enrichment fields onto `entityId` as a reviewable proposal.
 *
 * The governed write — the SAME shape `entities.update` uses. `forcePropose`: the
 * operator launched the run, but the DATA came from a provider, so it lands as a
 * reviewable proposal, sessionId-stamped so it groups under the run's card.
 *
 * `mapped` empty → nothing to write, returns `empty` (caller decides what that
 * means for its mode). On denial throws `EnrichmentProposalDeniedError`; the
 * unreachable auto-grant (forcePropose can only RAISE governance) throws loud
 * rather than silently dropping the enriched fields.
 */
export async function fileEnrichmentProposal(input: {
  entityId: string;
  mapped: Record<string, unknown>;
  sessionId: string;
  /** The entity's OWN workspace (or null pod-wide) — decides where it lands. */
  workspaceId: string | null;
  userId: string;
  reasoning?: string;
}): Promise<FileEnrichmentOutcome> {
  const fieldCount = Object.keys(input.mapped).length;
  if (fieldCount === 0) {
    return { status: "empty", fieldCount: 0 };
  }

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    workspaceId: input.workspaceId,
    subjectType: "entity",
    action: "update",
    source: "ai",
    forcePropose: true,
    sessionId: input.sessionId,
    reasoning: input.reasoning ?? "Data enrichment",
    data: { id: input.entityId, properties: input.mapped },
  });

  if ("denied" in perm && perm.denied) {
    throw new EnrichmentProposalDeniedError(perm.reason);
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      reviewUrl: perm.reviewUrl,
      fieldCount,
    };
  }

  // Unreachable: `forcePropose:true` on a machine-sourced write always proposes
  // (the gate can only RAISE governance). Reaching here means the gate contract
  // changed under us — fail loud rather than silently drop the enriched fields.
  throw new Error(
    "fileEnrichmentProposal: forcePropose write was unexpectedly auto-granted"
  );
}
