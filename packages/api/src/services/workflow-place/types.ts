/**
 * Workflow-place view-model — the DERIVED aggregate for one workflow's runtime
 * footprint (WORKFLOW-AS-PLACE, D1).
 *
 * A "workflow" is an automation OR a playbook (one word, "workflow" — the
 * ratified umbrella). This service does NOT introduce a third access lens: the
 * place is an OBSERVABILITY aggregation over runtime tables already keyed
 * (`playbookId`, `channelId`, `subjectType='focus_session'`, produced-`links`),
 * so there is ZERO access-seam change and ZERO migration.
 *
 * The user floor is the SAME predicate the runs substrate uses
 * (`userVisibleWhere`) — every derivation flows from user-floored session
 * visibility, which is also the security predicate for the workspace-less
 * `events` feed (see getWorkflowPlaceFeed).
 */

import type { UnifiedRun } from "../runs/types.js";

/** Which workflow kind this place aggregates. */
export type WorkflowKind = "automation" | "playbook";

/**
 * The workflow definition summary — kind-discriminated. Detail routers already
 * serve the full graph/stages; this is the header a place needs, plus the
 * monotonic `version` so "which definition is live" is legible.
 */
export interface WorkflowDefinition {
  id: string;
  kind: WorkflowKind;
  name: string;
  description: string | null;
  status: string;
  version: number;
  updatedAt: Date;
  // ── playbook-only ──────────────────────────────────────────────────────
  /** Ordered stage summaries (empty/absent for a progress-only playbook). */
  stages?: { key: string; label: string }[];
  /** Subject profile selector ({ profileSlug, filter? }) or null. */
  subjectProfile?: unknown | null;
  /** Which "hands" run this playbook (is-agent / external-agent / hybrid). */
  executor?: string;
  // ── automation-only ────────────────────────────────────────────────────
  /** Trigger discriminant (event / cron / webhook / manual). */
  triggerType?: string;
  /** Node count in the flow graph (not the full graph — detail routers serve that). */
  nodeCount?: number;
}

/**
 * A run of the workflow, enriched with the one attribution field
 * `UnifiedRun` does not carry: whether the run snapshotted its executed
 * definition.
 */
export interface WorkflowPlaceRun extends UnifiedRun {
  hasDefinitionSnapshot: boolean;
}

/** A focus-session instance of the workflow. */
export interface WorkflowSession {
  id: string;
  goal: string;
  status: string;
  startedAt: Date;
  closedAt: Date | null;
  channelId: string | null;
  subjectEntityId: string | null;
  projectId: string | null;
  currentStage: string | null;
  progress: number | null;
}

/** A channel that holds the workflow's activity. */
export interface WorkflowChannel {
  id: string;
  title: string | null;
  channelType: string;
  contextObjectType: string | null;
  contextObjectId: string | null;
}

/**
 * An entity produced by one of the workflow's sessions — the
 * `session --produced--> entity` provenance edge (the capture-back path writes
 * this exact shape). Only entities the user can still see are surfaced.
 */
export interface WorkflowResult {
  entityId: string;
  sessionId: string;
  title: string | null;
  /** Entity type slug (entities.type, populated from the profile slug). */
  type: string;
  producedAt: Date;
}

/**
 * A proposal attributed to the workflow via its sessions — enriched with
 * the `stepRunId`/`nodeId` step attribution when present, plus the two
 * quality signals the analyzer reads: why a proposal was rejected, and
 * what the human changed before approving (the strongest "the AI got this
 * wrong" signal).
 */
export interface WorkflowProposal {
  id: string;
  proposalType: string;
  status: string;
  targetType: string;
  targetId: string;
  sessionId: string | null;
  stepRunId: string | null;
  nodeId: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  revisionHistory: unknown[];
}

/** One workflow's place — its runs, sessions, channels, results, proposals. */
export interface WorkflowPlace {
  definition: WorkflowDefinition;
  runs: WorkflowPlaceRun[];
  sessions: WorkflowSession[];
  channels: WorkflowChannel[];
  results: WorkflowResult[];
  proposals: WorkflowProposal[];
}

// ── Per-workflow event feed ──────────────────────────────────────────────────

/** One entry in the workflow's derived event feed (a focus-session event). */
export interface WorkflowFeedItem {
  id: string;
  at: Date;
  /** The event action — the `events.type` column (NOT `action`). */
  type: string;
  /** The focus session this event is about (events.subjectId). */
  sessionId: string;
  data: Record<string, unknown> | null;
  correlationId: string | null;
}

/** A page of the workflow's event feed, newest-first, cursor-paginated. */
export interface WorkflowPlaceFeed {
  items: WorkflowFeedItem[];
  /** Opaque cursor for the next (older) page, or null when exhausted. */
  nextCursor: string | null;
}
