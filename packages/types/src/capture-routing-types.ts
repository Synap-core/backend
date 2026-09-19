/**
 * Capture routing — the ONE mapping from a `capture.structure` result to the
 * routing hints `capture.execute` takes.
 *
 * Every capture door (MCP, hub REST, the shared app capture pipeline, intake
 * UI, relay, CLI) forwards the structure step's placement advice to execute.
 * Each door used to hand-copy a different subset of fields, so the same
 * capture recorded different data depending on where it came from (only MCP
 * forwarded the decision distribution). Doors call `captureExecuteRoutingHints`
 * instead, so what reaches execute — and what the route decision event stores
 * — is identical everywhere.
 *
 * These are ADVISORY hints: execute's placement ladder decides (an AI pick
 * proposes a move, it never moves data). A user's deliberate choice is NOT a
 * hint — doors pass it as execute's `targetWorkspaceId` / `projectId`.
 *
 * Pure, dependency-free: safe in browser, Electron, React Native, Node, CLI.
 */

/**
 * The distribution behind an AI workspace pick, as the IS decision door
 * reported it: which decider answered (`jev` = the TypeSafe decision model,
 * `llm` = the cascade fallback), the model, the probability per candidate
 * workspace id (+ `none` for the decision model's abstain outcome) and the
 * candidate set it was asked over.
 */
export interface WorkspaceDecisionRecord {
  decider: "jev" | "llm";
  model?: string;
  probabilities?: Record<string, number>;
  candidates?: Array<{ id: string; name: string }>;
}

/** The placement advice a `capture.structure` result carries (a subset). */
export interface CaptureStructureRouting {
  targetWorkspaceId?: string | null;
  targetWorkspaceReason?: string | null;
  targetWorkspaceConfidence?: number | null;
  targetWorkspaceDecision?: WorkspaceDecisionRecord | null;
  targetProjectId?: string | null;
  targetProjectReason?: string | null;
  targetProjectConfidence?: number | null;
}

/** The advisory routing fields `capture.execute` accepts. */
export interface CaptureExecuteRoutingHints {
  aiWorkspaceId?: string | null;
  aiWorkspaceConfidence?: number | null;
  aiWorkspaceReason?: string | null;
  aiWorkspaceDecision?: WorkspaceDecisionRecord | null;
  aiProjectId?: string | null;
  aiProjectConfidence?: number | null;
  aiProjectReason?: string | null;
}

export function captureExecuteRoutingHints(
  structured: CaptureStructureRouting
): CaptureExecuteRoutingHints {
  return {
    aiWorkspaceId: structured.targetWorkspaceId,
    aiWorkspaceConfidence: structured.targetWorkspaceConfidence,
    aiWorkspaceReason: structured.targetWorkspaceReason,
    aiWorkspaceDecision: structured.targetWorkspaceDecision,
    aiProjectId: structured.targetProjectId,
    aiProjectConfidence: structured.targetProjectConfidence,
    aiProjectReason: structured.targetProjectReason,
  };
}

// ── Capture destination (structure → review → execute) ──────────────────────

/**
 * Where a capture will land, as `capture.structure` resolved it — the honest
 * replacement for reading the AI's pick out of `targetWorkspaceId`.
 */
export interface CapturePlacement {
  /**
   * Where the capture lands if no suggestion is applied: a deterministic
   * placement (explicit pin, ontology, focus session, relational), or the
   * ambient workspace. `null` = pod-wide.
   */
  workspaceId: string | null;
  workspaceName: string | null;
  /** A deterministic rung placed it — never an AI guess. */
  deterministic: boolean;
  /** The AI's suggestion — present only when it differs from `workspaceId`. */
  suggestion?: {
    workspaceId: string;
    workspaceName: string;
    reason: string | null;
    /**
     * Ranked options for the "Why?" disclosure, suggestion first, at most 3.
     * `weight` (0..1) sizes a bar; it is never rendered as a number.
     * Empty when the decider reported no distribution.
     */
    alternatives: Array<{
      workspaceId: string;
      workspaceName: string;
      weight: number;
    }>;
  };
}

