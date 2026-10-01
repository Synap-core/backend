/**
 * Phase 4 — AUTO-INSTALL PROPOSAL ON AN INTENT GAP.
 *
 * A workspace DECLARES `taskIntents` (what it needs to function). Phase 3's
 * `workspaceIntentCoverage` joins that against what is installed and reports the
 * GAP. This module turns a gap into a REVIEWABLE PROPOSAL to install a
 * capability that provides it — never an install.
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────
 * It never installs. It never creates an entity. It never touches a workspace.
 * The ONLY thing it writes is one `proposals` row, and it writes it through the
 * SAME `createPendingProposal` seam `runMarketInstall` uses — so approval
 * replays the existing `capability.install` approve executor, which calls
 * `applyMarketInstall`, the identical applier an operator's own install runs. An
 * approved agent install therefore cannot diverge from a human's.
 *
 * ── WHY NOT `checkPermissionOrPropose` (the brief asked for it; the repo says no) ──
 * There is NO `capability/install` entry in `GATE_WRITE_DOORS`
 * (@synap/governance-policy) — the capability doors are `attach`, `create`,
 * `renderer.set` — so `checkPermissionOrPropose` cannot type-check for this
 * write, and adding the key would widen `GovernedWritePair`, i.e. the type of
 * EVERY gate call site in the repo. That is a governance-schema change, not a
 * routing one, and it is not this change's to make silently.
 *
 * The repo has already settled this question for the sibling writes, in writing:
 *   - `runMarketInstall`: an agent install ALWAYS proposes, filed directly.
 *   - `propose-capability-enable`: "Deliberately NOT `checkPermissionOrPropose`:
 *     that ladder can answer `granted` for an agent (a widening governance rule,
 *     autoApproveFor), and a granted enable is an auto-enable."
 * Both reasons apply verbatim here — a gate that could answer `granted` would
 * turn an install into a silent provisioning, which is precisely the thing this
 * module exists to prevent. So this file follows the precedent rather than
 * inventing a door.
 *
 * ── SELF-HEALING / RECOVERABLE (founder requirement) ─────────────────────────
 * The founder's words: "there is no blocker for publishing a marketplace. It is
 * recoverable easily and properly easily self-healing if the user does not
 * precise something." Concretely:
 *   - NOTHING is created while COMPUTING the proposal. No entity, no workspace,
 *     no partial pack. A throw before the single INSERT leaves the pod exactly
 *     as it was.
 *   - The proposal row is INERT. Rejecting or ignoring it changes nothing;
 *     only a human's approval replays the install.
 *   - An install already made is idempotent at the applier
 *     (`applyMarketInstall` is idempotent per kind), so a stale proposal that
 *     later gets approved converges instead of duplicating.
 *   - `createPendingProposal` dedups an agent row by the SSOT hash, so being
 *     asked twice for the same gap files ONE request, not a queue of them.
 *
 * ── NO HARDCODED PROVIDER MAP ────────────────────────────────────────────────
 * Candidates are DISCOVERED from `cp_catalog_cache` by reading each entry's
 * declared `provides`. There is no slug→vendor table, no per-workspace branch,
 * and no "if intent is generate_media, suggest remotion" rule anywhere in this
 * file. A pack that declares `provides: ["generate_media"]` becomes a candidate
 * for `generate_media` purely by declaring it.
 */

import { createPendingProposal } from "../../utils/permission-check.js";
import { openLink } from "../../utils/deep-links.js";
import type { CatalogCacheEntry } from "./catalog-cache-query.js";

/** One marketplace pack that declares `intent` in its `provides`. */
export interface IntentProviderCandidate {
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
}

/**
 * Read a cache entry's declared `provides`, if it has one.
 *
 * `provides` is a CP-side authoring field (`CapabilityDefinition.provides`),
 * hoisted so "what can satisfy this?" is answerable by reading one field. The
 * pod stores the entry's whole `CapabilityDefinition` in `cp_catalog_cache
 * .definition`, so it is present for any capability the CP listed with its
 * definition inline.
 *
 * ⚠️ An entry with NO readable `provides` is `null`, NOT `[]`. "This pack does
 * not declare it" and "this pack's declaration could not be read" are different
 * facts, and returning `[]` for both would silently shrink the candidate pool
 * into looking like a genuine absence.
 */
