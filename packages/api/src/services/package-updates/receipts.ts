/**
 * Package-update RECEIPTS — what an update changed, kept so History can show
 * it and Undo can take it back (design D3, D5).
 *
 * A receipt is a `package.updated` event on the pod's append-only log (the
 * events table is never updated or deleted, and has no retention unless the
 * operator sets one, migration 0237). Its id is the event id. An undo appends
 * a `package.update_undone` event naming the receipt: a receipt is undone iff
 * such an event exists. No new table: the log already keeps who did what when.
 *
 * Every apply writes one: an apply through the update doors (`source:
 * 'person'`) and the start-up reconcile applying fields nobody edited
 * (`source: 'automatic'`).
 */

import {
  db,
  events,
  and,
  eq,
  desc,
  inArray,
  drizzleSql,
} from "@synap/database";
import {
  PACKAGE_UPDATE_UNDO_WINDOW_DAYS,
  PACKAGE_UPDATE_UNDONE_EVENT_TYPE,
  PACKAGE_UPDATED_EVENT_TYPE,
  type PackageUpdateChange,
  type PackageUpdateReceipt,
} from "@synap-core/types/package-updates";

import { logEvent } from "../../lib/event-helpers.js";

const UNDO_WINDOW_MS = PACKAGE_UPDATE_UNDO_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** A receipt being collected, before it is written. */
export interface PendingReceipt {
  slug: string;
  kind: string;
  name: string;
  fromVersion: string | null;
  toVersion: string | null;
  /** Whose log the receipt is filed under: the person, or the row's creator. */
  userId: string;
  changes: PackageUpdateChange[];
}

type ReceiptData = {
  slug: string;
  kind: string;
  name: string;
  fromVersion: string | null;
  toVersion: string | null;
  source: "person" | "automatic";
  changes: PackageUpdateChange[];
};

function toReceipt(
  row: { id: string; timestamp: Date; data: unknown },
  undoneAt: Date | null
): PackageUpdateReceipt {
  const d = row.data as ReceiptData;
  return {
    id: row.id,
    slug: d.slug,
    kind: d.kind,
    name: d.name,
    fromVersion: d.fromVersion ?? null,
    toVersion: d.toVersion ?? null,
    appliedAt: row.timestamp.toISOString(),
    source: d.source === "automatic" ? "automatic" : "person",
    changes: Array.isArray(d.changes) ? d.changes : [],
    undoUntil: new Date(row.timestamp.getTime() + UNDO_WINDOW_MS).toISOString(),
    undoneAt: undoneAt ? undoneAt.toISOString() : null,
  };
}

/** Write one receipt. A receipt with no change is not written (null). */
export async function recordPackageUpdateReceipt(
  pending: PendingReceipt & { source: "person" | "automatic" }
): Promise<PackageUpdateReceipt | null> {
  if (pending.changes.length === 0) return null;
  const data: ReceiptData = {
    slug: pending.slug,
    kind: pending.kind,
    name: pending.name,
    fromVersion: pending.fromVersion,
    toVersion: pending.toVersion,
    source: pending.source,
    changes: pending.changes,
  };
  const at = new Date();
  const id = await logEvent(pending.userId, PACKAGE_UPDATED_EVENT_TYPE, data, {
    subjectType: "package",
    subjectId: pending.slug,
    source: pending.source === "automatic" ? "system" : "api",
  });
  return toReceipt({ id, timestamp: at, data }, null);
}

/** When each receipt was undone (absent = not undone). */
async function undoneAtFor(ids: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (ids.length === 0) return out;
  const receiptId = drizzleSql<string>`${events.data}->>'receiptId'`;
  const rows = await db
    .select({ receiptId, timestamp: events.timestamp })
    .from(events)
    .where(
      and(
        eq(events.type, PACKAGE_UPDATE_UNDONE_EVENT_TYPE),
        inArray(receiptId, ids)
      )
    );
  for (const r of rows) out.set(r.receiptId, r.timestamp);
  return out;
}

/** The newest receipts first, optionally for one package. */
export async function listPackageUpdateReceipts(
  opts: { slug?: string; limit?: number } = {}
): Promise<PackageUpdateReceipt[]> {
  const rows = await db
    .select({ id: events.id, timestamp: events.timestamp, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.type, PACKAGE_UPDATED_EVENT_TYPE),
        opts.slug ? eq(events.subjectId, opts.slug) : undefined
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(opts.limit ?? 50);
  const undone = await undoneAtFor(rows.map((r) => r.id));
  return rows.map((r) => toReceipt(r, undone.get(r.id) ?? null));
}

export async function getPackageUpdateReceipt(
  id: string
): Promise<PackageUpdateReceipt | null> {
  const [row] = await db
    .select({ id: events.id, timestamp: events.timestamp, data: events.data })
    .from(events)
    .where(and(eq(events.id, id), eq(events.type, PACKAGE_UPDATED_EVENT_TYPE)))
    .limit(1);
  if (!row) return null;
  const undone = await undoneAtFor([row.id]);
  return toReceipt(row, undone.get(row.id) ?? null);
}

/** Record that a receipt was undone, with the writes the undo made. */
export async function recordPackageUpdateUndone(args: {
  receipt: PackageUpdateReceipt;
  userId: string;
  changes: PackageUpdateChange[];
}): Promise<void> {
  await logEvent(
    args.userId,
    PACKAGE_UPDATE_UNDONE_EVENT_TYPE,
    {
      receiptId: args.receipt.id,
      slug: args.receipt.slug,
      changes: args.changes,
    },
    { subjectType: "package", subjectId: args.receipt.slug }
  );
}
