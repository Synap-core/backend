/**
 * Apply one package update with a choice per field, and undo it.
 *
 * - The plan is re-read here (`planPackageRows`), never trusted from the page:
 *   the states the person chose against are recomputed by the one comparator.
 * - `expectedVersion` is the catalog version the page showed. A newer catalog
 *   answers 409 (CONFLICT): the person reviews the new update.
 * - Every write goes through the row's own governed `.update` door
 *   (`writeStandaloneRow`), with the CALLER's context: a person's write lands,
 *   an agent's is filed as a proposal by that door's `checkPermissionOrPropose`
 *   and lands only when a person approves it.
 * - Every decided field's baseline advances to the catalog's value, "mine"
 *   included (D4): a kept edit is asked about again only when the catalog
 *   changes that field again. The row's `packageVersion` advances to the
 *   catalog's, since no field is left conflicted.
 * - A landed apply writes one receipt (`package.updated`); undo replays each
 *   change's `before` through the same doors within 30 days (D5).
 */

import { TRPCError } from "@trpc/server";
import { getActingAgentUserId } from "@synap/database";
import {
  applyPackageUpdateInputSchema,
  type ApplyPackageUpdateInput,
  type PackageUpdateApplyResult,
  type PackageUpdateChange,
  type PackageUpdateChoice,
} from "@synap-core/types/package-updates";

import {
  deepEqual,
  MARKET_SOURCE_COMPARATOR_VERSION,
} from "../capabilities/market-source.js";
import {
  loadStandaloneRows,
  writeStandaloneRow,
  type StandaloneKind,
  type WriteOutcome,
} from "../capabilities/reconcile-standalone-configs-to-templates.js";
import type { Context } from "../../types/context.js";
import { planPackageRows, type PlannedRow } from "./plan.js";
import {
  getPackageUpdateReceipt,
  recordPackageUpdateReceipt,
  recordPackageUpdateUndone,
} from "./receipts.js";

/** The acting agent, the way the governed doors derive it. */
function actingAgentOf(ctx: Context): string | undefined {
  return (
    getActingAgentUserId() ??
    ((ctx as { agentUserId?: string | null }).agentUserId || undefined)
  );
}

/**
 * `views.update` has no agent gate today: an agent's write through it would
 * land unreviewed. Until it has one, an agent cannot apply or undo an update
 * that writes a view; a person does it.
 */
function refuseUngovernedAgentWrite(
  ctx: Context,
  kinds: Iterable<StandaloneKind>
): void {
  if (!actingAgentOf(ctx)) return;
  for (const kind of kinds) {
    if (kind === "view") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "An agent cannot change a view through a package update yet: views have no review step for agents. Ask a person to apply it on pod admin.",
      });
    }
  }
}

/** The value a choice writes, or `undefined` to keep the pod's value. */
function valueFor(
  choice: PackageUpdateChoice,
  field: PlannedRow["fields"][number],
  key: string
): { write: unknown } | undefined {
  if (typeof choice === "object") return { write: choice.value };
  if (choice === "mine") return undefined;
  if (choice === "catalog") return { write: field.desired };
  // combine
  if (field.state === "updates") return { write: field.desired };
  if (field.state === "yours" || field.state === "same") return undefined;
  if (typeof field.merged !== "string") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${key}" cannot be combined: the two edits overlap, or it is not text. Choose "catalog", "mine" or your own value.`,
    });
  }
  return { write: field.merged };
}

interface RowWrite {
  planned: PlannedRow;
  merged: Record<string, unknown>;
  metadata: Record<string, unknown>;
  changes: PackageUpdateChange[];
  /** False when neither a field, the baseline nor the version moves. */
  needed: boolean;
}

