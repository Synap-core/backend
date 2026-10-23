"use client";

/**
 * Review — everything waiting on the viewer's decision, in one place.
 *
 * ONE read: `signals.list({ lens: "needs-you" })`, the same population and
 * order the browser and relay trays read, so a count here can never disagree
 * with theirs. `proposals.list` adds, per pending proposal, the viewer's own
 * verdict (`viewerCanReview`) and the names the pod resolved — what decides
 * whether a row may be approved inline or batched (`review-rows.ts`).
 *
 * Members reach this page too (D8): the access requests are read for pod
 * admins only, so a member's Access chip simply holds their own proposals.
 *
 * URL: `?type=access|changes|asks|history` picks the view; `?focus=<id>`
 * opens that row's decision (a row, its target, or any proposal id). From
 * `lg` up the decision docks beside the list; below, it opens in a drawer.
 * An agent's question is answered in the same place (`ask-answer.tsx`);
 * once it is, the detail closes and focus moves to the next row.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, Button, Checkbox, Textarea, addToast } from "@heroui/react";
import { ArrowUpRight, Check, Lock, MessageSquare, X } from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative, isUuid } from "../../../../lib/format";
import { useReplaceParams } from "../../../../lib/use-replace-params";
import { LG_UP, useMediaQuery } from "../../../../lib/use-media-query";
import type { Exit } from "../../../../lib/open-in";
import {
  ExitFallback,
  externalProps,
  rowHref,
  usePlacedExit,
} from "../../../../lib/exit-link";
import { PageHeader, PageShell } from "../../components/page-header";
import { ConfirmModal } from "../../components/confirm-modal";
import { FilterChips } from "../../components/filter-chips";
import { useNeedsYouCount } from "../../components/side-nav-badges";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { kindIcon, kindLabel } from "../../../_lib/object/kind-icon";
import {
  batchOf,
  exitOf,
  focusedRow,
  liveAskSlot,
  reviewCounts,
  reviewFilterOf,
  reviewRows,
  rowsInView,
  summarizeBatch,
  type ProposalFacts,
  type ReviewDetail,
  type ReviewFilter,
  type ReviewRow,
} from "./review-rows";
import {
  ReviewDock,
  ReviewDrawer,
  type OpenReview,
  type ReviewViewer,
} from "./review-drawer";
import { ReviewHistory } from "./review-history";
import { nextRowKey } from "./ask-detail";

const TITLE = "Review";
const DESCRIPTION = "Everything waiting on your decision, in one place.";

/** The most rows one needs-you read returns (`signals.list` limit). */
const PAGE_LIMIT = 100;

const CHIPS: Array<{ key: ReviewFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "access", label: "Access" },
  { key: "changes", label: "Changes" },
  { key: "asks", label: "Asks" },
  { key: "history", label: "History" },
];

