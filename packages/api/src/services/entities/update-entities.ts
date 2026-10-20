/**
 * UPDATE MANY RECORDS IN ONE GOVERNED CALL (R1 #27, founder D1–D4).
 *
 * Before this door an agent with 900 retitles had one choice: 900
 * `entities.update` calls, each a client "allow" click and, past the pending
 * cap, a refusal — so the work left the product as a CSV applied ungoverned.
 *
 * ONE path, shared by tRPC `entities.updateMany`, Hub `updateEntities`, REST
 * `POST /entities/batch-update` and MCP `synap_update_entities`. Per item, in
 * request order:
 *
 *   1. FLOOR — the record exists, is live and is WRITABLE by the caller (the
 *      same `entityWriteVisibleWhere` the single door uses). A miss is
 *      `skipped` "not found or not writable" (no existence oracle). The
 *      caller's `expected` title and `expectedStatus` are compared here too.
 *   2. VERDICT — `previewPermissionDecision` (side-effect free) on the SAME
 *      pair `entities.update` gates (`entity/update`), plus `entity/transition`
 *      when the patch moves the lifecycle status. The strictest wins.
 *   3. BUDGET — an agent's execute-class items are capped at what is left of
 *      its daily write ceiling (rung 2.56, D2: a batch counts as N writes).
 *      The overflow joins the pack — never N single proposals.
 *   4. ACT —
 *        execute → written NOW through `entities.update` (the ONE update door:
 *                  it re-gates, mints the AUTO_APPROVED receipt, stamped with
 *                  `batchId`, and runs every side effect);
 *        propose → collected into ONE `entity/update_pack` proposal
 *                  (`forcePropose`), applied item by item on approval;
 *        deny    → reported with the rung's reason.
 *
 * `validate: true` stops after step 3 and writes nothing. A call-level
 * `idempotencyKey` replays the first call's receipt instead of acting twice.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { decodeHtmlEntities } from "@synap-core/types/text";
import { TITLE_HARD_MAX, titleTooLongReason } from "@synap-core/types/titles";
import {
  UPDATE_PACK_MAX_ITEMS,
  UPDATE_PACK_SCHEMA,
  type EntityUpdateBefore,
  type EntityUpdatePatch,
  type UpdatePackData,
  type UpdatePackItem,
} from "@synap-core/types/proposals/item-pack";
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  entities,
  resolveStatusMoveTarget,
  classifyStatusMove,
} from "@synap/database";
import {
  countAgentWritesTodayUtc,
  resolveDailyWriteCeiling,
} from "@synap/database/agent-governance";
import type { Context } from "../../context.js";
import { entityWriteVisibleWhere } from "../../routers/entities/helpers.js";
import {
  checkPermissionOrPropose,
  isJoinGate,
  previewPermissionDecision,
  type PermissionDecisionPreview,
} from "../../utils/permission-check.js";
import { statusMoveActorFor } from "../lifecycle/move-status.js";
import { stableStringify } from "../../utils/stable-stringify.js";
import {
  computeWriteContentHash,
  deterministicUuidFromKey,
} from "../../utils/write-door-idempotency.js";
import {
  recallIdempotentResult,
  rememberIdempotentResult,
} from "../../routers/hub-protocol/_middleware/idempotency.js";

export const UPDATE_ENTITIES_MAX = UPDATE_PACK_MAX_ITEMS;

/** The patch one item may carry (D3) — shared by every door's input schema. */
export const EntityUpdatePatchSchema = z
  .object({
    title: z.string().max(TITLE_HARD_MAX, titleTooLongReason()).optional(),
    description: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    deleteProperties: z.array(z.string()).optional(),
    expectedStatus: z.string().nullable().optional(),
  })
  .strict();

export const UpdateEntitiesItemSchema = z.object({
  id: z.string().uuid(),
  patch: EntityUpdatePatchSchema,
  /** What the caller saw — the item is skipped if the record no longer matches. */
  expected: z.object({ title: z.string().nullable() }).partial().optional(),
});

export const UpdateEntitiesInputSchema = z.object({
  items: z.array(UpdateEntitiesItemSchema).min(1).max(UPDATE_ENTITIES_MAX),
  /** Replays the first call's receipt instead of acting twice. */
  idempotencyKey: z.string().min(8).max(256).optional(),
  /** Dry run: the per-item verdict, nothing written. */
  validate: z.boolean().optional(),
  reasoning: z.string().optional(),
});

