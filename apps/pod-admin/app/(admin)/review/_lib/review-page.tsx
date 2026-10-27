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
 * Grouped by the decision each item asks (founder B-1, 27 Oct 2026): eight
 * packages in a fixed order, each with its count, oldest age, one action and
 * its own layout (`review-groups.tsx`). "Group by" at the top switches to
 * Work, Agent or Time (`?group=`).
 *
 * URL: `?type=history` shows decided proposals (the older
 * `access|changes|asks` still narrow the list, for links that name them);
 * `?group=work|agent|time` picks the grouping; `?focus=<id>`
 * opens that row's decision (a row, its target, or any proposal id);
 * `?session=<id>` narrows every view to one session — the door a proposal's
 * review offers to "what else from this session waits for you". From
 * `lg` up the decision docks beside the list; below, it opens in a drawer.
 * An agent's question is answered in the same place (`ask-answer.tsx`);
 * once it is, the detail closes and focus moves to the next row.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, Button, Textarea, addToast } from "@heroui/react";
import { Check, SlidersHorizontal, X } from "lucide-react";
import { navHref } from "../../../../lib/console-nav";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { isUuid } from "../../../../lib/format";
import { useReplaceParams } from "../../../../lib/use-replace-params";
import { LG_UP, useMediaQuery } from "../../../../lib/use-media-query";
import type { Exit } from "../../../../lib/open-in";
import { ExitFallback } from "../../../../lib/exit-link";
import { PageHeader, PageShell } from "../../components/page-header";
import { ConfirmModal } from "../../components/confirm-modal";
import { FilterChips } from "../../components/filter-chips";
import { useNeedsYouCount } from "../../components/side-nav-badges";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import {
  REVIEW_GROUP_BYS,
  isReviewGroupBy,
  type ReviewGroupBy,
} from "@synap-core/types/proposals/review-package";
import { resolveReviewGroupByLabel } from "@synap-core/types/vocabulary";
import {
  bookkeepingSuggestion,
  reviewRowMembers,
  type RowGroup,
  batchOf,
  exitOf,
  focusedRow,
  liveAskSlot,
  reviewChipCounts,
  reviewFilterOf,
  reviewRows,
  NEEDS_YOU_PAGE_LIMIT,
  reviewSessionOf,
  rowsInView,
  summarizeBatch,
  type ProposalFacts,
  type ReviewDetail,
  type ReviewRow,
} from "./review-rows";
import {
  ReviewDock,
  ReviewDrawer,
  ReviewInline,
  type OpenReview,
  type ReviewViewer,
} from "./review-drawer";
import { ReviewGroups } from "./review-groups";
import { ReviewListRow } from "./review-list-row";
import { useReviewPreferences } from "./review-preferences";
import { handOffRuleFor } from "./hand-off-rule";
import { ReviewHistory } from "./review-history";
import { SessionFilter } from "./review-session-filter";
import { nextRowKey } from "./ask-detail";

const TITLE = "Review";
const DESCRIPTION = "Everything waiting on your decision, in one place.";

/**
 * What is waiting, or what was decided. The packages replaced the old
 * Access · Changes · Asks chips (founder B-1); a link naming one of those
 * still narrows the list and keeps "Waiting" pressed.
 */
const CHIPS: Array<{ key: "all" | "history"; label: string }> = [
  { key: "all", label: "Waiting" },
  { key: "history", label: "History" },
];

/**
 * The grouping: a link's `?group=` wins (it names a view to land on), else
 * the person's saved choice, else Package (the default, B-4).
 */
function groupByOf(param: string | null, saved: ReviewGroupBy): ReviewGroupBy {
  return isReviewGroupBy(param) ? param : saved;
}