export function declaredProvides(
  entry: Pick<CatalogCacheEntry, "definition">
): string[] | null {
  const raw = entry.definition?.provides;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  for (const v of raw) if (typeof v === "string" && v) seen.add(v);
  return [...seen];
}

/**
 * Which cached packs can serve `intent` — PURE, so the selection rule is
 * testable without a database and without a catalog fetch.
 *
 * A pack qualifies ONLY by an explicit `provides` entry containing the slug.
 * There is no name/description substring matching here on purpose: that is what
 * `findByIntent`'s marketplace arm does for a fuzzy free-text query, and it is
 * how "post" once matched unrelated packages. A gap is a precise, machine-declared
 * requirement — a pack qualifies when it SAYS it provides the thing.
 *
 * `alreadyInstalled` is passed in (not looked up) so the caller can exclude the
 * caller's own installs with the SAME lens the coverage read used. A pack the
 * caller already has is not a proposal to make.
 */
export function selectIntentProviders(input: {
  entries: readonly CatalogCacheEntry[];
  intent: string;
  /** Slugs already installed under the caller's lens. */
  alreadyInstalled?: ReadonlySet<string>;
}): { candidates: IntentProviderCandidate[]; unreadable: string[] } {
  const candidates: IntentProviderCandidate[] = [];
  const unreadable: string[] = [];
  for (const entry of input.entries) {
    if (entry.kind !== "capability") continue;
    if (input.alreadyInstalled?.has(entry.slug)) continue;
    const provides = declaredProvides(entry);
    // Tracked, not silently dropped: a pack whose declaration we cannot read is
    // a blind spot in the search, and the caller is told how wide it was.
    if (provides === null) {
      unreadable.push(entry.slug);
      continue;
    }
    if (!provides.includes(input.intent)) continue;
    candidates.push({
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      version: entry.version,
    });
  }
  return { candidates, unreadable };
}

/** What a caller's gap-resolution attempt produced. Exactly one arm fires. */
export type IntentInstallOffer =
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl: string;
      intent: string;
      slug: string;
      capabilityName: string;
      /** Candidates also seen, so a reviewer can pick a different one. */
      alternatives: IntentProviderCandidate[];
      /** Packs whose `provides` could not be read — the search was not total. */
      unreadable: string[];
      /** Nothing ran. A literal, so it can never be misread as installed. */
      originalActionRan: false;
      message: string;
    }
  | {
      status: "no_provider";
      intent: string;
      /** Packs whose declaration was unreadable — why "nothing" might be wrong. */
      unreadable: string[];
      message: string;
    }
  | {
      status: "failed";
      intent: string;
      error: string;
      message: string;
    };

export const GAP_INSTALL_PROPOSED_NOT_RUN =
  "Nothing ran: a request to install a capability providing this intent is waiting for review.";

export const GAP_INSTALL_FAILED_NOT_RUN =
  "Nothing ran: the install request could not be filed. Ask the user to install a capability that provides this intent (Settings → Capabilities).";

/**
 * File ONE `capability.install` proposal for a gap, using the SAME pending-row
 * shape `runMarketInstall` produces (`data.slug` + `data.kind`), so the existing
 * approve executor applies it with no new executor and no new proposal type.
 *
 * Only the FIRST candidate is proposed — a review queue is for a decision, not a
 * menu. The rest ride along in `data.alternatives` so the reviewer can re-point
 * it without a second round trip.
 */
