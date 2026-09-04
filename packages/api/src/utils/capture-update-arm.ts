/**
 * capture-update-arm — the UPDATE arm of `capture.execute` (W1).
 *
 * THE DEFECT THIS REMOVES. A capture proposal could only ever say `create`,
 * `link` or `dismiss`. `link` sets `existingEntityId`, which reaches
 * `materializeCompositeGraph`'s `if (op.existingEntityId)` branch — that branch
 * resolves the id and returns, so the op's `properties` / `description` /
 * `content` are SILENTLY DISCARDED. A capture that correctly recognised an
 * existing subject and extracted new facts about it therefore had exactly two
 * outcomes available: create a duplicate, or link and throw the facts away.
 *
 * The only enrich-an-existing-entity behaviour that DID exist was invisible and
 * un-chooseable: `capture.execute`'s strong-identity-match pass
 * (`resolveIdentity` → `entitiesCaller.update`) and the MCP handler's ≥0.95
 * dedup merge. Both patch an entity the user never saw named. This arm is that
 * same write, made EXPLICIT and REVIEWABLE.
 *
 * REUSE, NOT A NEW DOOR. The patch goes through `entities.update` — the ONE
 * governed update door. It already gates as `entity`/`update`, already returns
 * `{ status: "proposed", proposalId, reviewUrl }` on a governed verdict, and the
 * proposal it files already renders through `ProposalKindBody`'s `case "update"`
 * → `FieldDiffList`. There is no new gate pair, no new composite op arm, and no
 * new review UI.
 *
 * WHY NOT A COMPOSITE `update_entity` ARM. `CompositeProposalOperation` has no
 * update member; `isCompositeProposalData`, `materializeCompositeGraph` and the
 * revert path would all have to grow one. Adding `update_entity` to
 * `COMPOSITE_OP_GATE_PAIRS` without those would map a gate to an arm nothing can
 * execute — a declaration nobody verified, which is the exact class
 * `deriveGatePairFromOperations` exists to kill. The literal `entity`/`update`
 * pair the door uses is NOT beside a `data.operations` batch (it is beside
 * `data.id`), which is the same single-op shape `utils/capture-propose.ts`
 * already uses and what the gate-pair tripwire explicitly permits.
 */

export interface CaptureUpdateArmOp {
  tempId: string;
  title: string;
  description?: string;
  properties?: Record<string, unknown>;
  existingEntityId?: string;
  updateExisting?: boolean;
}

/** The patch an update op would apply — `null` when it carries no new facts. */
export interface CaptureUpdatePatch {
  entityId: string;
  description?: string;
  properties?: Record<string, unknown>;
}

/** Per-op outcome, mirrored into `capture.execute`'s response as `updated[]`. */
export interface CaptureUpdateResult {
  tempId: string;
  entityId: string;
  /** "applied" = patched now; "proposed" = filed for review, nothing written. */
  status: "applied" | "proposed" | "failed";
  proposalId?: string;
  reviewUrl?: string;
  reason?: string;
}

/**
 * True when this op means "patch that entity", not "link to it".
 *
 * `updateExisting` without an `existingEntityId` names no target, so it is not
 * an update — it falls through to the ordinary create/link path unchanged.
 */
export function isCaptureUpdateOp(op: CaptureUpdateArmOp): boolean {
  return op.updateExisting === true && Boolean(op.existingEntityId);
}

/**
 * The patch this op would apply, or `null` when there is nothing to write.
 *
 * Empty-ish property values are dropped with the SAME predicate the existing
 * identity-enrich pass uses (`v !== undefined && v !== null && v !== ""`), so an
 * update op and a strong-identity match write the same fields. An op with no
 * surviving property and no description patches nothing — returning `null`
 * keeps it out of the gate entirely rather than filing an empty proposal.
 *
 * `title` is deliberately NOT patched: capture's title is the AI's label for the
 * mention it just read, and letting it overwrite an existing entity's name would
 * make every passing reference a rename.
 */
export function buildCaptureUpdatePatch(
  op: CaptureUpdateArmOp
): CaptureUpdatePatch | null {
  if (!isCaptureUpdateOp(op) || !op.existingEntityId) return null;
  const properties = Object.fromEntries(
    Object.entries(op.properties ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== ""
    )
  );
  const description = op.description?.trim() ? op.description : undefined;
  if (Object.keys(properties).length === 0 && description === undefined) {
    return null;
  }
  return {
    entityId: op.existingEntityId,
    ...(description !== undefined ? { description } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

/** The `entities.update` call this arm needs, injected so it is unit-testable. */
export type CaptureUpdateEntityCaller = (input: {
  id: string;
  description?: string;
  properties?: Record<string, unknown>;
  source: "user";
  reasoning: string;
  forcePropose?: true;
}) => Promise<unknown>;

/**
 * Apply (or propose) every update op in a capture batch.
 *
 * `forcePropose` is passed by the caller when the CREATE half of the same
 * capture was parked for review: a `status: "proposed"` receipt must never be
 * returned with rows already patched behind it, so the whole capture stays
 * reviewable together.
 *
 * A single failed patch is REPORTED, never thrown — one un-writable property on
 * one entity must not lose the rest of a capture (the same posture the facet
 * pass and the identity-enrich pass already take).
 */
export async function applyCaptureUpdateOps(params: {
  ops: CaptureUpdateArmOp[];
  updateEntity: CaptureUpdateEntityCaller;
  forcePropose: boolean;
  onError?: (err: unknown, entityId: string) => void;
}): Promise<CaptureUpdateResult[]> {
  const results: CaptureUpdateResult[] = [];
  for (const op of params.ops) {
    const patch = buildCaptureUpdatePatch(op);
    if (!patch) continue;
    try {
      const res = (await params.updateEntity({
        id: patch.entityId,
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.properties ? { properties: patch.properties } : {}),
        source: "user",
        reasoning: `Capture — update ${op.title || "entity"}`,
        ...(params.forcePropose ? { forcePropose: true as const } : {}),
      })) as {
        status?: string;
        proposalId?: string;
        reviewUrl?: string;
      } | null;
      if (res && res.status === "proposed" && res.proposalId) {
        results.push({
          tempId: op.tempId,
          entityId: patch.entityId,
          status: "proposed",
          proposalId: res.proposalId,
          ...(res.reviewUrl ? { reviewUrl: res.reviewUrl } : {}),
        });
      } else {
        results.push({
          tempId: op.tempId,
          entityId: patch.entityId,
          status: "applied",
        });
      }
    } catch (err) {
      params.onError?.(err, patch.entityId);
      results.push({
        tempId: op.tempId,
        entityId: patch.entityId,
        status: "failed",
        reason: err instanceof Error ? err.message : "update failed",
      });
    }
  }
  return results;
}
