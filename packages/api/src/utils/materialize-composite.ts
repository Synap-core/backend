/**
 * Materialize a composite (graph) proposal's operations: create N entities, then
 * the M relations among them, resolving each relation ref → real entity id.
 *
 * Single source of truth shared by:
 *   - proposals.approve (composite branch) — human-approved graph
 *   - /import/apply — user-initiated direct import (their own data, no proposal)
 *
 * Pass 1 creates every create_entity op (canonical entity-create path → full
 * side-effects incl. linked documents when op.content is set), building a
 * ref→realId map. Pass 2 creates relations, resolving sourceRef/targetRef
 * ($opN / op `ref` / $primary / real UUID). Relation failures are logged but
 * never discard the created entities.
 */

import {
  registerEntityRef,
  resolveCompositeRef,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";

export interface MaterializeResult {
  created: number;
  linked: number;
  primaryId: string;
  refToRealId: Record<string, string>;
}

/**
 * Caller shapes — structurally satisfied by the tRPC entitiesRouter /
 * relationsRouter createCaller(...) objects. Typed loosely (the tRPC caller's
 * `create` carries a much wider inferred input than we use) so this util can be
 * shared without re-deriving the router's exact procedure types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntityCreateCaller = { create: (input: any) => Promise<any> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RelationCreateCaller = { create: (input: any) => Promise<any> };

export interface MaterializeOptions {
  /**
   * Pin every created entity to the caller's active workspace, OVERRIDING any
   * profile pod-default `entityScope`. Imports set this so their data is
   * isolated to the target workspace (and is later purgeable on workspace
   * deletion). Interactive proposal approval leaves it false so pod-default
   * profiles keep their global graph.
   */
  workspaceScoped?: boolean;
}

export async function materializeCompositeGraph(
  operations: CompositeProposalOperation[],
  entityCaller: EntityCreateCaller,
  relationCaller: RelationCreateCaller,
  onRelationError?: (err: unknown, type: string) => void,
  options?: MaterializeOptions
): Promise<MaterializeResult> {
  // Pass 1 — entities → ref→realId map.
  const refToRealId: Record<string, string> = {};
  let primaryId = "";
  let created = 0;
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (op.op !== "create_entity") continue;
    const result = await entityCaller.create({
      profileSlug: op.profileSlug,
      title: op.title || "Untitled",
      description: op.description,
      properties: op.properties,
      content: op.content, // long-form body → linked document
      source: "system",
      // Explicit workspace-scope request (imports): pin to the caller's
      // workspace even for pod-default profiles. The create router reads the
      // active workspace from ctx.workspaceId.
      workspaceScoped: options?.workspaceScoped ?? false,
    });
    const realId = (result as { id: string }).id;
    registerEntityRef(refToRealId, i, op.ref, realId, !primaryId);
    if (!primaryId) primaryId = realId;
    created++;
  }

  // Pass 2 — relations, resolving refs.
  let linked = 0;
  for (const op of operations) {
    if (op.op !== "create_relation") continue;
    const sourceEntityId = resolveCompositeRef(refToRealId, op.sourceRef);
    const targetEntityId = resolveCompositeRef(refToRealId, op.targetRef);
    try {
      await relationCaller.create({
        sourceEntityId,
        targetEntityId,
        type: op.type,
      });
      linked++;
    } catch (err) {
      onRelationError?.(err, op.type);
    }
  }

  return { created, linked, primaryId, refToRealId };
}