export async function proposeIntentGapInstall(input: {
  intent: string;
  candidates: readonly IntentProviderCandidate[];
  unreadable?: readonly string[];
  userId: string;
  workspaceId: string | null;
  /** The acting agent, when this originates from an agent. Null = owner-attributed. */
  agentUserId?: string | null;
  sessionId?: string | null;
}): Promise<IntentInstallOffer> {
  const chosen = input.candidates[0];
  if (!chosen) {
    return {
      status: "no_provider",
      intent: input.intent,
      unreadable: [...(input.unreadable ?? [])],
      message:
        `Nothing ran: no marketplace capability declares the intent "${input.intent}". ` +
        (input.unreadable?.length
          ? `${input.unreadable.length} cached pack(s) could not be read for a declaration, so this is a best-effort answer. `
          : "") +
        `Record the gap with the tool.request verb, or ask the user to install a capability that provides it.`,
    };
  }

  try {
    const alternatives = input.candidates.slice(1);
    const title = `Install "${chosen.name}" for intent "${input.intent}"`;
    const proposal = await createPendingProposal({
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentUserId: input.agentUserId ?? null,
      targetType: "capability",
      targetId: `market:capability:${chosen.slug}`,
      proposalType: "capability.install",
      sessionId: input.sessionId ?? null,
      data: {
        slug: chosen.slug,
        kind: "capability",
        version: chosen.version ?? null,
        params: {},
        // Why this proposal exists, so the reviewer sees the GAP not just an
        // install request. `intent` is the join key Phase 4 was asked to close.
        intent: input.intent,
        ...(alternatives.length > 0
          ? {
              alternatives: alternatives.map((a) => ({
                slug: a.slug,
                name: a.name,
              })),
            }
          : {}),
        ...(input.unreadable?.length
          ? { unreadableProviders: [...input.unreadable] }
          : {}),
        summary: title,
      },
      notificationDescription: title,
    });
    return {
      status: "proposed",
      proposalId: proposal.id,
      reviewUrl: openLink(proposal.id),
      intent: input.intent,
      slug: chosen.slug,
      capabilityName: chosen.name,
      alternatives,
      unreadable: [...(input.unreadable ?? [])],
      originalActionRan: false,
      message: GAP_INSTALL_PROPOSED_NOT_RUN,
    };
  } catch (err) {
    // A failed FILING is not a refusal and not an install. It surfaces as its own
    // arm so a caller cannot read it as "nothing to install".
    return {
      status: "failed",
      intent: input.intent,
      error: err instanceof Error ? err.message : String(err),
      message: GAP_INSTALL_FAILED_NOT_RUN,
    };
  }
}

/**
 * Resolve ONE gap end-to-end: read the catalog, select candidates, and either
 * propose or say plainly that nothing provides the intent.
 *
 * Read-only until the single proposal INSERT — see the self-healing note in the
 * module docblock.
 */
export async function resolveIntentGap(input: {
  intent: string;
  userId: string;
  workspaceId: string | null;
  agentUserId?: string | null;
  sessionId?: string | null;
  /** Slugs already installed under the caller's lens. */
  alreadyInstalled?: ReadonlySet<string>;
}): Promise<IntentInstallOffer> {
  let entries: CatalogCacheEntry[];
  try {
    const { queryCatalogCache } = await import("./catalog-cache-query.js");
    entries = await queryCatalogCache({ kind: "capability" });
  } catch (err) {
    // A catalog read that FAILED is not "no provider exists". It is its own arm,
    // never folded into `no_provider` — that collapse is exactly the "empty vs
    // failed" defect this codebase has shipped three times.
    return {
      status: "failed",
      intent: input.intent,
      error: err instanceof Error ? err.message : String(err),
      message:
        "Nothing ran: the marketplace catalog could not be read, so it is unknown whether a capability provides this intent. Try again, or ask the user.",
    };
  }
  const { candidates, unreadable } = selectIntentProviders({
    entries,
    intent: input.intent,
    ...(input.alreadyInstalled
      ? { alreadyInstalled: input.alreadyInstalled }
      : {}),
  });
  return proposeIntentGapInstall({
    intent: input.intent,
    candidates,
    unreadable,
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentUserId: input.agentUserId ?? null,
    sessionId: input.sessionId ?? null,
  });
}