/** What the person did with the destination field before saving. */
export type WorkspaceSelection =
  | { kind: "default" }
  | { kind: "chosen"; workspaceId: string; workspaceName: string }
  | { kind: "removed" };

/**
 * Recorded on the route decision: `accepted` = saved with the suggestion,
 * `changed` = picked another workspace, `removed` = dropped the suggestion
 * (stays where it would have landed), `ignored` = a headless door never
 * showed it (the suggestion stays a proposal).
 */
export type WorkspaceChoice = "accepted" | "changed" | "removed" | "ignored";

export interface WorkspacePlacementView {
  /** Where the capture will land if saved now. `workspaceId: null` = pod-wide / unknown. */
  destination: { workspaceId: string | null; workspaceName: string | null };
  /** The destination IS the AI's suggestion — show the AI mark. */
  aiSuggested: boolean;
  /** "Why?" rows (empty ⇒ no disclosure). */
  alternatives: NonNullable<CapturePlacement["suggestion"]>["alternatives"];
  /** The person can drop the suggestion ("Remove"). */
  canRemove: boolean;
  /** Placement fields for `capture.execute` (spread next to the routing hints). */
  execute: { targetWorkspaceId?: string; workspaceChoice?: WorkspaceChoice };
}

/**
 * THE destination rule — every capture surface derives its label, AI mark,
 * "Why?" rows and execute placement from this, never locally.
 *
 * `interactive`: the surface shows an editable destination before saving
 * (relay, browser/intake). There the suggestion is PRE-FILLED and saving
 * accepts it — the person saw it and could change it. A headless door (MCP,
 * CLI, REST) never applies a suggestion: it stays a proposal (`ignored`).
 * A deterministic placement is always sent as an explicit placement, so it is
 * never demoted to a suggestion at execute.
 */
export function deriveWorkspacePlacementView(
  placement: CapturePlacement | null | undefined,
  selection: WorkspaceSelection,
  opts: { interactive: boolean }
): WorkspacePlacementView {
  if (!placement) {
    // Older pod: no placement block — say nothing we cannot back up.
    return {
      destination: { workspaceId: null, workspaceName: null },
      aiSuggested: false,
      alternatives: [],
      canRemove: false,
      execute: {},
    };
  }
  const suggestion = placement.suggestion;
  const base = {
    workspaceId: placement.workspaceId,
    workspaceName: placement.workspaceName,
  };
  const pinBase = (): WorkspacePlacementView["execute"] =>
    placement.deterministic && placement.workspaceId
      ? { targetWorkspaceId: placement.workspaceId }
      : {};

  if (selection.kind === "chosen") {
    return {
      destination: {
        workspaceId: selection.workspaceId,
        workspaceName: selection.workspaceName,
      },
      aiSuggested: false,
      alternatives: suggestion?.alternatives ?? [],
      canRemove: false,
      execute: {
        targetWorkspaceId: selection.workspaceId,
        ...(suggestion
          ? {
              workspaceChoice:
                selection.workspaceId === suggestion.workspaceId
                  ? "accepted"
                  : "changed",
            }
          : {}),
      },
    };
  }

  if (selection.kind === "removed" || !suggestion || !opts.interactive) {
    const choice: WorkspaceChoice | undefined = !suggestion
      ? undefined
      : selection.kind === "removed"
        ? "removed"
        : "ignored";
    return {
      destination: base,
      aiSuggested: false,
      alternatives: suggestion?.alternatives ?? [],
      canRemove: false,
      execute: {
        // "Remove" keeps it where it would have landed, explicitly.
        ...(choice === "removed" && placement.workspaceId
          ? { targetWorkspaceId: placement.workspaceId }
          : pinBase()),
        ...(choice ? { workspaceChoice: choice } : {}),
      },
    };
  }

  // Interactive, untouched, with a suggestion: pre-filled, saving accepts it.
  return {
    destination: {
      workspaceId: suggestion.workspaceId,
      workspaceName: suggestion.workspaceName,
    },
    aiSuggested: true,
    alternatives: suggestion.alternatives,
    canRemove: true,
    execute: {
      targetWorkspaceId: suggestion.workspaceId,
      workspaceChoice: "accepted",
    },
  };
}
