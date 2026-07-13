/**
 * submitCaptureGraph — the shared core of the `POST /api/hub/capture/graph` door.
 *
 * Extracted from the Hono route handler (routers/hub-protocol/rest/capture.ts) so
 * BOTH the HTTP door AND in-process producers (the Cal.com booking webhook, the
 * Cal.com backfill poller) create the SAME one-reviewable-composite proposal
 * through the SAME code path — within-batch dedup → persisted-entity dedup →
 * `import.graph` event-backed proposal. No hand-rolled entity writer.
 *
 * The route keeps its own request parsing + ref validation and calls this with
 * already-validated arrays. In-process callers build the arrays via a mapper
 * (which guarantees valid refs) and call this directly.
 */

import { randomUUID } from "crypto";

import {
  db,
  resolveIdentity,
  extractIdentitySignals,
  eq,
  or,
  isNull,
  entities,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { createEventBackedProposal } from "../../utils/event-backed-proposal.js";
import { openLink } from "../../utils/deep-links.js";
import {
  collapseDuplicateEntities,
  type CaptureGraphEntity,
  type CaptureGraphRelation,
  type CaptureGraphBinding,
} from "../../routers/hub-protocol/rest/_capture-graph-dedup.js";

const logger = createLogger({ module: "submit-capture-graph" });

export interface SubmitCaptureGraphInput {
  /** The proposing/acting user (operator or the Capture agent actor). */
  userId: string;
  /** Workspace to scope the proposal to (null = pod-wide). */
  workspaceId?: string | null;
  entities: CaptureGraphEntity[];
  relations?: CaptureGraphRelation[];
  bindings?: CaptureGraphBinding[];
  summary?: string;
}

export interface SubmitCaptureGraphResult {
  proposalId: string | undefined;
  entityCount: number;
  relationCount: number;
  bindingCount: number;
  reviewUrl: string | undefined;
  summary: string;
}

/**
 * Build + file the composite graph proposal. Callers MUST have validated that
 * every relation/binding ref exists among `entities` (the HTTP door does this;
 * mappers construct refs by hand so they're always valid).
 */
export async function submitCaptureGraph(
  input: SubmitCaptureGraphInput
): Promise<SubmitCaptureGraphResult> {
  const { userId } = input;
  const workspaceId = input.workspaceId ?? null;

  // WITHIN-BATCH DEDUP: the producer may list the same person/company under two
  // different `ref`s (neither persisted yet). Collapse those before resolving
  // against the DB — same key + rewrite semantics as the HTTP door.
  const collapsed = collapseDuplicateEntities(
    input.entities,
    input.relations ?? [],
    input.bindings ?? []
  );
  const graphEntities = collapsed.entities;
  const relations = collapsed.relations;
  const bindings = collapsed.bindings;

  // IDEMPOTENCY: dedup against existing entities via the ONE identity resolver.
  // Strong signals (email/phone/url) auto-resolve globally; weak name/handle
  // matches are scoped to this workspace's visible rows + pod-wide globals.
  const toResolve = graphEntities.filter((e) => !e.existingEntityId);
  if (toResolve.length > 0) {
    const weakScope = workspaceId
      ? or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId))
      : isNull(entities.workspaceId);
    for (const e of toResolve) {
      try {
        const res = await resolveIdentity(db, {
          userId,
          kindSlug: e.profileSlug,
          name: e.title ?? e.ref,
          signals: extractIdentitySignals(e.properties),
          userScope: weakScope,
        });
        if (res.match && res.entity) {
          e.existingEntityId = res.entity.id; // link, don't create
        }
      } catch (err) {
        // Dedup is best-effort — never block the proposal on a lookup failure.
        logger.warn({ err }, "capture/graph: entity dedup lookup failed");
      }
    }
  }

  const operations: CompositeProposalOperation[] = [
    ...graphEntities.map((e) => ({
      op: "create_entity" as const,
      ref: e.ref,
      profileSlug: e.profileSlug,
      title: e.title ?? e.ref,
      ...(e.description ? { description: e.description } : {}),
      ...(e.content ? { content: e.content } : {}),
      properties: e.properties ?? {},
      ...(e.existingEntityId ? { existingEntityId: e.existingEntityId } : {}),
      ...(e.facets ? { facets: e.facets } : {}),
    })),
    ...relations.map((r) => ({
      op: "create_relation" as const,
      sourceRef: r.sourceRef,
      targetRef: r.targetRef,
      type: r.type,
    })),
  ];

  const bindingNote = bindings.length
    ? `, ${bindings.length} channel bind${bindings.length === 1 ? "" : "s"}`
    : "";
  const summary =
    input.summary ??
    `Proposed graph: ${graphEntities.length} entit${graphEntities.length === 1 ? "y" : "ies"}, ${relations.length} link${relations.length === 1 ? "" : "s"}${bindingNote}`;

  const { proposal: created } = await createEventBackedProposal({
    userId,
    workspaceId,
    targetType: "entity",
    targetId: randomUUID(),
    proposalType: "import.graph",
    action: "create",
    source: "intelligence",
    summary,
    // `bindings` rides alongside operations; the approve flow applies them after
    // materialization (resolving entityRef → real id).
    data: { operations, source: "graph", bindings },
  });

  const proposalId = (created as { id?: string })?.id;
  const reviewUrl = proposalId ? openLink(proposalId) : undefined;

  return {
    proposalId,
    entityCount: graphEntities.length,
    relationCount: relations.length,
    bindingCount: bindings.length,
    reviewUrl,
    summary,
  };
}
