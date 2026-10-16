/**
 * RUN ACTION — one tap on a Library chip ("Add to calendar", "Add expense",
 * "Add person", "Add task").
 *
 * A chip never writes: it files ONE governed proposal through the capture
 * graph door (`submitCaptureGraph`) with one thing in it, and the item as its
 * source document (`sourceDocumentIds`), so the approved thing is linked back
 * to what it was made from (`produced` edge, stamp-materialized). The person
 * approves it like any other proposal. AI proposes, never executes — and no
 * agent key reaches this door (`agentUserId` is never set, so it is always
 * a pending proposal, never an auto-apply).
 *
 *   | chip    | files                                                        |
 *   | date    | an `event` (startDate, all-day unless a time was found)      |
 *   | receipt | a `note` with amount / currency / merchant / date properties |
 *   |         | (the pod has no expense kind)                               |
 *   | contact | a `person` (email / phone — identity-resolved by the door)   |
 *   | task    | a `task` (dueDate when found)                                |
 *
 * Once per chip: the chip is claimed under a row lock before filing and
 * stamped with its `proposalId` after. A second tap returns the same proposal;
 * a tap while the first is still filing is refused (`IN_FLIGHT`).
 */

import { createLogger } from "@synap-core/core";
import { documents, drizzleSql, and, eq, isNull } from "@synap/database";
import type { db as DbType } from "@synap/database";
import {
  libraryItemOf,
  readLibraryItemRead,
  type ImportItemMetadata,
  type LibraryAction,
  type LibraryRunActionResult,
} from "@synap-core/types/imports";
import type {
  SubmitCaptureGraphInput,
  SubmitCaptureGraphResult,
} from "../capture-agent/submit-capture-graph.js";

const logger = createLogger({ module: "library/run-action" });

/** A claim older than this is a filing that died; the chip may be run again. */
export const ACTION_CLAIM_STALE_MS = 2 * 60_000;

export type LibraryActionErrorCode =
  "ITEM_NOT_FOUND" | "ACTION_NOT_FOUND" | "IN_FLIGHT";

export class LibraryActionError extends Error {
  constructor(
    readonly code: LibraryActionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LibraryActionError";
  }
}

type StoredAction = LibraryAction & { claimedAt?: string };

export type LibraryActionEntity = SubmitCaptureGraphInput["entities"][number];

function textOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The ONE thing a chip files, from its value and the item it came from. */
export function libraryActionEntity(
  action: Pick<LibraryAction, "kind" | "value">,
  item: { title: string }
): LibraryActionEntity {
  const v = action.value;
  const from = `From your Library: ${item.title}`;
  switch (action.kind) {
    case "date": {
      const date = textOf(v.date)!;
      const time = textOf(v.time);
      return {
        ref: "a0",
        profileSlug: "event",
        title: textOf(v.title) ?? item.title,
        description: from,
        properties: {
          startDate: time ? `${date}T${time}:00` : date,
          isAllDay: !time,
        },
      };
    }
    case "receipt": {
      const amount = typeof v.amount === "number" ? v.amount : undefined;
      const currency = textOf(v.currency);
      const merchant = textOf(v.merchant);
      const date = textOf(v.date);
      const money =
        amount !== undefined
          ? `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`
          : undefined;
      return {
        ref: "a0",
        profileSlug: "note",
        title: ["Receipt", merchant, money].filter(Boolean).join(" · "),
        description: from,
        properties: {
          ...(amount !== undefined ? { amount } : {}),
          ...(currency ? { currency } : {}),
          ...(merchant ? { merchant } : {}),
          ...(date ? { date } : {}),
        },
      };
    }
    case "contact": {
      const email = textOf(v.email);
      const phone = textOf(v.phone);
      return {
        ref: "a0",
        profileSlug: "person",
        title: textOf(v.name) ?? email ?? phone ?? item.title,
        description: from,
        properties: {
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
        },
      };
    }
    case "task": {
      const due = textOf(v.dueDate);
      return {
        ref: "a0",
        profileSlug: "task",
        title: textOf(v.title) ?? item.title,
        description: from,
        properties: due ? { dueDate: due } : {},
      };
    }
  }
}

type Db = Pick<typeof DbType, "select" | "update" | "transaction">;