export type UpdateEntitiesItem = z.infer<typeof UpdateEntitiesItemSchema>;

export type UpdateEntitiesSource =
  "user" | "ai" | "intelligence" | "system" | "agent" | "extension";

export interface UpdateEntitiesParams {
  /** The caller's context — every write runs as it, through `entities.update`. */
  ctx: Context;
  items: UpdateEntitiesItem[];
  agentUserId?: string | null;
  source?: UpdateEntitiesSource;
  reasoning?: string;
  idempotencyKey?: string;
  validate?: boolean;
}

export type UpdateEntitiesVerdict = "execute" | "propose" | "deny" | "skip";

export interface UpdateEntitiesResult {
  batchId: string;
  /** Present on a dry run: nothing was written. */
  validated?: true;
  /** Present when this answer is the receipt of an earlier identical call. */
  replayed?: true;
  /** Every item in request order, with the verdict it got (and why, when not executed). */
  items: Array<{ id: string; verdict: UpdateEntitiesVerdict; reason?: string }>;
  /** Written now, in request order. Empty on a dry run. */
  applied: string[];
  /** The ONE review this call filed, or null. */
  proposed: {
    proposalId: string;
    count: number;
    ids: string[];
    reviewUrl?: string;
  } | null;
  denied: Array<{ id: string; reason: string }>;
  /**
   * `deferred: true` = the write was KEPT on a workspace-join request and is
   * replayed for the caller once the join is approved — never resend it.
   */
  skipped: Array<{
    id: string;
    reason: string;
    proposalId?: string;
    deferred?: true;
  }>;
}

const NOT_WRITABLE = "Not found or not writable by you";

const STRICTNESS: Record<PermissionDecisionPreview["decision"], number> = {
  execute: 0,
  propose: 1,
  deny: 2,
};

function stricter(
  a: PermissionDecisionPreview,
  b: PermissionDecisionPreview | undefined
): PermissionDecisionPreview {
  return b && STRICTNESS[b.decision] > STRICTNESS[a.decision] ? b : a;
}

function hasChange(patch: EntityUpdatePatch): boolean {
  return (
    patch.title !== undefined ||
    patch.description !== undefined ||
    (patch.properties !== undefined &&
      Object.keys(patch.properties).length > 0) ||
    (patch.deleteProperties?.length ?? 0) > 0
  );
}

interface PlannedItem {
  id: string;
  verdict: UpdateEntitiesVerdict;
  reason?: string;
  /** Set for `propose`: what the pack carries. */
  packItem?: UpdatePackItem;
  patch: EntityUpdatePatch;
}

