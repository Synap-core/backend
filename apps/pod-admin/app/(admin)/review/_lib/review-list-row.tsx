"use client";

/**
 * One Review row — the request's three lines (`reviewRowView` over the
 * shared `requestRow`: state, kind, the question and its age · what it holds ·
 * who and where, each name a door) and its one verb, with its batch checkbox.
 * Every grouping draws its rows with it, and so do the question cards and a
 * session's "Needs you" (`RequestRowLines`).
 */

import { Button, Checkbox } from "@heroui/react";
import { ArrowUpRight, Lock, MessageSquare } from "lucide-react";
import type { Exit } from "../../../../lib/open-in";
import {
  externalProps,
  rowHref,
  useAppOpenAttempt,
  usePlacedExit,
} from "../../../../lib/exit-link";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { RequestRowLines } from "../../../_lib/request/request-row-lines";
import { REQUEST_CATALOGS } from "../../../_lib/request/copy";
import { useT } from "../../../../lib/i18n/locale-provider";
import { exitOf, type ReviewRow } from "./review-rows";
import { reviewRowView } from "./review-row-view";

/**
 * An ask's "Review" when its door leads out of this page. On a phone a door
 * the mobile app cannot open becomes its web page, or no button — the line
 * beneath the list says why.
 */
function DoorButton({ exit }: { exit: Exit }) {
  const placed = usePlacedExit(exit);
  const open = useAppOpenAttempt(placed);
  const href = rowHref(placed);
  if (href === null) return null;
  return (
    <>
      <Button
        as="a"
        href={href}
        {...externalProps(href)}
        onPress={open.onOpen}
        size="sm"
        variant="flat"
        radius="md"
        endContent={
          placed.href !== null && placed.isDesktopLink ? (
            <ArrowUpRight className="h-3 w-3" strokeWidth={1.75} aria-hidden />
          ) : undefined
        }
      >
        {resolveActionLabel("review", "imperative")}
      </Button>
      {open.offer}
    </>
  );
}

export function ReviewListRow({
  row,
  active,
  selectable,
  selected,
  onToggle,
  onOpen,
  onApprove,
  approving,
  showPackage = false,
}: {
  row: ReviewRow;
  /** Name the row's package in its secondary line (any grouping but Package). */
  showPackage?: boolean;
  /** Its decision is the one open beside the list. */
  active: boolean;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onApprove: () => void;
  approving: boolean;
}) {
  const t = useT(REQUEST_CATALOGS);
  const view = reviewRowView(row, { showPackage });
  const exit = row.detail?.kind === "open" ? exitOf(row.detail) : null;
  const opensHere = view.action !== null && view.action.kind !== "exit";
  const isAsk = view.action?.kind === "answer";
  return (
    <div
      data-row-id={row.key}
      aria-current={active ? "true" : undefined}
      className={[
        "rq-row relative flex min-h-11 items-start gap-3 p-3",
        selected ? "bg-primary/[0.06]" : "",
      ].join(" ")}
    >
      {selectable && (
        <div className="relative z-10 flex w-5 shrink-0 justify-center pt-1">
          {row.batchIds ? (
            <Checkbox
              size="sm"
              isSelected={selected}
              onValueChange={onToggle}
              aria-label={t("row.select", { title: row.title })}
            />
          ) : row.group === "access" ? (
            <span title={t("row.oneAtATimeAccess")}>
              <Lock
                className="h-3.5 w-3.5 text-foreground/40"
                aria-label={t("row.oneAtATimeAccess")}
              />
            </span>
          ) : isAsk ? (
            <span title={t("row.oneAtATimeAsk")}>
              <MessageSquare
                className="h-3.5 w-3.5 text-foreground/40"
                aria-label={t("row.oneAtATimeAsk")}
              />
            </span>
          ) : null}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <RequestRowLines
          family={view.family}
          what={view.what}
          holds={view.holds}
          who={view.who}
          lead={
            view.packageLabel ? (
              <span className="font-medium text-foreground/70">
                {view.packageLabel}
              </span>
            ) : undefined
          }
          trail={
            view.repeat ? (
              <span className="text-[12px] text-foreground/55">
                {view.repeat}
              </span>
            ) : undefined
          }
          titleSlot={
            opensHere
              ? (text) => (
                  // The ROW is the button (its press area stretched over the
                  // row); the doors and verbs inside it sit above it.
                  <button
                    type="button"
                    onClick={onOpen}
                    aria-label={t("row.openDecision", { title: text })}
                    className="text-left after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary/40"
                  >
                    {text}
                  </button>
                )
              : undefined
          }
        />
      </div>
      {(view.inlineApprove || exit) && (
        <div className="relative z-10 flex shrink-0 items-center gap-1.5">
          {view.inlineApprove && (
            <Button
              size="sm"
              variant="light"
              radius="md"
              isDisabled={approving}
              onPress={onApprove}
              aria-label={t("row.approveOne", { title: row.title })}
            >
              {resolveActionLabel("approve", "imperative")}
            </Button>
          )}
          {exit && <DoorButton exit={exit} />}
        </div>
      )}
    </div>
  );
}
