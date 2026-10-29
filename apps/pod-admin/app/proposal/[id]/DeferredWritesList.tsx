"use client";

/**
 * The writes a proposal KEEPS for later — an agent's held-writes pack
 * (`agent/held_writes`, past its daily write ceiling) or the writes it made
 * into a space it had not joined (`workspace/join`) — one row per write.
 *
 * Founder screenshot (2026-10-27, an approved held-writes pack): the page drew
 * the payload as a record — "Untitled", DAY, DEFERRED WRITES "10 items",
 * DEFERRED OUTCOMES a run of raw ids — and nobody could tell WHAT the ten
 * writes were or what became of each. Now each write reads as what replaying
 * it does (`Create Task "Ship v2"`, the shared `deriveDeferredWritesReview`),
 * and once decided its outcome as a mark: applied (the row opens the record),
 * proposed (the row opens the proposal it filed), refused (with the reason).
 * Capped, then "Show all N"; an entry that cannot be read is counted and said.
 */

import { useState } from "react";
import { Button } from "@heroui/react";
import {
  DEFERRED_OUTCOME_TONE,
  type DeferredWriteRow,
  type DeferredWritesReview,
} from "@synap-core/types/proposals/deferred-writes";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { openIn, type Exit } from "../../../lib/open-in";
import {
  rowHref,
  useAppOpenAttempt,
  usePlacedExit,
} from "../../../lib/exit-link";
import { kindIcon, kindLabel } from "../../_lib/object/kind-icon";
import { StatusPill } from "../../(admin)/components/status-pill";
import { statusKindForTone } from "../../(admin)/components/status-tone";
import { proposalPageT } from "./copy";

/** Writes drawn before "Show all N writes". */
export const DEFERRED_WRITES_SHOWN = 8;

/**
 * Where a write's row leads once decided: the record its replay wrote, or
 * the proposal its replay filed. Undecided, or refused, it leads nowhere.
 */
export function deferredWriteExit(row: DeferredWriteRow): Exit | undefined {
  const o = row.outcome;
  if (o?.outcome === "applied" && row.recordId) {
    return openIn({
      kind: "object",
      objectKind: row.objectKind,
      id: row.recordId,
    });
  }
  if (o?.outcome === "proposed" && o.proposalId) {
    return openIn({ kind: "object", objectKind: "proposal", id: o.proposalId });
  }
  return undefined;
}

function RowTitle({ title, exit }: { title: string; exit?: Exit }) {
  return exit ? (
    <DoorTitle title={title} exit={exit} />
  ) : (
    <span className="min-w-0 break-words">{title}</span>
  );
}

function DoorTitle({ title, exit }: { title: string; exit: Exit }) {
  const placed = usePlacedExit(exit);
  const open = useAppOpenAttempt(placed);
  const href = rowHref(placed);
  if (href === null) {
    return <span className="min-w-0 break-words">{title}</span>;
  }
  return (
    <>
      <a
        href={href}
        onClick={open.onOpen}
        className="min-w-0 break-words underline decoration-foreground/20 underline-offset-2 hover:text-foreground hover:decoration-foreground/60"
      >
        {title}
      </a>
      {open.offer}
    </>
  );
}

function WriteRow({ row }: { row: DeferredWriteRow }) {
  const Icon = kindIcon(row.kind);
  /* A write the reviewer left out before approving reads as what it will
     become (`skipped_by_reviewer`), so the mark does not change at approval. */
  const state =
    row.outcome?.outcome ?? (row.leftOut ? "skipped_by_reviewer" : null);
  return (
    <li
      data-deferred-write={row.ref}
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-[13px] text-foreground/85"
    >
      <Icon
        aria-label={kindLabel(row.kind)}
        className="h-3.5 w-3.5 shrink-0 text-foreground/55"
      />
      <RowTitle title={row.title} exit={deferredWriteExit(row)} />
      {state && (
        <StatusPill
          kind={statusKindForTone(DEFERRED_OUTCOME_TONE[state])}
          label={resolveStatusLabel(state)}
        />
      )}
      {row.outcome?.outcome === "refused" && row.outcome.reason && (
        <span className="basis-full pl-5 text-[12px] text-foreground/60">
          {row.outcome.reason}
        </span>
      )}
    </li>
  );
}

export function DeferredWritesList({
  review,
}: {
  review: DeferredWritesReview;
}) {
  const [all, setAll] = useState(false);
  const t = proposalPageT();
  const shown = all ? review.rows : review.rows.slice(0, DEFERRED_WRITES_SHOWN);
  return (
    <section
      aria-label="Writes"
      data-deferred-writes=""
      className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] px-4 py-3.5 ring-1 ring-inset ring-foreground/10"
    >
      <h2 className="font-heading text-[15px] font-medium text-foreground">
        {t("deferredWrites.count", { n: review.total })}
      </h2>
      {shown.length > 0 && (
        <ul className="flex flex-col divide-y divide-foreground/[0.05]">
          {shown.map((row) => (
            <WriteRow key={row.ref} row={row} />
          ))}
        </ul>
      )}
      {review.rows.length > shown.length && (
        <Button
          size="sm"
          variant="light"
          className="self-start px-1 text-[12.5px] text-foreground/65"
          onPress={() => setAll(true)}
        >
          {t("deferredWrites.showAll", { n: review.rows.length })}
        </Button>
      )}
      {review.unreadable > 0 && (
        <p
          data-deferred-unreadable=""
          className="text-[12px] text-status-stale"
        >
          {t("deferredWrites.unreadable", { n: review.unreadable })}
        </p>
      )}
    </section>
  );
}