/** The ONE governed door (see file header). */
export async function updateEntities(
  params: UpdateEntitiesParams
): Promise<UpdateEntitiesResult> {
  const { ctx } = params;
  const userId = ctx.userId;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "No user" });
  }
  if (params.items.length === 0 || params.items.length > UPDATE_ENTITIES_MAX) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Send between 1 and ${UPDATE_ENTITIES_MAX} items per call`,
    });
  }
  const agentUserId = params.agentUserId ?? ctx.agentUserId ?? undefined;

  // Idempotency: the key is partitioned by principal AND payload, so a reused
  // key with a different body is a different call, never a stale answer.
  const contentHash = computeWriteContentHash("entities.updateMany", {
    items: params.items,
  });
  const idemKey =
    params.idempotencyKey && !params.validate
      ? `body:entities.updateMany:${userId}:${params.idempotencyKey}:${contentHash}`
      : undefined;
  if (idemKey) {
    const prior = await recallIdempotentResult(idemKey);
    if (prior) {
      return { ...(JSON.parse(prior) as UpdateEntitiesResult), replayed: true };
    }
  }
  const batchId = idemKey ? deterministicUuidFromKey(idemKey) : randomUUID();

  const plan = await planItems({ ...params, userId, agentUserId });
  const result: UpdateEntitiesResult = {
    batchId,
    items: plan.map((p) => ({
      id: p.id,
      verdict: p.verdict,
      ...(p.reason ? { reason: p.reason } : {}),
    })),
    applied: [],
    proposed: null,
    denied: plan
      .filter((p) => p.verdict === "deny")
      .map((p) => ({ id: p.id, reason: p.reason ?? "Denied" })),
    skipped: plan
      .filter((p) => p.verdict === "skip")
      .map((p) => ({ id: p.id, reason: p.reason ?? "Skipped" })),
  };
  if (params.validate) return { ...result, validated: true };

  // ── execute: one write per item through the ONE update door ──────────────
  // Loaded lazily: the entities router mounts `updateMany` from this module.
  const { entitiesRouter } = await import("../../routers/entities.js");
  const caller = entitiesRouter.createCaller(ctx);
  for (const item of plan.filter((p) => p.verdict === "execute")) {
    try {
      const written = await caller.update({
        id: item.id,
        ...item.patch,
        ...(params.source ? { source: params.source } : {}),
        ...(params.reasoning ? { reasoning: params.reasoning } : {}),
        ...(agentUserId ? { agentUserId } : {}),
        batchId,
      });
      if (written.status === "proposed" && written.proposalId) {
        // The door re-gated and disagreed with the preview (a concurrent write
        // crossed the ceiling, a rule changed). Reported, never hidden. A join
        // gate that KEPT the write replays it once the join is approved.
        const kept = (written as { deferred?: true }).deferred;
        result.skipped.push({
          id: item.id,
          reason: kept
            ? "Kept on a request to join its space — replayed for you once approved; do not resend it"
            : "Filed for review on its own",
          proposalId: written.proposalId,
          ...(kept ? { deferred: true as const } : {}),
        });
      } else {
        result.applied.push(item.id);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof TRPCError && err.code === "FORBIDDEN") {
        result.denied.push({ id: item.id, reason });
      } else {
        result.skipped.push({ id: item.id, reason });
      }
    }
  }

  // ── propose: ONE pack for the whole call ─────────────────────────────────
  const packItems = plan
    .map((p) => p.packItem)
    .filter((i): i is UpdatePackItem => Boolean(i));
  if (packItems.length > 0) {
    await filePack({
      ...params,
      userId,
      agentUserId,
      batchId,
      packItems,
      result,
    });
  }

  if (idemKey) await rememberIdempotentResult(idemKey, JSON.stringify(result));
  return result;
}

async function planItems(
  params: UpdateEntitiesParams & {
    userId: string;
    agentUserId: string | undefined;
  }
): Promise<PlannedItem[]> {
  const { ctx, userId, agentUserId } = params;
  const ids = [...new Set(params.items.map((i) => i.id))];
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      type: entities.type,
      workspaceId: entities.workspaceId,
    })
    .from(entities)
    .where(
      and(
        inArray(entities.id, ids),
        isNull(entities.deletedAt),
        entityWriteVisibleWhere(userId)
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mover = statusMoveActorFor(ctx, {
    source: params.source,
    agentUserId,
  });

  const seen = new Set<string>();
  const planned: PlannedItem[] = [];
  for (const item of params.items) {
    const { id } = item;
    // An agent's XML-escaped title (`Doors &amp; Spec`) is decoded ONCE, here,
    // so every half sees the same text: the governance preview, the "nothing
    // to change" check, the pack item a reviewer approves later, and the
    // execute write (whose door, `entities.update`, decodes it too).
    const patch = item.patch.title
      ? { ...item.patch, title: decodeHtmlEntities(item.patch.title) }
      : item.patch;
    const skip = (reason: string) =>
      planned.push({ id, verdict: "skip", reason, patch });
    if (seen.has(id)) {
      skip("Listed twice in this batch");
      continue;
    }
    seen.add(id);
    const row = byId.get(id);
    if (!row) {
      skip(NOT_WRITABLE);
      continue;
    }
    if (
      item.expected?.title !== undefined &&
      (row.title ?? null) !== item.expected.title
    ) {
      skip(`Its title changed since you read it (now "${row.title ?? ""}")`);
      continue;
    }

    // The lifecycle status is MOVED (its own door and gate), never patched —
    // split it out exactly like `entities.update` does.
    const props = { ...(patch.properties ?? {}) };
    let move:
      | {
          to: string;
          from: string | null;
          lifecycleMove: { intoTerminal: boolean; humanOnly: boolean };
          workspaceId: string | null;
        }
      | undefined;
    if (patch.properties || patch.expectedStatus !== undefined) {
      const resolved = await resolveStatusMoveTarget(db, {
        entityId: id,
        workspaceId: ctx.workspaceId ?? null,
      });
      const slug = resolved.ok ? resolved.target.lifecycle.propertySlug : null;
      if (
        resolved.ok &&
        slug &&
        Object.prototype.hasOwnProperty.call(props, slug)
      ) {
        const to = props[slug];
        delete props[slug];
        const lifecycleMove =
          typeof to === "string"
            ? classifyStatusMove(resolved.target.lifecycle, to)
            : null;
        if (typeof to !== "string" || !lifecycleMove) {
          skip(`"${String(to)}" is not a status of this record`);
          continue;
        }
        if (
          patch.expectedStatus !== undefined &&
          (patch.expectedStatus ?? null) !== resolved.target.current
        ) {
          skip(
            `Its status is now "${resolved.target.current ?? "none"}" (you saw "${patch.expectedStatus ?? "none"}")`
          );
          continue;
        }
        if (resolved.target.current !== to) {
          move = {
            to,
            from: resolved.target.current,
            lifecycleMove,
            workspaceId: resolved.target.workspaceId ?? null,
          };
        }
      }
    }
    const fieldPatch: EntityUpdatePatch = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(Object.keys(props).length > 0 ? { properties: props } : {}),
      ...(patch.deleteProperties?.length
        ? { deleteProperties: patch.deleteProperties }
        : {}),
    };
    if (!hasChange(fieldPatch) && !move) {
      skip("Nothing to change");
      continue;
    }

    const governanceWorkspaceId = row.workspaceId ?? ctx.workspaceId ?? null;
    let verdict: PermissionDecisionPreview = { decision: "execute" };
    if (hasChange(fieldPatch)) {
      verdict = await previewPermissionDecision({
        userId,
        agentUserId,
        workspaceId: governanceWorkspaceId,
        // The grant sees the row's own workspace (pod-wide = pod scope), as
        // the `entities.update` door it previews does (S7).
        grantWorkspaceId: row.workspaceId ?? null,
        subjectType: "entity",
        action: "update",
        source: params.source,
        sessionId: ctx.sessionId ?? undefined,
        data: { id, ...fieldPatch },
      });
    }
    if (move && mover.actor.kind !== "system" && !mover.approvedProposalId) {
      const agent = mover.actor.kind === "agent";
      verdict = stricter(
        verdict,
        await previewPermissionDecision({
          userId,
          agentUserId: mover.actor.agentUserId ?? undefined,
          workspaceId: move.workspaceId ?? ctx.workspaceId ?? null,
          grantWorkspaceId: move.workspaceId,
          subjectType: "entity",
          action: "transition",
          source: agent
            ? mover.actor.agentUserId
              ? "agent"
              : "intelligence"
            : "user",
          lifecycleMove: move.lifecycleMove,
          sessionId: ctx.sessionId ?? undefined,
          data: { id, entityId: id, expectedFrom: move.from, to: move.to },
        })
      );
    }

    if (verdict.decision === "deny") {
      planned.push({ id, verdict: "deny", reason: verdict.reason, patch });
      continue;
    }
    const packItem = (): UpdatePackItem => ({
      ref: id,
      id,
      subject: { kind: row.type ?? null, name: row.title ?? null },
      patch,
      before: beforeOf(row, patch),
    });
    if (verdict.decision === "propose") {
      planned.push({ id, verdict: "propose", packItem: packItem(), patch });
    } else {
      planned.push({ id, verdict: "execute", patch });
    }
  }

  // D2 — an agent's batch counts as N writes against its daily ceiling. The
  // execute-class items past what is left of it join the pack.
  if (agentUserId) {
    const executes = planned.filter((p) => p.verdict === "execute");
    if (executes.length > 0) {
      const [limit, used] = await Promise.all([
        resolveDailyWriteCeiling({
          db,
          agentUserId,
          workspaceId: ctx.workspaceId ?? null,
        }),
        countAgentWritesTodayUtc(db, agentUserId),
      ]);
      const left = Math.max(0, limit - used);
      for (const p of executes.slice(left)) {
        const row = byId.get(p.id)!;
        p.verdict = "propose";
        p.reason = `Over the agent's daily write limit (${limit})`;
        p.packItem = {
          ref: p.id,
          id: p.id,
          subject: { kind: row.type ?? null, name: row.title ?? null },
          patch: p.patch,
          before: beforeOf(row, p.patch),
        };
      }
    }
  }
  return planned;
}

