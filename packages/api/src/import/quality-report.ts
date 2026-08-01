/**
 * Import quality report — pure module for continuous improvement.
 *
 * Given a structured import graph (ops + corpus map + homes), produces a
 * machine-readable + human-readable report so the user can:
 *   refuse → inspect → adjust (home-map, re-run) → apply when pleased.
 *
 * No I/O. Composable: used by analyze, CLI, future UI/digest.
 */

import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import type { ImportHomesSummary } from "../services/import/structuring.js";

export type QualitySeverity = "info" | "warn" | "blocker";

export type QualityFinding = {
  id: string;
  severity: QualitySeverity;
  message: string;
  /** Optional metric for dashboards */
  metric?: number;
};

export type ImportQualityReport = {
  /** 0–100 composite score (heuristic, not academic) */
  score: number;
  summary: string;
  counts: {
    filesProcessed?: number;
    filesFailed?: number;
    createEntities: number;
    createRelations: number;
    containers: number;
    contentEntities: number;
    linkedExisting: number;
    byProfile: Record<string, number>;
    /**
     * Entities the schema preflight could not materialize under their extracted
     * profile and which were emitted as notes instead. >0 means the extraction
     * under-filled a profile's required properties.
     */
    degradedToNote?: number;
    /** Entities that carry a long-form body (a linked document on materialize). */
    withContent: number;
    /** Non-container entities that carry at least one property. */
    withProperties: number;
  };
  hierarchy: {
    containerCount: number;
    parentOfEdges: number;
    filesWithContainer?: number;
    intentCounts?: Record<string, number>;
  };
  homes: {
    multiHome: boolean;
    byWorkspace: Record<string, number>;
    podWide: number;
    byProject: Record<string, number>;
  };
  findings: QualityFinding[];
  /** Ordered upgrade suggestions for the refuse→improve loop */
  nextUpgrades: string[];
};

export type QualityReportInput = {
  operations: CompositeProposalOperation[];
  homes?: ImportHomesSummary | null;
  stats?: Record<string, unknown> | null;
  corpusMap?: {
    folders?: number;
    containers?: number;
    intentCounts?: Record<string, number>;
    filesLinkedToContainer?: number;
  } | null;
  itemCount?: number;
};

function isCreate(
  op: CompositeProposalOperation
): op is Extract<CompositeProposalOperation, { op: "create_entity" }> {
  return op.op === "create_entity";
}

/**
 * Build a quality report from a proposed import graph.
 */
