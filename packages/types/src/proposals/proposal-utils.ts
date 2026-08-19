/**
 * Proposal Display Utilities
 *
 * Shared helpers for resolving human-readable names, titles, and descriptions
 * from proposal data. Single source of truth for all proposal UI components.
 *
 * These are pure functions with no runtime dependencies — safe to import
 * from browser, Electron, and server contexts.
 */

import {
  buildObjectActionTitle,
  resolveObjectNoun,
} from "../vocabulary/index.js";

/**
 * Determine if a string looks like a UUID (v4 hex format).
 * Used to decide whether to show a raw ID or attempt name resolution.
 */
export function isLikelyUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s
  );
}

/**
 * Resolve a human-readable author name from proposal data.
 *
 * Priority:
 *  1. Explicit author name (if provided by backend or sender)
 *  2. AI Agent / System label (based on source field)
 *  3. Non-UUID sourceId (e.g. a username or email)
 *  4. Fallback: "User" or "AI Agent"
 */
export function resolveAuthorName(params: {
  authorName?: string | null;
  source?: string;
  sourceId?: string | null;
}): string {
  const { authorName, source, sourceId } = params;

  // 1. Explicit author name (e.g. from workspace member lookup)
  if (typeof authorName === "string" && authorName) return authorName;

  // 2. AI or system source
  const isAI = source === "ai" || source === "intelligence";
  if (isAI) return "AI Agent";
  if (source === "system") return "System";

  // 3. Non-UUID sourceId (human-readable identifier like username)
  const rawId = sourceId ?? "";
  if (rawId && !isLikelyUUID(rawId)) return rawId;

  // 4. Final fallback
  return isAI ? "AI Agent" : "User";
}

/**
 * Resolve a human-readable target name from proposal data.
 *
 * Priority:
 *  1. Explicit targetName from the request envelope
 *  2. Name/title/displayName from entity payload
 *  3. Fallback: "<targetType> · <truncatedId>"
 */
export function resolveTargetName(params: {
  targetName?: string | null;
  targetType?: string;
  targetId?: string;
  entityPayload?: Record<string, unknown> | null;
}): string {
  const { targetName, targetType, targetId, entityPayload } = params;

  // 1. Backend-provided target name
  if (typeof targetName === "string" && targetName) return targetName;

  // 2. Extract from entity payload
  if (entityPayload) {
    const name =
      (typeof entityPayload.name === "string" && entityPayload.name) ||
      (typeof entityPayload.title === "string" && entityPayload.title) ||
      (typeof entityPayload.displayName === "string" &&
        entityPayload.displayName);
    if (name) return name;
  }

  // 3. Fallback: type + truncated ID
  const type = targetType || "entity";
  const id = targetId ? targetId.slice(0, 8) : "";
  return id ? `${type} · ${id}` : type;
}

/**
 * Build a fallback title from proposal metadata.
 * Used when no explicit summary or name is available.
 *
 * Composition now delegates to the vocabulary SSOT (`../vocabulary`) instead of
 * hand-rolling the verb/noun casing here. That fixed three defects this
 * function shipped:
 *   1. a capability RUN titled "Update Capability" — it runs a call, it updates
 *      nothing. `changeType` is defaulted to "update" upstream for any payload
 *      that carries none, so the ACTION must prefer `proposalType`.
 *   2. `targetType` was never de-underscored, so users saw "Focus_session" and
 *      "Property_def" while `changeType` right beside it was cleaned.
 *   3. the `.replace(/  +/, " ")` band-aid — the tell of positional string
 *      concat with a possibly-empty middle. Composition handles it now.
 */
export function buildFallbackTitle(params: {
  changeType?: string;
  profileSlug?: string;
  targetType?: string;
  targetName?: string;
  /** The proposal's own type (e.g. `run`, `capability.run`) — preferred over
   *  `changeType`, which is unreliable (see defect 1 above). */
  proposalType?: string;
}): string {
  const { changeType, profileSlug, targetType, targetName, proposalType } =
    params;

  if (!changeType && !proposalType) {
    // Preserve the historical shape: with no action at all this produced
    // "Proposal" (optionally with a type label), never a bare noun.
    const noun =
      profileSlug ?? (targetType !== "entity" ? targetType : undefined);
    return noun ? `Proposal ${resolveObjectNoun(noun)}` : "Proposal";
  }

  return buildObjectActionTitle({
    action: proposalType,
    fallbackAction: changeType,
    objectKind: profileSlug ?? targetType,
    objectName: targetName,
  });
}