/** The values the patch touches, as they are now — the approval's stale check. */
function beforeOf(
  row: {
    title: string | null;
    preview: string | null;
    properties: unknown;
  },
  patch: EntityUpdatePatch
): EntityUpdateBefore {
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const keys = [
    ...Object.keys(patch.properties ?? {}),
    ...(patch.deleteProperties ?? []),
  ];
  return {
    ...(patch.title !== undefined ? { title: row.title } : {}),
    ...(patch.description !== undefined ? { description: row.preview } : {}),
    ...(keys.length > 0
      ? {
          properties: Object.fromEntries(
            keys.map((k) => [k, props[k] ?? null])
          ),
        }
      : {}),
  };
}

/**
 * Refuse an update-pack item whose touched fields no longer hold what they
 * held when the pack was filed — someone edited the record meanwhile, and the
 * reviewer approved a change against values that are gone.
 */
export async function assertUpdatePackItemCurrent(
  item: UpdatePackItem
): Promise<void> {
  const row = await db.query.entities.findFirst({
    where: and(eq(entities.id, item.id), isNull(entities.deletedAt)),
    columns: { title: true, preview: true, properties: true },
  });
  if (!row) throw new Error("No longer exists");
  const { before } = item;
  const changed: string[] = [];
  if ("title" in before && (row.title ?? null) !== (before.title ?? null)) {
    changed.push("title");
  }
  if (
    "description" in before &&
    (row.preview ?? null) !== (before.description ?? null)
  ) {
    changed.push("description");
  }
  const props = (row.properties ?? {}) as Record<string, unknown>;
  for (const [key, was] of Object.entries(before.properties ?? {})) {
    if (stableStringify(props[key] ?? null) !== stableStringify(was ?? null)) {
      changed.push(key);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `Changed since this pack was filed (${changed.join(", ")}) — not overwritten`
    );
  }
}