export function buildImportQualityReport(
  input: QualityReportInput
): ImportQualityReport {
  const ops = input.operations ?? [];
  const creates = ops.filter(isCreate);
  const relations = ops.filter((o) => o.op === "create_relation");
  const parentOf = relations.filter(
    (o) => o.op === "create_relation" && o.type === "parent_of"
  );

  const byProfile: Record<string, number> = {};
  let containers = 0;
  let contentEntities = 0;
  let linkedExisting = 0;
  let withContent = 0;
  let withProperties = 0;

  for (const op of creates) {
    byProfile[op.profileSlug] = (byProfile[op.profileSlug] ?? 0) + 1;
    const isCont =
      op.properties?.isContainer === true ||
      typeof op.properties?.corpusIntent === "string";
    if (isCont) containers++;
    else {
      contentEntities++;
      // Fill measured on CONTENT entities only — a corpus-map container's
      // properties are structural bookkeeping, not extracted knowledge.
      if (op.content && op.content.trim().length > 0) withContent++;
      if (op.properties && Object.keys(op.properties).length > 0)
        withProperties++;
    }
    if (op.existingEntityId) linkedExisting++;
  }

  const homes = input.homes ?? {
    byWorkspace: {},
    podWide: 0,
    byProject: {},
    multiHome: false,
  };

  const stats = input.stats ?? {};
  const filesProcessed =
    typeof stats.itemsProcessed === "number"
      ? stats.itemsProcessed
      : input.itemCount;
  const filesFailed =
    typeof stats.itemsFailed === "number" ? stats.itemsFailed : undefined;

  const findings: QualityFinding[] = [];
  const nextUpgrades: string[] = [];

  // --- findings ---
  if (creates.length === 0) {
    findings.push({
      id: "empty-graph",
      severity: "blocker",
      message:
        "No entities proposed — refuse and check source files / AI structure.",
    });
  }

  if (containers === 0 && (input.itemCount ?? 0) > 5) {
    findings.push({
      id: "no-containers",
      severity: "warn",
      message:
        "No folder containers detected. Hierarchy will be weak — check path structure or intent heuristics.",
      metric: 0,
    });
    nextUpgrades.push(
      "Ensure vault paths have meaningful folders (Projects/X, …) or improve intent tags."
    );
  }

  if (parentOf.length === 0 && containers > 1) {
    findings.push({
      id: "no-hierarchy-edges",
      severity: "warn",
      message: "Multiple containers but no parent_of edges between them.",
    });
  }

  if (filesFailed && filesFailed > 0) {
    findings.push({
      id: "structure-failures",
      severity: "warn",
      message: `${filesFailed} file(s) failed deep structure (timeouts/empty).`,
      metric: filesFailed,
    });
    nextUpgrades.push(
      "Re-run failed paths alone, or raise timeouts / use analyzeLarge for big notes."
    );
  }

  if (homes.podWide > 0 && Object.keys(homes.byWorkspace).length === 0) {
    findings.push({
      id: "all-pod-wide",
      severity: "info",
      message:
        "All entities are pod-wide (no workspace pins). Use --home-map or path segments matching workspace names for multi-home.",
      metric: homes.podWide,
    });
    nextUpgrades.push(
      'Pass --home-map "Projects=Builder,Posts=Content OS" if folders should map to workspaces.'
    );
  }

  if (homes.multiHome) {
    findings.push({
      id: "multi-home",
      severity: "info",
      message: `Multi-home graph: ${Object.keys(homes.byWorkspace).length} workspace(s) + ${homes.podWide} pod-wide.`,
    });
  }

  const contentWithoutProfileVariety =
    Object.keys(byProfile).length <= 1 && contentEntities > 10;
  if (contentWithoutProfileVariety) {
    findings.push({
      id: "low-type-diversity",
      severity: "warn",
      message:
        "Almost all content is one profile type — extraction may be shallow (mostly notes).",
    });
    nextUpgrades.push(
      "Sample refuse → re-run with richer notes, or tighten structure prompts later."
    );
  }

  const degradedToNote =
    typeof stats.degradedToNote === "number" ? stats.degradedToNote : undefined;
  if (degradedToNote && degradedToNote > 0) {
    const byProfileDetail =
      stats.degradedByProfile && typeof stats.degradedByProfile === "object"
        ? Object.entries(stats.degradedByProfile as Record<string, number>)
            .map(([slug, n]) => `${slug}×${n}`)
            .join(", ")
        : "";
    findings.push({
      id: "schema-degraded-to-note",
      severity: "warn",
      message: `${degradedToNote} entity(ies) could not satisfy their profile's required properties and were filed as notes${byProfileDetail ? ` (${byProfileDetail})` : ""}. Title + body are preserved; the typing is not.`,
      metric: degradedToNote,
    });
    nextUpgrades.push(
      "Check that those profiles' required properties are extractable from the source prose (or relax `required` on the profile) — nothing is fabricated to satisfy a schema."
    );
  }

  // Fill honesty: entities with neither properties nor a body are titles with
  // nothing behind them — `synap ask` would retrieve a headline and no content.
  const emptyContentEntities = contentEntities - Math.max(withContent, 0);
  if (
    contentEntities > 0 &&
    withProperties === 0 &&
    withContent === 0 &&
    emptyContentEntities > 0
  ) {
    findings.push({
      id: "no-entity-fill",
      severity: "warn",
      message: `${contentEntities} content entity(ies) carry neither properties nor a body — titles with nothing behind them.`,
      metric: contentEntities,
    });
    nextUpgrades.push(
      "Verify the structuring model received property hints (profiles resolved with their effective schema) before applying."
    );
  }

  if (linkedExisting > 0) {
    findings.push({
      id: "linked-existing",
      severity: "info",
      message: `${linkedExisting} op(s) link to existing entities (good merge).`,
      metric: linkedExisting,
    });
  }

  // --- score (simple weighted heuristic) ---
  let score = 50;
  if (creates.length > 0) score += 15;
  if (containers > 0) score += 10;
  if (parentOf.length > 0) score += 10;
  if (relations.length > creates.length * 0.3) score += 5;
  if (homes.multiHome || Object.keys(homes.byWorkspace).length > 0) score += 5;
  if (linkedExisting > 0) score += 5;
  if (filesFailed && filesFailed > 0) score -= Math.min(20, filesFailed * 2);
  if (creates.length === 0) score = Math.min(score, 15);
  score = Math.max(0, Math.min(100, score));

  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const warns = findings.filter((f) => f.severity === "warn").length;

  const summary =
    blockers > 0
      ? `Quality ${score}/100 — ${blockers} blocker(s), refuse before apply.`
      : warns > 0
        ? `Quality ${score}/100 — ${warns} warning(s); review homes/hierarchy then apply or refine.`
        : `Quality ${score}/100 — looks solid for apply after human review.`;

  if (score < 70 && nextUpgrades.length === 0) {
    nextUpgrades.push(
      "Refuse this proposal, adjust --home-map / folder names, re-import, compare quality scores."
    );
  }
  if (score >= 70) {
    nextUpgrades.push(
      "Review the graph in the proposal UI; apply when the containers and sample entities look right."
    );
  }

  return {
    score,
    summary,
    counts: {
      filesProcessed,
      filesFailed,
      createEntities: creates.length,
      createRelations: relations.length,
      containers,
      contentEntities,
      linkedExisting,
      byProfile,
      ...(degradedToNote !== undefined ? { degradedToNote } : {}),
      withContent,
      withProperties,
    },
    hierarchy: {
      containerCount: containers,
      parentOfEdges: parentOf.length,
      filesWithContainer: input.corpusMap?.filesLinkedToContainer,
      intentCounts: input.corpusMap?.intentCounts,
    },
    homes: {
      multiHome: homes.multiHome,
      byWorkspace: homes.byWorkspace,
      podWide: homes.podWide,
      byProject: homes.byProject,
    },
    findings,
    nextUpgrades,
  };
}

/** One-line CLI/UI banner. */
export function formatQualityScoreLine(q: ImportQualityReport): string {
  return `quality ${q.score}/100 — ${q.counts.createEntities} entities · ${q.hierarchy.containerCount} containers · ${q.counts.createRelations} relations`;
}
