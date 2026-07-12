/**
 * Capture workspace-routing gate — the pure rung-5 tie-break math shared by the
 * `WorkspaceResolutionService` door AND (via re-export) every capture surface.
 *
 * Home moved to @synap/database in Wave 1 so the door (which also lives here,
 * because @synap/jobs can't import @synap/api) reaches the SAME gate the capture
 * router used, without a second copy. `@synap/api`'s `lib/capture-routing.ts` is
 * now a thin re-export of this module, so existing imports + unit tests keep
 * passing unchanged. The two gate constants below are the SSOT; `@synap/api`'s
 * `lib/routing-tunables.ts` re-exports them (and derives the rest from them).
 *
 * ZERO DB / IO — a pure decision so the gate/mode/BYOA behaviour stays unit-
 * testable in isolation.
 */

/** Flat auto-apply floor: below this the AI's workspace guess can't override the ambient workspace. */
export const AUTO_ROUTE_MIN_CONFIDENCE = 0.6;
/** Baseline for an explicit direct/BYOA pick that carries no self-reported confidence. */
export const BYOA_DEFAULT_ROUTE_CONFIDENCE = 0.7;

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