async function filePack(
  params: UpdateEntitiesParams & {
    userId: string;
    agentUserId: string | undefined;
    batchId: string;
    packItems: UpdatePackItem[];
    result: UpdateEntitiesResult;
  }
): Promise<void> {
  const { ctx, packItems, result } = params;
  const ids = packItems.map((i) => i.id);
  // One home when every item shares one, else pod scope (the approver's own
  // write floor then authorizes each item).
  const homes = new Set(
    (
      await db
        .select({ workspaceId: entities.workspaceId })
        .from(entities)
        .where(inArray(entities.id, ids))
    ).map((r) => r.workspaceId ?? null)
  );
  const workspaceId = homes.size === 1 ? [...homes][0]! : null;
  // One kind across the pack names it, so a kind-limited key grant
  // (`entity.<kind>.update`) can match the pack as it matches each item.
  const kinds = new Set(packItems.map((i) => i.subject.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  const data: UpdatePackData & { id: string; type?: string } = {
    id: params.batchId,
    ...(kind ? { type: kind } : {}),
    schema: UPDATE_PACK_SCHEMA,
    batchId: params.batchId,
    items: packItems,
  };
  const perm = await checkPermissionOrPropose({
    userId: params.userId,
    agentUserId: params.agentUserId,
    workspaceId,
    subjectType: "entity",
    action: "update_pack",
    source: params.source,
    // One review over many records: never auto-applied, whatever a rule says.
    forcePropose: true,
    reasoning: params.reasoning,
    sessionId: ctx.sessionId ?? undefined,
    data: data as unknown as Record<string, unknown>,
  });
  const notFiled = (reason: string, proposalId?: string) => {
    for (const id of ids) {
      result.skipped.push({
        id,
        reason,
        ...(proposalId ? { proposalId } : {}),
      });
    }
  };
  if ("denied" in perm && perm.denied) {
    for (const id of ids) result.denied.push({ id, reason: perm.reason });
    return;
  }
  if ("proposalId" in perm) {
    if (isJoinGate(perm.proposalType)) {
      notFiled(
        "Needs access to its space first — approve the join request, then send these items again",
        perm.proposalId
      );
      return;
    }
    result.proposed = {
      proposalId: perm.proposalId,
      count: ids.length,
      ids,
      ...(perm.reviewUrl ? { reviewUrl: perm.reviewUrl } : {}),
    };
    return;
  }
  // Granted at pack scope although each item needed review (a person whose
  // items span spaces with different roles): never apply them unreviewed.
  notFiled(
    "Needs review, but its space differs from the other items' — send it in a batch of its own space"
  );
}