/** Turn the choices into one governed write per row (validated first). */
function buildRowWrites(
  planned: PlannedRow[],
  choices: Record<string, PackageUpdateChoice>
): RowWrite[] {
  const known = new Set<string>();
  const missing: string[] = [];
  const writes: RowWrite[] = [];

  for (const p of planned) {
    const { resolved, merge } = p;
    const rowId = resolved.row.id as string;
    const merged: Record<string, unknown> = {};
    const nextBaseline: Record<string, unknown> = { ...merge.nextBaseline };
    const changes: PackageUpdateChange[] = [];

    for (const field of p.fields) {
      const key = `${rowId}:${field.key}`;
      known.add(key);
      if (field.state === "same") continue;
      const choice =
        choices[key] ?? (field.state === "updates" ? "catalog" : undefined);
      if (choice === undefined) {
        if (field.state === "both") missing.push(key);
        continue; // a `yours` field nobody chose for stays the pod's
      }
      const value = valueFor(choice, field, key);
      // Decided: the catalog's value is the new starting point (D4).
      nextBaseline[field.key] = field.desired;
      if (value && !deepEqual(value.write, resolved.live[field.key])) {
        merged[field.key] = value.write;
        changes.push({
          rowKind: resolved.adapter.kind,
          rowId,
          field: field.key,
          before: resolved.live[field.key],
          after: value.write,
        });
      }
    }

    const version = resolved.catalogVersion ?? resolved.source.packageVersion;
    const metadata = {
      ...((resolved.row.metadata as Record<string, unknown> | null) ?? {}),
      marketSource: {
        ...resolved.source,
        packageVersion: version,
        comparatorVersion: MARKET_SOURCE_COMPARATOR_VERSION,
        baseline: nextBaseline,
      },
    };
    const needed =
      Object.keys(merged).length > 0 ||
      version !== resolved.source.packageVersion ||
      !deepEqual(nextBaseline, resolved.source.baseline);
    writes.push({ planned: p, merged, metadata, changes, needed });
  }

  const unknown = Object.keys(choices).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `No such field in this update: ${unknown.join(", ")}. Choices are keyed "<rowId>:<field>".`,
    });
  }
  if (missing.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Both the catalog and this pod changed ${missing.join(", ")}: choose "catalog", "mine", "combine" or your own value for each.`,
    });
  }
  return writes;
}

export async function applyPackageUpdate(
  ctx: Context,
  rawInput: ApplyPackageUpdateInput
): Promise<PackageUpdateApplyResult> {
  const input = applyPackageUpdateInputSchema.parse(rawInput);
  // `acceptDataChanges` is for a space update's data changes; the rows this
  // door applies today (view, skill, automation) change no records.
  const planned = await planPackageRows(input.slug);
  refuseUngovernedAgentWrite(
    ctx,
    planned.map((p) => p.resolved.adapter.kind)
  );

  const latest = planned[0]!.resolved.catalogVersion;
  if (latest !== input.expectedVersion) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `The catalog moved to ${latest ?? "an unknown version"} since this update was shown (${input.expectedVersion}). Review it again.`,
    });
  }

  const writes = buildRowWrites(planned, input.choices);
  const proposalIds: string[] = [];
  const landed: PackageUpdateChange[] = [];
  for (const w of writes) {
    if (!w.needed) continue;
    const { resolved } = w.planned;
    const outcome: WriteOutcome = await writeStandaloneRow({
      kind: resolved.adapter.kind,
      ctx,
      id: resolved.row.id as string,
      merged: w.merged,
      metadata: w.metadata,
    });
    if (outcome.status === "proposed") {
      if (outcome.proposalId) proposalIds.push(outcome.proposalId);
    } else {
      landed.push(...w.changes);
    }
  }

  const head = planned[0]!.resolved;
  const receipt = await recordPackageUpdateReceipt({
    slug: head.source.packageSlug,
    kind: head.adapter.catalogKind,
    name: head.catalogName,
    fromVersion: head.source.packageVersion,
    toVersion: head.catalogVersion,
    userId: ctx.userId as string,
    changes: landed,
    source: "person",
  });
  if (proposalIds.length > 0) return { status: "proposed", proposalIds };
  return { status: "applied", receipt };
}

/**
 * Undo a receipt: write each change's `before` back through the same doors.
 *
 * Refused (nothing written) when the receipt is already undone, older than
 * the window, or when a field it changed has changed again since: undoing
 * then would overwrite a newer edit. The baseline is left where the update
 * put it, so a restored field reads as the pod's own edit ("Stays yours"),
 * never as an update waiting to re-apply itself.
 */
export async function undoPackageUpdate(
  ctx: Context,
  receiptId: string
): Promise<PackageUpdateApplyResult> {
  const receipt = await getPackageUpdateReceipt(receiptId);
  if (!receipt) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No such update receipt.",
    });
  }
  if (receipt.undoneAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `This update was already undone (${receipt.undoneAt}).`,
    });
  }
  if (Date.now() > Date.parse(receipt.undoUntil)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Undo is available for 30 days; this update's window ended ${receipt.undoUntil}.`,
    });
  }
  refuseUngovernedAgentWrite(
    ctx,
    receipt.changes.map((c) => c.rowKind)
  );

  // Group by row, and check nothing changed since the update.
  const byRow = new Map<string, PackageUpdateChange[]>();
  for (const c of receipt.changes) {
    const k = `${c.rowKind}:${c.rowId}`;
    byRow.set(k, [...(byRow.get(k) ?? []), c]);
  }
  const plan: Array<{
    kind: StandaloneKind;
    id: string;
    merged: Record<string, unknown>;
  }> = [];
  const changedSince: string[] = [];
  for (const changes of byRow.values()) {
    const { rowKind, rowId } = changes[0]!;
    const [row] = await loadStandaloneRows(rowKind, [rowId]);
    if (!row) {
      changedSince.push(`${rowId} (deleted)`);
      continue;
    }
    const merged: Record<string, unknown> = {};
    for (const c of changes) {
      if (!deepEqual(row[c.field], c.after)) {
        changedSince.push(`${rowId}:${c.field}`);
      }
      merged[c.field] = c.before;
    }
    plan.push({ kind: rowKind, id: rowId, merged });
  }
  if (changedSince.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Changed again since this update: ${changedSince.join(", ")}. Nothing was undone.`,
    });
  }

  const proposalIds: string[] = [];
  const undone: PackageUpdateChange[] = [];
  for (const p of plan) {
    const outcome = await writeStandaloneRow({ ...p, ctx });
    if (outcome.status === "proposed") {
      if (outcome.proposalId) proposalIds.push(outcome.proposalId);
      continue;
    }
    for (const [field, before] of Object.entries(p.merged)) {
      const c = receipt.changes.find(
        (x) => x.rowId === p.id && x.field === field
      )!;
      undone.push({ ...c, before: c.after, after: before });
    }
  }
  if (proposalIds.length > 0) return { status: "proposed", proposalIds };

  await recordPackageUpdateUndone({
    receipt,
    userId: ctx.userId as string,
    changes: undone,
  });
  return {
    status: "applied",
    receipt: { ...receipt, undoneAt: new Date().toISOString() },
  };
}
