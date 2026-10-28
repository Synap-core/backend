"use client";

/**
 * One Review row — a decision's title, who asked, where, and its one verb —
 * with its batch checkbox. Every grouping draws its rows with it (moved out of
 * `review-page.tsx` so the package sections can draw the same row).
 */

import { Button, Checkbox } from "@heroui/react";
import { ArrowUpRight, Lock, MessageSquare } from "lucide-react";
import { formatRelative } from "../../../../lib/format";
import type { Exit } from "../../../../lib/open-in";
import {
  externalProps,
  rowHref,
  usePlacedExit,
} from "../../../../lib/exit-link";
import { ResourceRow } from "../../components/resource-row";
import { kindIcon, kindLabel } from "../../../_lib/object/kind-icon";
import { lensRowExpiry } from "@synap-core/types/lens";
import { resolveReviewPackageLabel } from "@synap-core/types/vocabulary";
import { exitOf, type ReviewRow } from "./review-rows";

/**
 * An ask's "Review" when its door leads out of this page. On a phone a door
 * the mobile app cannot open becomes its web page, or no button — the line
 * beneath the list says why.
 */
function DoorButton({ exit }: { exit: Exit }) {
  const placed = usePlacedExit(exit);
  const href = rowHref(placed);
  if (href === null) return null;
  return (
    <Button
      as="a"
      href={href}
      {...externalProps(href)}
      size="sm"
      variant="flat"
      radius="md"
      endContent={
        placed.href !== null && placed.isDesktopLink ? (
          <ArrowUpRight className="h-3 w-3" strokeWidth={1.75} aria-hidden />
        ) : undefined
      }
    >
      Review
    </Button>
  );
}

/** "Agent · Claude · Synap · 3 grouped · Expires in 20m · 2h ago" */
export function secondaryLine(
  row: ReviewRow,
  { showPackage = false }: { showPackage?: boolean } = {}
): string {
  // Outside "Group by Package" the row says which decision it asks; a kind
  // that reads the same word (Knowledge · Knowledge) is said once.
  const pkg = showPackage ? resolveReviewPackageLabel(row.package) : null;
  const kind = kindLabel(row.nounKind);
  return [
    pkg,
    kind === pkg ? null : kind,
    row.who,
    row.where,
    row.reason,
    row.count > 1 ? `${row.count} grouped` : null,
    lensRowExpiry(row)?.label ?? null,
    formatRelative(row.occurredAt, { empty: "" }),
  ]
    .filter(Boolean)
    .join(" · ");
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
  const exit = row.detail?.kind === "open" ? exitOf(row.detail) : null;
  const opensHere = row.detail !== null && row.detail.kind !== "open";
  const isAsk = row.detail?.kind === "ask";
  const actions = (
    <div className="flex items-center gap-1.5">
      {row.inlineApprove && (
        <Button
          size="sm"
          variant="light"
          radius="md"
          isDisabled={approving}
          onPress={onApprove}
          aria-label={`Approve ${row.title}`}
        >
          Approve
        </Button>
      )}
      {opensHere && (
        <Button
          size="sm"
          variant="flat"
          radius="md"
          onPress={onOpen}
          startContent={
            isAsk ? (
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            ) : undefined
          }
        >
          {isAsk ? "Answer" : "Review"}
        </Button>
      )}
      {exit && <DoorButton exit={exit} />}
    </div>
  );
  return (
    <div
      data-row-id={row.key}
      aria-current={active ? "true" : undefined}
      className={[
        "flex items-center",
        selected || active ? "bg-primary/[0.06]" : "",
      ].join(" ")}
    >
      {selectable && (
        <div className="flex w-9 shrink-0 justify-center">
          {row.batchIds ? (
            <Checkbox
              size="sm"
              isSelected={selected}
              onValueChange={onToggle}
              aria-label={`Select ${row.title}`}
            />
          ) : row.group === "access" ? (
            <span title="Access requests are reviewed one at a time">
              <Lock
                className="h-3.5 w-3.5 text-foreground/40"
                aria-label="Access requests are reviewed one at a time"
              />
            </span>
          ) : isAsk ? (
            <span title="Questions are answered one at a time">
              <MessageSquare
                className="h-3.5 w-3.5 text-foreground/40"
                aria-label="Questions are answered one at a time"
              />
            </span>
          ) : null}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <ResourceRow
          Icon={kindIcon(row.nounKind)}
          primary={row.title}
          secondary={secondaryLine(row, { showPackage })}
          wrap
          onSelect={opensHere ? onOpen : undefined}
          actions={actions}
        />
      </div>
    </div>
  );
}