async function setAction(
  tx: Pick<typeof DbType, "update">,
  itemId: string,
  actions: StoredAction[]
) {
  await tx
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(${documents.metadata}, '{importRead,suggestedActions}', ${JSON.stringify(actions)}::jsonb)`,
    })
    .where(eq(documents.id, itemId));
}

/** Lock the item, find the chip, apply `change` (null = leave as is). */
async function withAction<T>(
  database: Db,
  args: { userId: string; itemId: string; actionId: string },
  change: (
    action: StoredAction,
    item: ImportItemMetadata & { workspaceId: string | null; docTitle: string }
  ) => { next: StoredAction | null; result: T }
): Promise<T> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({
        metadata: documents.metadata,
        workspaceId: documents.workspaceId,
        title: documents.title,
      })
      .from(documents)
      .where(
        and(
          eq(documents.id, args.itemId),
          eq(documents.userId, args.userId),
          isNull(documents.deletedAt)
        )
      )
      .for("update");
    const meta = row?.metadata as Record<string, unknown> | null | undefined;
    const item = libraryItemOf(meta);
    if (!row || !item) {
      throw new LibraryActionError("ITEM_NOT_FOUND", "Library item not found");
    }
    const actions = readLibraryItemRead(meta, item.contentStatus)
      .suggestedActions as StoredAction[];
    const index = actions.findIndex((a) => a.id === args.actionId);
    if (index < 0) {
      throw new LibraryActionError(
        "ACTION_NOT_FOUND",
        "This suggestion is no longer on the item"
      );
    }
    const { next, result } = change(actions[index]!, {
      ...item,
      workspaceId: row.workspaceId,
      docTitle: row.title,
    });
    if (next) {
      const updated = actions.slice();
      updated[index] = next;
      await setAction(tx, args.itemId, updated);
    }
    return result;
  });
}

/**
 * Run one chip of one item. The caller (the `library.runAction` door) has
 * authenticated `userId`; the item must be theirs (owner floor).
 */
export async function runLibraryAction(args: {
  database: Db;
  userId: string;
  itemId: string;
  actionId: string;
  /** Injected in tests; defaults to the capture graph door. */
  submit?: (
    input: SubmitCaptureGraphInput
  ) => Promise<Pick<SubmitCaptureGraphResult, "proposalId" | "applied">>;
  now?: () => Date;
}): Promise<LibraryRunActionResult> {
  const now = args.now ?? (() => new Date());
  const ids = {
    userId: args.userId,
    itemId: args.itemId,
    actionId: args.actionId,
  };

  type Claim =
    | { done: LibraryRunActionResult }
    | {
        action: StoredAction;
        title: string;
        workspaceId: string | null;
      };
  const claim = await withAction<Claim>(args.database, ids, (action, item) => {
    if (action.proposalId) {
      return {
        next: null,
        result: { done: { proposalId: action.proposalId, status: "proposed" } },
      };
    }
    const claimedAt = action.claimedAt ? Date.parse(action.claimedAt) : NaN;
    if (
      Number.isFinite(claimedAt) &&
      now().getTime() - claimedAt < ACTION_CLAIM_STALE_MS
    ) {
      throw new LibraryActionError(
        "IN_FLIGHT",
        "This suggestion is already being filed"
      );
    }
    return {
      next: { ...action, claimedAt: now().toISOString() },
      result: {
        action,
        title: item.title || item.docTitle,
        workspaceId: item.workspaceId,
      },
    };
  });
  if ("done" in claim) return claim.done;

  const submit =
    args.submit ??
    (async (input: SubmitCaptureGraphInput) => {
      // Loaded lazily, as every Library service loads the capture graph door:
      // it pulls the whole write stack into whatever imports this module.
      const { submitCaptureGraph } =
        await import("../capture-agent/submit-capture-graph.js");
      return submitCaptureGraph(input);
    });

  let filed: Pick<SubmitCaptureGraphResult, "proposalId" | "applied">;
  try {
    filed = await submit({
      userId: args.userId,
      workspaceId: claim.workspaceId,
      sourceDocumentIds: [args.itemId],
      entities: [libraryActionEntity(claim.action, { title: claim.title })],
      relations: [],
      summary: claim.action.label,
      rawSource: { label: `Library · ${claim.title}` },
    });
  } catch (err) {
    // Release the claim so the chip can be tapped again.
    await withAction(args.database, ids, (action) => {
      const { claimedAt: _released, ...rest } = action;
      return { next: rest, result: undefined };
    }).catch((releaseErr) =>
      // Said, not hidden: the claim expires after ACTION_CLAIM_STALE_MS.
      logger.error(
        { err: releaseErr, itemId: args.itemId, actionId: args.actionId },
        "library chip: claim NOT released — the chip unlocks when it expires"
      )
    );
    throw err;
  }
  if (!filed.proposalId) {
    throw new Error("The capture door filed no proposal for this suggestion");
  }
  const proposalId = filed.proposalId;
  try {
    await withAction(args.database, ids, (action) => {
      const { claimedAt: _done, ...rest } = action;
      return { next: { ...rest, proposalId }, result: undefined };
    });
  } catch (err) {
    // A re-read replaced the chips while this one was filing: the proposal
    // stands (it is the person's to review); only the chip mark is lost.
    if (!(err instanceof LibraryActionError)) throw err;
  }
  // Running a chip is handling the item: the auto-archive clock restarts.
  await args.database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(${documents.metadata}, '{importCuration,seenAt}', to_jsonb(now()::text), true)`,
    })
    .where(
      and(
        eq(documents.id, args.itemId),
        eq(documents.userId, args.userId),
        drizzleSql`${documents.metadata} ? 'importCuration'`
      )
    );
  return { proposalId, status: filed.applied ? "applied" : "proposed" };
}
