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
 * opens that row's decision (a row, its target, or any proposal id).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Alert,
  Button,
  Checkbox,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
  addToast,
} from "@heroui/react";
import { Check, ExternalLink, Lock, X } from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative } from "../../../../lib/format";
import { openIn, type Exit } from "../../../../lib/open-in";
import { ExitFallback, externalProps } from "../../../../lib/exit-link";
import { PageHeader } from "../../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { kindIcon, kindLabel } from "../../marketplace/_lib/kind-icon";
import {
  batchOf,
  focusedRow,
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
import { ReviewDrawer, type ReviewViewer } from "./review-drawer";
import { ReviewHistory } from "./review-history";

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

type DrawerDetail = Exclude<ReviewDetail, { kind: "open" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ReviewPage({ viewer }: { viewer: ReviewViewer }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filter = reviewFilterOf(searchParams.get("type"));
  const focusId = searchParams.get("focus");
  const utils = trpc.useUtils();

  const signals = trpc.signals.list.useQuery(
    { lens: "needs-you", limit: PAGE_LIMIT },
    { staleTime: 15_000, refetchInterval: 60_000 }
  );
  const count = trpc.signals.count.useQuery(
    {},
    { staleTime: 15_000, refetchInterval: 60_000 }
  );
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
      const named = p as {
        appName?: string;
        agentName?: string;
        workspaceName?: string;
      };
      map.set(p.id, {
        id: p.id,
        proposalType: p.proposalType,
        targetType: p.targetType,
        viewerCanReview: p.viewerCanReview,
        appName: named.appName,
        agentName: named.agentName,
        authorName: p.authorName,
        workspaceName: named.workspaceName,
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
  const [open, setOpen] = useState<{
    detail: DrawerDetail;
    title: string;
  } | null>(null);
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || handledFocus.current === focusId || signals.isLoading)
      return;
    handledFocus.current = focusId;
    const row = focusedRow(rows, focusId);
    if (row?.detail && row.detail.kind !== "open") {
      setOpen({ detail: row.detail, title: row.title });
    } else if (!row && UUID.test(focusId)) {
      // Not waiting any more (or never on this page): a proposal id still
      // opens its decision, which says how it ended.
      setOpen({
        detail: { kind: "proposal", proposalId: focusId },
        title: TITLE,
      });
    }
  }, [focusId, rows, signals.isLoading]);

  function setFilter(next: ReviewFilter) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (next === "all") params.delete("type");
    else params.set("type", next);
    params.delete("focus");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function closeDrawer() {
    setOpen(null);
    if (focusId) {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.delete("focus");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }

  // ── Selection + batch (Changes rows the viewer may approve whole) ─────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const batch = batchOf(rows, selected);
  const [failures, setFailures] = useState<
    Array<{ title: string; error: string }>
  >([]);
  const [rejectOpen, setRejectOpen] = useState(false);

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
    await batchReject.mutateAsync({
      proposalIds,
      ...(reason ? { reason } : {}),
    });
    addToast({
      title: `Rejected ${picked.length} change${picked.length === 1 ? "" : "s"}`,
      color: "default",
    });
    setSelected(new Set());
    setFailures([]);
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

  return (
    <div className="max-w-[1100px] px-4 py-6 sm:px-6">
      <PageHeader title={TITLE} description={DESCRIPTION} />

      <div
        role="group"
        aria-label="Filter"
        className="mb-4 flex flex-wrap items-center gap-2"
      >
        {CHIPS.map((c) => {
          const active = filter === c.key;
          const n = c.key === "history" ? null : counts[c.key];
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(c.key)}
              className={[
                "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1",
                "text-[12.5px] font-medium tracking-tight transition-colors",
                active
                  ? "bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/15"
                  : "text-foreground/65 hover:bg-content2/50 hover:text-foreground",
              ].join(" ")}
            >
              {c.label}
              {n !== null && signals.data && (
                <span className="tabular text-[11px] text-foreground/65">
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

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

      <section className="rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
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
              selectable={selectable}
              selected={selected.has(row.key)}
              onToggle={() => toggle(row.key)}
              onOpen={() =>
                row.detail &&
                row.detail.kind !== "open" &&
                setOpen({ detail: row.detail, title: row.title })
              }
              onApprove={() => void approveRows([row])}
              approving={busy}
            />
          ))
        )}
      </section>

      {filter !== "history" && (desktopExit || shownOfTotal) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[12px] text-foreground/65">
          <span>{shownOfTotal}</span>
          {desktopExit && <ExitFallback exit={desktopExit} />}
        </div>
      )}

      <ReviewDrawer open={open} viewer={viewer} onClose={closeDrawer} />

      {rejectOpen && (
        <BatchRejectModal
          count={batch.rows.length}
          isPending={batchReject.isPending}
          onClose={() => setRejectOpen(false)}
          onConfirm={async (reason) => {
            await rejectRows(batch.rows, reason);
            setRejectOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** An ask's door, resolved through the one exit door. */
function exitOf(detail: Extract<ReviewDetail, { kind: "open" }>): Exit {
  return openIn({
    kind: "object",
    objectKind: detail.door.kind,
    id: detail.door.id,
  });
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
  selectable,
  selected,
  onToggle,
  onOpen,
  onApprove,
  approving,
}: {
  row: ReviewRow;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onApprove: () => void;
  approving: boolean;
}) {
  const exit = row.detail?.kind === "open" ? exitOf(row.detail) : null;
  const opensHere = row.detail !== null && row.detail.kind !== "open";
  const actions = (
    <div className="flex items-center gap-1.5">
      {row.inlineApprove && (
        <Button
          size="sm"
          variant="flat"
          color="success"
          radius="md"
          isDisabled={approving}
          onPress={onApprove}
          aria-label={`Approve ${row.title}`}
        >
          Approve
        </Button>
      )}
      {opensHere && (
        <Button size="sm" variant="flat" radius="md" onPress={onOpen}>
          Review
        </Button>
      )}
      {exit && (
        <Button
          as="a"
          href={exit.href}
          {...externalProps(exit.href)}
          size="sm"
          variant="flat"
          radius="md"
          endContent={
            exit.isDesktopLink ? (
              <ExternalLink className="h-3 w-3" aria-hidden />
            ) : undefined
          }
        >
          Review
        </Button>
      )}
    </div>
  );
  return (
    <div
      data-row-id={row.key}
      className={[
        "flex items-center",
        selected ? "bg-primary/[0.06]" : "",
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

function BatchRejectModal({
  count,
  isPending,
  onClose,
  onConfirm,
}: {
  count: number;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal isOpen onOpenChange={(o) => !o && onClose()} size="md">
      <ModalContent>
        <ModalHeader className="font-medium">
          Reject {count} change{count === 1 ? "" : "s"}
        </ModalHeader>
        <ModalBody className="gap-2 pb-2">
          <Textarea
            label="Reason"
            description="Optional. The agent sees it, so say what would change your mind."
            value={reason}
            onValueChange={setReason}
            minRows={3}
            size="sm"
            isDisabled={isPending}
          />
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            size="sm"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            size="sm"
            isLoading={isPending}
            onPress={() => void onConfirm(reason.trim())}
          >
            Reject {count}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