export function ReviewPage({ viewer }: { viewer: ReviewViewer }) {
  const searchParams = useSearchParams();
  const replaceParams = useReplaceParams();
  const filter = reviewFilterOf(searchParams.get("type"));
  const focusId = searchParams.get("focus");
  const sessionId = reviewSessionOf(searchParams.get("session"));
  const reviewPrefs = useReviewPreferences();
  const groupBy = groupByOf(searchParams.get("group"), reviewPrefs.groupBy);
  const utils = trpc.useUtils();

  // The pod narrows by session itself (`signals.list`'s session lens, the
  // proposals' `session_id`) — never a client filter over the pod-wide page.
  const scope = sessionId ? { sessionId } : {};
  const signals = trpc.signals.list.useQuery(
    { lens: "needs-you", limit: NEEDS_YOU_PAGE_LIMIT, ...scope },
    { staleTime: 15_000, refetchInterval: 60_000 }
  );
  const count = useNeedsYouCount();
  const pending = trpc.proposals.list.useQuery(
    { status: "pending", limit: 100, ...scope },
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
        requestData: p.request?.data,
      });
    }
    return map;
  }, [pending.data]);

  const rows = useMemo(
    () => reviewRows(signals.data?.signals ?? [], facts),
    [signals.data, facts]
  );
  // Narrowed to a session, the pod-wide count says nothing about its rows.
  const counts = reviewChipCounts(
    rows,
    sessionId ? null : (count.data ?? null)
  );
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

  // ── "Always for this agent" (B-3): a governance rule, human door only ─────
  const [alwaysFor, setAlwaysFor] = useState<RowGroup | null>(null);
  const createRule = trpc.governanceRules.create.useMutation();
  const alwaysRule = alwaysFor ? alwaysRuleOf(alwaysFor) : null;
  async function confirmAlways() {
    if (!alwaysRule || !alwaysFor) return;
    try {
      await createRule.mutateAsync(
        // The shared draft IS the door's input (AlwaysApproveMenu casts alike).
        alwaysRule as Parameters<typeof createRule.mutateAsync>[0]
      );
      addToast({
        title: `${alwaysFor.title ?? "This agent"} may take hand-offs`,
        description:
          "From now on they apply without asking. Revoke it in Settings › Review.",
        color: "success",
      });
      setAlwaysFor(null);
    } catch (err) {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "The rule was not created",
        description: err instanceof Error ? err.message : undefined,
        color: "danger",
      });
    }
  }

  const suggestion =
    groupBy === "package" && filter === "all"
      ? bookkeepingSuggestion(visible)
      : null;

  const selectable = visible.some((r) => r.batchIds);
  const busy = batchApprove.isPending || batchReject.isPending;
  // An ask whose door is in the desktop app: the install hatch, once, below.
  const desktopExit = visible
    .map((r) => (r.detail?.kind === "open" ? exitOf(r.detail) : null))
    .find((e): e is Exit => !!e?.isDesktopLink);
  // The pod-wide count says nothing about one session's rows: narrowed, the
  // page says only that its read hit the limit.
  const shownOfTotal = sessionId
    ? rows.length >= NEEDS_YOU_PAGE_LIMIT
      ? `Showing the newest ${rows.length} from this session.`
      : null
    : count.data && count.data.needsYou > rows.length
      ? `Showing the newest ${rows.length} of ${count.data.truncated ? "more than " : ""}${count.data.needsYou}.`
      : null;

  const activeKey = open ? detailKey(open.detail) : null;

  return (
    <PageShell>
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={
          filter !== "history" && (
            <>
              <span className="text-[12px] font-medium text-foreground/65">
                Group by
              </span>
              <FilterChips
                ariaLabel="Group by"
                className=""
                active={groupBy}
                chips={REVIEW_GROUP_BYS.map((g) => ({
                  key: g,
                  label: resolveReviewGroupByLabel(g),
                }))}
                onSelect={(g) => {
                  // A choice made here is remembered; the link's view is done.
                  reviewPrefs.setGroupBy(g);
                  replaceParams((params) => params.delete("group"));
                }}
              />
              <Button
                as="a"
                href={navHref("settings")}
                size="sm"
                variant="flat"
                startContent={
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                }
              >
                Review settings
              </Button>
            </>
          )
        }
      />

      <div
        className={
          docked && open
            ? "grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_420px]"
            : undefined
        }
      >
        <div className="min-w-0">
          {sessionId && (
            <SessionFilter
              sessionId={sessionId}
              onClear={() =>
                replaceParams((params) => {
                  params.delete("session");
                  params.delete("focus");
                })
              }
            />
          )}
          <FilterChips
            param="type"
            defaultKey="all"
            active={filter === "history" ? "history" : "all"}
            chips={CHIPS.map((c) => ({
              ...c,
              count:
                c.key === "history" || !signals.data ? undefined : counts.all,
            }))}
          />

          {suggestion && (
            <Alert
              color="success"
              variant="flat"
              className="mb-3"
              title="Suggestion"
              description={`${suggestion.count} items are agents keeping notes on their own ${suggestion.sessions === 1 ? "session" : `${suggestion.sessions} sessions`}. Keep them all as one?`}
              endContent={
                <Button
                  size="sm"
                  color="success"
                  variant="flat"
                  isDisabled={busy}
                  onPress={() => void approveRows(suggestion.rows)}
                >
                  Keep all {suggestion.count}
                </Button>
              }
            />
          )}

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

          {filter !== "history" && visible.length > 0 ? (
            <ReviewGroups
              rows={visible}
              groupBy={groupBy}
              layoutOf={reviewPrefs.layoutOf}
              onLayout={reviewPrefs.setLayout}
              actions={{
                renderRow: (row, opts) => (
                  <ReviewListRow
                    key={row.key}
                    row={row}
                    showPackage={opts?.showPackage}
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
                ),
                open: (row) => {
                  const opened = openOf(row);
                  if (opened) setOpen(opened);
                },
                keep: (picked) => void approveRows(picked),
                busy,
                renderInline: (row) => {
                  const opened = openOf(row);
                  return opened ? (
                    <ReviewInline
                      open={opened}
                      viewer={viewer}
                      onClose={refresh}
                      liveAsk={null}
                      onAskSettled={refresh}
                    />
                  ) : null;
                },
                alwaysForAgent: setAlwaysFor,
              }}
            />
          ) : (
            <section className="divide-y divide-foreground/[0.05] rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
              {filter === "history" ? (
                <ReviewHistory
                  sessionId={sessionId}
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
              ) : (
                <ResourceRowEmpty
                  message={
                    sessionId
                      ? "Nothing from this session waits for you."
                      : filter === "all"
                        ? "Nothing is waiting on you."
                        : "Nothing waiting here."
                  }
                />
              )}
            </section>
          )}

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
        isOpen={alwaysFor !== null}
        onClose={() => setAlwaysFor(null)}
        onConfirm={() => void confirmAlways()}
        title={`Always let ${alwaysFor?.title ?? "this agent"} take hand-offs?`}
        consequence="From now on, when this agent hands a session to an agent, it applies without asking you. It never covers deletes or access. You can revoke it in Settings › Review."
        confirmLabel="Always allow"
        isPending={createRule.isPending}
      />

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

/** "Always for this agent" over a hand-off block: the one rule (B-3). */
function alwaysRuleOf(group: RowGroup) {
  return group.id
    ? handOffRuleFor(group.id, group.rows.flatMap(reviewRowMembers)[0])
    : null;
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
