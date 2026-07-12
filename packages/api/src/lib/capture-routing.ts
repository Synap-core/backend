/**
 * Capture workspace routing — THE ONE pure decision that picks which workspace a
 * capture lands in, shared by every door (MCP, REST, CLI, Raycast, import) so
 * routing behaves identically everywhere. Extracted from the router into this
 * leaf module so it's unit-testable in isolation (no DB / IS / config chain).
 *
 * Gate tunables come from the `ai-events` SSOT so this and routing-memory's
 * auto-tune floor can't drift.
 */

import {
  AUTO_ROUTE_MIN_CONFIDENCE,
  BYOA_DEFAULT_ROUTE_CONFIDENCE,
} from "./routing-tunables.js";

export type WorkspaceRoutingMode = "auto" | "ask" | "locked";

export interface CaptureRoutingResult {
  /** The workspace the entities will actually be created in. */
  workspaceId: string;
  /** Set when AUTO moved the capture off the ambient workspace. */
  movedToWorkspace?: string;
  /** Set in ASK mode — a suggestion the surface confirms before moving. */
  pendingWorkspaceSwitch?: {
    suggestedWorkspaceId: string;
    reason: string | null;
    confidence: number | null;
  };
}

/**
 * - AUTO (default): the AI's confidently-resolved target WINS over the ambient/
 *   session workspace, so a capture lands in the right domain without the user
 *   pinning it. Guarded: only moves on confidence ≥ the gate AND into a
 *   workspace the user is a member of.
 * - ASK (safe mode): never moves; surfaces `pendingWorkspaceSwitch` to confirm.
 * - LOCKED: never moves; the ambient/pinned workspace stands.
 */
export function resolveCaptureRouting(opts: {
  mode: WorkspaceRoutingMode;
  aiWorkspaceId?: string | null;
  aiConfidence?: number | null;
  aiReason?: string | null;
  currentWorkspaceId: string;
  memberWorkspaceIds: string[];
  /** Per-target-workspace auto-apply gate (auto-tuned from correction history);
   *  falls back to the flat AUTO_ROUTE_MIN_CONFIDENCE. */
  minConfidence?: number;
}): CaptureRoutingResult {
  const target = opts.aiWorkspaceId || undefined;
  if (!target || target === opts.currentWorkspaceId) {
    return { workspaceId: opts.currentWorkspaceId };
  }
  // A null confidence on an EXPLICIT target = a direct/BYOA caller that didn't
  // self-report — treat the deliberate pick as trustworthy (membership still
  // gates the move below). Interactive picks carry a real/derived confidence.
  const effectiveConfidence =
    opts.aiConfidence ?? BYOA_DEFAULT_ROUTE_CONFIDENCE;
  const gate = opts.minConfidence ?? AUTO_ROUTE_MIN_CONFIDENCE;
  if (
    opts.mode === "auto" &&
    effectiveConfidence >= gate &&
    opts.memberWorkspaceIds.includes(target)
  ) {
    return { workspaceId: target, movedToWorkspace: target };
  }
  if (opts.mode === "ask") {
    return {
      workspaceId: opts.currentWorkspaceId,
      pendingWorkspaceSwitch: {
        suggestedWorkspaceId: target,
        reason: opts.aiReason ?? null,
        confidence: opts.aiConfidence ?? null,
      },
    };
  }
  // LOCKED, or AUTO below-threshold / non-member → stay put.
  return { workspaceId: opts.currentWorkspaceId };
}