export function ReviewPage({ viewer }: { viewer: ReviewViewer }) {
  const searchParams = useSearchParams();
  const replaceParams = useReplaceParams();
  const filter = reviewFilterOf(searchParams.get("type"));
  const focusId = searchParams.get("focus");
  const utils = trpc.useUtils();

  const signals = trpc.signals.list.useQuery(
    { lens: "needs-you", limit: PAGE_LIMIT },
    { staleTime: 15_000, refetchInterval: 60_000 }
  );
  const count = useNeedsYouCount();
  const pending = trpc.proposals.list.useQuery(
    { status: "pending", limit: 100 },
    { staleTime: 15_000 }
  );

  useEffect(() => {
    if (signals.isError) redirectToLoginIfUnauthorized(signals.error);
  }, [signals.isError, signals.error]);

  const facts = useMemo(() => {
    const map = new Map<string, ProposalFacts>();
    for (const p of pending.data?.items ?? []) {
      map.set(p.id, {
        id: p.id,
        proposalType: p.proposalType,
        targetType: p.targetType,
        viewerCanReview: p.viewerCanReview,
        appName: p.appName,
        agentName: p.agentName,
        authorName: p.authorName,
        agentActorName: p.agentActorName,
        principal: p.principal,
        actorKind: p.actorKind,
        workspaceName: p.workspaceName,
        data: p.data,
      });
    }
    return map;
  }, [pending.data]);

  const rows = useMemo(
    () => reviewRows(signals.data?.signals ?? [], facts),
    [signals.data, facts]
  );
  const counts = reviewCounts(rows);
  const visible = filter === "history" ? [] : rowsInView(rows, filter);

  // ── The drawer, and the `?focus=` receiver ────────────────────────────────
  const [open, setOpen] = useState<OpenReview | null>(null);
  const docked = useMediaQuery(LG_UP);
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || handledFocus.current === focusId || signals.isLoading)
      return;
    handledFocus.current = focusId;
    const row = focusedRow(rows, focusId);
    const opened = row ? openOf(row) : null;
    if (opened) {
      setOpen(opened);
    } else if (!row && isUuid(focusId)) {
      // Not waiting any more (or never on this page): a proposal id still
      // opens its decision, which says how it ended.
      setOpen({
        detail: { kind: "proposal", proposalId: focusId },
        title: TITLE,
      });
    }
  }, [focusId, rows, signals.isLoading]);

  function closeDrawer() {
    setOpen(null);
    if (focusId) replaceParams((params) => params.delete("focus"));
  }

  // An answered ask leaves the list on the next read: close it, and hand
  // keyboard focus to the row after it (else the one before).
  const liveAsk =
    open?.detail.kind === "ask" ? liveAskSlot(rows, open.detail) : null;
  function askSettled() {
    const answered = open ? detailKey(open.detail) : null;
    const keys = visible.map((r) => r.key);
    const at = visible.find(
      (r) =>
        r.detail && r.detail.kind !== "open" && detailKey(r.detail) === answered
    );
    const next = at ? nextRowKey(keys, at.key) : null;
    closeDrawer();
    if (next) {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            `[data-row-id="${CSS.escape(next)}"] button`
          )
          ?.focus();
      });
    }
  }

  // ── Selection + batch (Changes rows the viewer may approve whole) ─────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const batch = batchOf(rows, selected);
  const [failures, setFailures] = useState<
    Array<{ title: string; error: string }>
  >([]);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  function refresh() {
    void utils.signals.invalidate();
    void utils.proposals.invalidate();
  }

  const batchApprove = trpc.proposals.batchApprove.useMutation({
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Approve failed",
        description: err.message,
        color: "danger",
      });
    },
  });
  const batchReject = trpc.proposals.batchReject.useMutation({
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Reject failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  async function approveRows(picked: ReviewRow[]) {
    const proposalIds = picked.flatMap((r) => r.batchIds ?? []);
    if (proposalIds.length === 0) return;
    const res = await batchApprove.mutateAsync({ proposalIds });
    const outcome = summarizeBatch(picked, res.results);
    setFailures(outcome.failures);
    addToast({
      title:
        outcome.failures.length === 0
          ? `Approved ${outcome.approved} change${outcome.approved === 1 ? "" : "s"}`
          : `Approved ${outcome.approved}, ${outcome.failures.length} failed`,
      color: outcome.failures.length === 0 ? "success" : "warning",
    });
    setSelected(new Set());
    refresh();
  }

  async function rejectRows(picked: ReviewRow[], reason: string) {
    const proposalIds = picked.flatMap((r) => r.batchIds ?? []);
    try {
      await batchReject.mutateAsync({
        proposalIds,
        ...(reason ? { reason } : {}),
      });
    } catch {
      return; // `onError` said so; the modal stays up with the reason intact.
    }
    addToast({
      title: `Rejected ${picked.length} change${picked.length === 1 ? "" : "s"}`,
      color: "default",
    });
    setSelected(new Set());
    setFailures([]);
    setRejectOpen(false);
    setRejectReason("");
    refresh();
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectable = visible.some((r) => r.batchIds);
  const busy = batchApprove.isPending || batchReject.isPending;
  // An ask whose door is in the desktop app: the install hatch, once, below.
  const desktopExit = visible
    .map((r) => (r.detail?.kind === "open" ? exitOf(r.detail) : null))
    .find((e): e is Exit => !!e?.isDesktopLink);
  const shownOfTotal =
    count.data && count.data.needsYou > rows.length
      ? `Showing the newest ${rows.length} of ${count.data.truncated ? "more than " : ""}${count.data.needsYou}.`
      : null;

  const activeKey = open ? detailKey(open.detail) : null;

  return (
    <PageShell>
      <PageHeader title={TITLE} description={DESCRIPTION} />

      <div
        className={
          docked && open
            ? "grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_420px]"
            : undefined
        }
      >
        <div className="min-w-0">
          <FilterChips
            param="type"
            defaultKey="all"
            active={filter}
            chips={CHIPS.map((c) => ({
              ...c,
              count:
                c.key === "history" || !signals.data
                  ? undefined
                  : counts[c.key],
            }))}
          />

          {batch.rows.length >= 2 && (
            <div
              role="toolbar"
              aria-label="Batch actions"
              className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.04] px-3 py-2 ring-1 ring-inset ring-foreground/10"
            >
              <span className="text-[12.5px] text-foreground/85">
                {batch.rows.length} changes selected
                <span className="text-foreground/65">
                  {" "}
                  · access requests are never batched
                </span>
              </span>
              {batch.tooMany && (
                <span className="text-[12px] text-status-down">
                  At most 50 proposals in one batch.
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="light"
                  isDisabled={busy}
                  onPress={() => setSelected(new Set())}
                >
                  Clear
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  color="danger"
                  startContent={<X className="h-3.5 w-3.5" />}
                  isDisabled={busy || batch.tooMany}
                  onPress={() => setRejectOpen(true)}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  color="success"
                  startContent={<Check className="h-3.5 w-3.5" />}
                  isLoading={batchApprove.isPending}
                  isDisabled={busy || batch.tooMany}
                  onPress={() => void approveRows(batch.rows)}
                >
                  Approve {batch.rows.length}
                </Button>
              </div>
            </div>
          )}

          {failures.length > 0 && (
            <Alert
              color="warning"
              variant="flat"
              className="mb-3"
              title={`${failures.length} could not be approved`}
              onClose={() => setFailures([])}
            >
              <ul className="flex flex-col gap-0.5">
                {failures.map((f) => (
                  <li key={f.title} className="text-[12.5px]">
                    <span className="font-medium">{f.title}</span> — {f.error}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          <section className="divide-y divide-foreground/[0.05] rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
            {filter === "history" ? (
              <ReviewHistory
                onOpen={(proposalId, title) =>
                  setOpen({ detail: { kind: "proposal", proposalId }, title })
                }
              />
            ) : signals.isLoading ? (
              <ResourceRowSkeleton count={5} />
            ) : signals.isError ? (
              <ResourceRowError
                message="Couldn't load what is waiting for you."
                onRetry={() => void signals.refetch()}
              />
            ) : visible.length === 0 ? (
              <ResourceRowEmpty
                message={
                  filter === "all"
                    ? "Nothing is waiting on you."
                    : "Nothing waiting here."
                }
              />
            ) : (
              visible.map((row) => (
                <ReviewListRow
                  key={row.key}
                  row={row}
                  active={
                    activeKey !== null &&
                    row.detail !== null &&
                    row.detail.kind !== "open" &&
                    detailKey(row.detail) === activeKey
                  }
                  selectable={selectable}
                  selected={selected.has(row.key)}
                  onToggle={() => toggle(row.key)}
                  onOpen={() => {
                    const opened = openOf(row);
                    if (opened) setOpen(opened);
                  }}
                  onApprove={() => void approveRows([row])}
                  approving={busy}
                />
              ))
            )}
          </section>

          {filter !== "history" && (desktopExit || shownOfTotal) && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[12px] text-foreground/65">
              <span>{shownOfTotal}</span>
              {desktopExit && (
                <ExitFallback exit={desktopExit} showWeb={false} />
              )}
            </div>
          )}
        </div>
        {docked && (
          <ReviewDock
            open={open}
            viewer={viewer}
            onClose={closeDrawer}
            liveAsk={liveAsk}
            onAskSettled={askSettled}
          />
        )}
      </div>

      {!docked && (
        <ReviewDrawer
          open={open}
          viewer={viewer}
          onClose={closeDrawer}
          liveAsk={liveAsk}
          onAskSettled={askSettled}
        />
      )}

      <ConfirmModal
        isOpen={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={() => void rejectRows(batch.rows, rejectReason.trim())}
        title={`Reject ${batch.rows.length} change${batch.rows.length === 1 ? "" : "s"}?`}
        consequence="Each one is refused and nothing it proposed is applied. Whoever proposed it sees your reason, if you give one."
        confirmLabel={`Reject ${batch.rows.length}`}
        isPending={batchReject.isPending}
      >
        <Textarea
          label="Reason"
          description="Optional. Say what would change your mind."
          value={rejectReason}
          onValueChange={setRejectReason}
          minRows={3}
          size="sm"
          isDisabled={batchReject.isPending}
        />
      </ConfirmModal>
    </PageShell>
  );
}

/** What a row opens beside the list, or null when its door leads elsewhere. */
function openOf(row: ReviewRow): OpenReview | null {
  const detail = row.detail;
  if (!detail || detail.kind === "open") return null;
  return {
    detail,
    // The question itself is the detail's heading; the frame names the job.
    title: detail.kind === "ask" ? "Answer the agent" : row.title,
    occurredAt: row.occurredAt,
  };
}

/** One identity per decision, so the row whose detail is open can say so. */
function detailKey(detail: Exclude<ReviewDetail, { kind: "open" }>): string {
  switch (detail.kind) {
    case "ask":
      return `ask:${detail.sessionId}:${detail.label}`;
    case "proposal":
      return `proposal:${detail.proposalId}`;
    case "issuer":
      return `issuer:${detail.issuerId}`;
    case "app-request":
      return `app-request:${detail.requestId}`;
  }
}

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

/** "Agent · Claude · Synap · 3 grouped · expires in 20m · 2h ago" */
function secondaryLine(row: ReviewRow): string {
  return [
    kindLabel(row.nounKind),
    row.who,
    row.where,
    row.reason,
    row.count > 1 ? `${row.count} grouped` : null,
    row.expiresAt ? `expires ${formatRelative(row.expiresAt)}` : null,
    formatRelative(row.occurredAt, { empty: "" }),
  ]
    .filter(Boolean)
    .join(" · ");
}

function ReviewListRow({
  row,
  active,
  selectable,
  selected,
  onToggle,
  onOpen,
  onApprove,
  approving,
}: {
  row: ReviewRow;
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
          secondary={secondaryLine(row)}
          wrap
          onSelect={opensHere ? onOpen : undefined}
          actions={actions}
        />
      </div>
    </div>
  );
}
