"use client";

/**
 * Review one template update (Review template, page grammar §1): the change
 * first (a summary of marks, then one card per changed field), then what
 * applying does, with ONE named primary in a decision bar pinned to the
 * window ("Update skill"), "Not now" and "Stop updates". After applying, a
 * receipt with Undo and the next update in the queue.
 *
 * Every state is said, never guessed: loading (the page's shape), a failed
 * read (Try again; never "no update"), gone (no update waits for this
 * package), the catalog moved while the page was open (409: nothing written,
 * Reload), and an apply that became a request (an agent, or a person without
 * the right) with its door.
 *
 * The plan is the pod's (`packageUpdates.get`, one comparator); the choices,
 * the recommendation and the bar's words are the model's (`updates-model.ts`).
 */

import { Button } from "@heroui/react";
import { ChevronLeft, ChevronRight, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import type { TFunction } from "@synap-core/types/i18n";
import { redirectToLoginIfUnauthorized } from "../../../../../lib/auth-redirect";
import { navHref, navLabel } from "../../../../../lib/console-nav";
import { useT } from "../../../../../lib/i18n/locale-provider";
import {
  Breadcrumbs,
  ObjectHeader,
} from "../../../../_lib/object/object-header";
import { ConfirmModal } from "../../../components/confirm-modal";
import {
  PageFallback,
  PageShell,
  PageSkeleton,
} from "../../../components/page-header";
import { ResourceRowError } from "../../../components/resource-row";
import { catalogKindLabel } from "../../_lib/catalog-model";
import {
  choiceKey,
  type PackageUpdatePlan,
  packageFieldLabel,
  type PackageUpdateApplyResult,
  type PackageUpdateSummary,
} from "../_lib/contract";
import { en, fr } from "../_lib/copy";
import { FieldCard } from "../_lib/field-card";
import { UpdateMark } from "../_lib/update-mark";
import { packageUpdateHref } from "../_lib/updates-tab";
import { stateCountLabel, summaryMark } from "../_lib/update-words";
import {
  applyInput,
  decisionOf,
  fieldMark,
  groupMark,
  initialChoices,
  nextAfter,
  queuePosition,
  recommendedChoice,
  stateCounts,
  updateFailureOf,
  type ChoiceId,
  type Decision,
} from "../_lib/updates-model";
import {
  useApplyPackageUpdate,
  useDetachPackage,
  usePackageUpdateList,
  usePackageUpdatePlan,
  useUndoPackageUpdate,
} from "../_lib/use-package-updates";

const CATALOGS = { en, fr };

/** The Updates tab, where "Not now" and "Back to updates" go. */
const UPDATES_HREF = navHref("marketplace", { tab: "updates" });

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function PackageUpdatePage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <PackageUpdate />
    </Suspense>
  );
}

function PackageUpdate() {
  const t = useT(CATALOGS);
  const params = useParams<{ slug: string }>();
  const slug = decodeSegment(params?.slug ?? "");
  const plan = usePackageUpdatePlan(slug);
  const list = usePackageUpdateList();

  useEffect(() => {
    if (plan.error) redirectToLoginIfUnauthorized(plan.error);
  }, [plan.error]);

  // Once read, the plan stays on screen: after an apply the pod no longer has
  // an update for it, and the receipt must not turn into "no update".
  if (plan.data) {
    return (
      <ReviewUpdate
        // A new catalog version is a new review: choices start again.
        key={`${plan.data.slug}@${plan.data.latestVersion ?? ""}`}
        plan={plan.data}
        list={list.data?.updates ?? null}
        onReload={() => void plan.refetch()}
      />
    );
  }
  if (plan.isLoading) {
    return (
      <PageShell>
        <PageSkeleton rows={5} label={t("review.loading")} />
      </PageShell>
    );
  }
  return (
    <PageShell className="flex flex-col gap-4">
      <Breadcrumbs
        crumbs={[
          { label: navLabel("marketplace"), href: navHref("marketplace") },
          { label: t("review.trail"), href: UPDATES_HREF },
        ]}
      />
      {updateFailureOf(plan.error) === "gone" ? (
        <div className="flex flex-col items-start gap-2 rounded-lg bg-foreground/[0.02] p-4 ring-1 ring-inset ring-foreground/10">
          <p className="text-[13px] font-medium text-foreground">
            {t("review.gone.title")}
          </p>
          <p className="text-[12.5px] text-foreground/65">
            {t("review.gone.body")}
          </p>
          <Link
            href={UPDATES_HREF}
            className="rounded-sm text-[12.5px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {t("review.gone.back")}
          </Link>
        </div>
      ) : (
        <ResourceRowError
          message={t("review.failed")}
          onRetry={() => void plan.refetch()}
        />
      )}
    </PageShell>
  );
}

type Outcome =
  | { kind: "editing" }
  | { kind: "conflict" }
  | { kind: "failed" }
  | {
      kind: "receipt";
      result: PackageUpdateApplyResult;
      changedNothing: boolean;
    }
  | { kind: "stopped" };

function ReviewUpdate({
  plan,
  list,
  onReload,
}: {
  plan: PackageUpdatePlan;
  list: readonly PackageUpdateSummary[] | null;
  onReload: () => void;
}) {
  const t = useT(CATALOGS);
  const [chosen, setChosen] = useState<Record<string, ChoiceId>>(() =>
    initialChoices(plan)
  );
  const [edits, setEdits] = useState<Record<string, string>>({});
  // The changes to records the person ticked, by id (`acceptDataChanges`).
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<Outcome>({ kind: "editing" });
  const [stopping, setStopping] = useState(false);
  const apply = useApplyPackageUpdate();
  const detach = useDetachPackage();

  const decision = decisionOf(plan, chosen, edits, accepted);
  const { group, label: markLabel } = summaryMark(t, plan);
  const queue = list ? queuePosition(list, plan.slug) : null;
  const kindWord = catalogKindLabel(plan.kind);
  const busy = apply.isPending || detach.isPending;

  async function onApply() {
    try {
      const result = await apply.mutateAsync(
        applyInput(plan, chosen, edits, accepted)
      );
      setOutcome({
        kind: "receipt",
        result,
        changedNothing: decision.primary === "keep",
      });
      window.scrollTo({ top: 0 });
    } catch (err) {
      setOutcome({
        kind: updateFailureOf(err) === "conflict" ? "conflict" : "failed",
      });
    }
  }

  async function onStop() {
    try {
      await detach.mutateAsync(plan.rows);
      setStopping(false);
      setOutcome({ kind: "stopped" });
    } catch {
      setStopping(false);
      setOutcome({ kind: "failed" });
    }
  }

  const header = (
    <ObjectHeader
      kind={plan.kind}
      noun={
        <span className="flex flex-wrap items-center gap-2">
          {outcome.kind === "receipt" && outcome.result.status === "applied" ? (
            <UpdateMark mark={groupMark("current")} label={t("mark.current")} />
          ) : (
            <UpdateMark mark={groupMark(group)} label={markLabel} />
          )}
          <span>{kindWord}</span>
        </span>
      }
      title={plan.name}
      summary={
        outcome.kind === "receipt" || outcome.kind === "stopped"
          ? null
          : reviewSummary(t, group, kindWord)
      }
      breadcrumb={[
        { label: navLabel("marketplace"), href: navHref("marketplace") },
        { label: t("review.trail"), href: UPDATES_HREF },
        { label: plan.name },
      ]}
      primaryAction={queue && <Queue queue={queue} />}
    />
  );

  if (outcome.kind === "receipt" || outcome.kind === "stopped") {
    return (
      <PageShell className="flex flex-col gap-5">
        {header}
        <Receipt
          plan={plan}
          outcome={outcome}
          next={list ? nextAfter(list, plan.slug) : null}
        />
      </PageShell>
    );
  }

  const sameRest = plan.rows.reduce(
    (n, row) => n + row.fields.filter((f) => f.state === "same").length,
    0
  );
  const severalParts = plan.rows.length > 1;

  return (
    <PageShell className="flex flex-col gap-5">
      {header}

      {outcome.kind === "conflict" && (
        <Notice tone="warning">
          {t("review.conflict")}{" "}
          <Button size="sm" variant="flat" radius="md" onPress={onReload}>
            {t("review.conflict.reload")}
          </Button>
        </Notice>
      )}

      {/* The change first: what each state counts, then each field. */}
      <section className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.02] px-4 py-3 ring-1 ring-inset ring-foreground/10">
        {stateCounts(plan.counts).map(({ state, count }) => (
          <UpdateMark
            key={state}
            mark={fieldMark(state)}
            label={stateCountLabel(t, state, count)}
          />
        ))}
        {plan.installedVersion && plan.latestVersion && (
          <span className="text-[12px] text-foreground/65 sm:ml-auto">
            {t("review.version")}{" "}
            <span className="font-mono">
              {plan.installedVersion} → {plan.latestVersion}
            </span>
          </span>
        )}
      </section>

      {plan.rows.map((row) => {
        const changed = row.fields.filter((f) => f.state !== "same");
        // A part with nothing changed says nothing (OMIT): it is counted in
        // the "same" line below.
        if (changed.length === 0) return null;
        return (
          <section key={row.rowId} className="flex flex-col gap-3">
            {severalParts && (
              <h2 className="text-[14px] font-medium tracking-tight text-foreground">
                {row.name}{" "}
                <span className="font-normal text-foreground/60">
                  · {catalogKindLabel(row.rowKind)}
                </span>
              </h2>
            )}
            {changed.map((field) => {
              const key = choiceKey(row.rowId, field.key);
              return (
                <FieldCard
                  key={key}
                  field={field}
                  recommended={recommendedChoice(
                    field,
                    plan.recommended?.[key]
                  )}
                  choice={chosen[key]}
                  edited={edits[key]}
                  disabled={busy}
                  onChoose={(c) => setChosen((prev) => ({ ...prev, [key]: c }))}
                  onEdit={(text) =>
                    setEdits((prev) => ({ ...prev, [key]: text }))
                  }
                />
              );
            })}
          </section>
        );
      })}

      {sameRest > 0 && (
        <p className="text-[12.5px] text-foreground/65">
          {t("review.sameRest", { n: sameRest })}
        </p>
      )}

      {(plan.dataChanges?.count ?? 0) > 0 && plan.dataChanges && (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[14px] font-medium tracking-tight text-foreground">
              {t("records.title")}
            </h2>
            <span className="text-[12px] text-foreground/65">
              {t("records.meta")}
            </span>
          </div>
          <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.02] p-4 ring-1 ring-inset ring-foreground/10">
            <ul className="flex flex-col gap-2.5">
              {plan.dataChanges.items.map((change) => (
                <li key={change.id} className="text-[13px] text-foreground">
                  {change.destructive ? (
                    // Never run by an update: shown, with no box.
                    <span className="flex flex-col">
                      <span>{change.sentence}</span>
                      <span className="text-[12px] text-status-stale">
                        {t("records.destructive")}
                      </span>
                    </span>
                  ) : (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={accepted.has(change.id)}
                        disabled={busy}
                        onChange={(e) =>
                          setAccepted((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(change.id);
                            else next.delete(change.id);
                            return next;
                          })
                        }
                      />
                      <span className="flex flex-col">
                        <span>{change.sentence}</span>
                        {change.affected !== null && (
                          <span className="text-[12px] text-foreground/65">
                            {t("records.affected", { n: change.affected })}
                          </span>
                        )}
                      </span>
                    </label>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-[12px] text-foreground/65">
              {t("records.note")}
            </p>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-[14px] font-medium tracking-tight text-foreground">
          {t("after.title")}
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-relaxed text-foreground/75">
          <li>{t("after.write", { kind: kindWord.toLowerCase() })}</li>
          <li>{t("after.baseline")}</li>
          <li>{t("after.undo")}</li>
          <li>{t("after.agents")}</li>
        </ul>
      </section>

      <DecisionBar
        plan={plan}
        decision={decision}
        failed={outcome.kind === "failed"}
        busy={busy}
        onApply={() => void onApply()}
        onStop={() => setStopping(true)}
      />

      <ConfirmModal
        isOpen={stopping}
        onClose={() => setStopping(false)}
        onConfirm={() => void onStop()}
        title={t("stop.title", { name: plan.name })}
        consequence={t("stop.body")}
        confirmLabel={t("stop.confirm")}
        confirmColor="warning"
        isPending={detach.isPending}
      />
    </PageShell>
  );
}

function reviewSummary(
  t: TFunction<typeof en>,
  group: ReturnType<typeof summaryMark>["group"],
  kind: string
): string {
  const k = kind.toLowerCase();
  switch (group) {
    case "choice":
      return t("review.summary.choose", { kind: k });
    case "consent":
      return t("review.summary.consent");
    case "nothing":
      return t("review.summary.yours", { kind: k });
    default:
      return t("review.summary.auto", { kind: k });
  }
}

function Queue({
  queue,
}: {
  queue: NonNullable<ReturnType<typeof queuePosition>>;
}) {
  const t = useT(CATALOGS);
  const step = (
    slug: string | null,
    label: string,
    Icon: typeof ChevronLeft
  ) =>
    slug ? (
      <Link
        href={packageUpdateHref(slug)}
        aria-label={label}
        title={label}
        className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/70 ring-1 ring-inset ring-foreground/10 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Icon aria-hidden className="h-4 w-4" />
      </Link>
    ) : (
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/25 ring-1 ring-inset ring-foreground/[0.06]"
      >
        <Icon className="h-4 w-4" />
      </span>
    );
  return (
    <div className="flex items-center gap-1.5 text-[12.5px] tabular-nums text-foreground/65">
      <span>
        {t("review.queue", { index: queue.index, total: queue.total })}
      </span>
      {step(queue.previous, t("review.previous"), ChevronLeft)}
      {step(queue.next, t("review.next"), ChevronRight)}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-2 rounded-lg px-4 py-3 text-[13px] ring-1 ring-inset ${
        tone === "warning"
          ? "bg-status-stale/10 ring-status-stale/30"
          : "bg-status-down/10 ring-status-down/30"
      }`}
    >
      <CircleAlert
        aria-hidden
        className={`h-4 w-4 shrink-0 ${tone === "warning" ? "text-status-stale" : "text-status-down"}`}
      />
      {children}
    </div>
  );
}

/**
 * The decision bar, pinned to the window's bottom like a proposal's: what
 * applying does in one line, "Stop updates" and "Not now" quiet, and ONE
 * named primary ("Update skill", or "Keep mine" when nothing would change).
 */
function DecisionBar({
  plan,
  decision,
  failed,
  busy,
  onApply,
  onStop,
}: {
  plan: PackageUpdatePlan;
  decision: Decision;
  failed: boolean;
  busy: boolean;
  onApply: () => void;
  onStop: () => void;
}) {
  const t = useT(CATALOGS);
  const blocked = decision.blocked !== null;
  const line =
    decision.blocked === "choices"
      ? t("bar.missing", {
          n: decision.missing.length,
          fields: decision.missing.join(", "),
        })
      : decision.blocked === "version"
        ? t("bar.version")
        : [
            decision.primary === "keep"
              ? t("bar.nothing")
              : t("bar.update", { changing: decision.changing }),
            decision.primary === "update" && decision.keeping > 0
              ? t("bar.keep", { keeping: decision.keeping })
              : null,
            decision.recordsSkipped > 0
              ? t("bar.withoutRecords", { n: decision.recordsSkipped })
              : null,
          ]
            .filter(Boolean)
            .join(" · ");
  const primaryLabel =
    decision.primary === "keep"
      ? t("bar.keepMine")
      : t("bar.primary", { kind: catalogKindLabel(plan.kind).toLowerCase() });

  return (
    <div
      data-review-decision=""
      className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-foreground/[0.06] bg-background px-4 py-3 sm:-mx-6 sm:px-6"
    >
      {failed && (
        <p role="alert" className="text-[12.5px] text-status-down">
          {t("apply.failed")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <p
          aria-live="polite"
          className="min-w-0 flex-1 basis-full text-[12.5px] text-foreground/80 sm:basis-auto"
        >
          {line}
        </p>
        <Button
          size="sm"
          variant="light"
          radius="md"
          isDisabled={busy}
          onPress={onStop}
        >
          {t("bar.stop")}
        </Button>
        <Button
          as={Link}
          href={UPDATES_HREF}
          size="sm"
          variant="flat"
          radius="md"
        >
          {t("bar.notNow")}
        </Button>
        <Button
          size="sm"
          color="primary"
          radius="md"
          isDisabled={blocked || busy}
          isLoading={busy}
          onPress={onApply}
        >
          {busy ? t("bar.applying") : primaryLabel}
        </Button>
      </div>
    </div>
  );
}

/** After the decision: what happened, Undo, and where to go next. */
function Receipt({
  plan,
  outcome,
  next,
}: {
  plan: PackageUpdatePlan;
  outcome: Extract<Outcome, { kind: "receipt" } | { kind: "stopped" }>;
  next: string | null;
}) {
  const t = useT(CATALOGS);
  const undo = useUndoPackageUpdate();
  const [undone, setUndone] = useState<
    "undone" | "proposed" | "conflict" | "expired" | "failed" | null
  >(null);

  const nextDoor = next ? (
    <Button
      as={Link}
      href={packageUpdateHref(next)}
      size="sm"
      color="primary"
      radius="md"
    >
      {t("receipt.next")}
    </Button>
  ) : (
    <Button as={Link} href={UPDATES_HREF} size="sm" color="primary" radius="md">
      {t("receipt.all")}
    </Button>
  );

  let headline: string;
  let detail: string | null = null;
  let undoable: string | null = null;
  let request: string | null = null;
  if (outcome.kind === "stopped") {
    headline = t("stop.done", { name: plan.name });
  } else if (outcome.result.status === "proposed") {
    headline = t("receipt.proposed");
    // One request opens itself; several (one per row) are in Requests.
    const ids = outcome.result.proposalIds;
    request =
      ids.length === 1
        ? `/proposal/${encodeURIComponent(ids[0]!)}`
        : navHref("review");
  } else {
    const r = outcome.result.receipt;
    const changed = [
      ...new Set((r?.changes ?? []).map((c) => packageFieldLabel(c.field))),
    ];
    headline = t("receipt.applied", {
      name: plan.name,
      version: r?.toVersion ?? plan.latestVersion ?? "",
    });
    detail =
      outcome.changedNothing || changed.length === 0
        ? t("receipt.nothing")
        : t("receipt.changed", { fields: changed.join(", ") });
    undoable = r && changed.length > 0 ? r.id : null;
  }

  async function onUndo(receiptId: string) {
    try {
      const res = await undo.mutateAsync({ receiptId });
      setUndone(res.status === "proposed" ? "proposed" : "undone");
    } catch (err) {
      const failure = updateFailureOf(err);
      setUndone(
        failure === "conflict" || failure === "expired" ? failure : "failed"
      );
    }
  }

  return (
    <section
      role="status"
      className="flex flex-col gap-2 rounded-lg bg-foreground/[0.02] p-4 ring-1 ring-inset ring-foreground/10"
    >
      <p className="text-[15px] font-medium text-foreground">{headline}</p>
      {detail && <p className="text-[13px] text-foreground/75">{detail}</p>}
      {undone && (
        <p
          className={`text-[13px] ${undone === "undone" || undone === "proposed" ? "text-foreground/75" : "text-status-down"}`}
        >
          {undone === "undone"
            ? t("receipt.undone", { name: plan.name })
            : undone === "proposed"
              ? t("receipt.proposed")
              : undone === "conflict"
                ? t("receipt.undoChanged")
                : undone === "expired"
                  ? t("receipt.undoExpired")
                  : t("receipt.undoFailed")}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {nextDoor}
        {request && (
          <Button as={Link} href={request} size="sm" variant="flat" radius="md">
            {t("receipt.openRequest")}
          </Button>
        )}
        {undoable && undone !== "undone" && undone !== "proposed" && (
          <Button
            size="sm"
            variant="flat"
            radius="md"
            isLoading={undo.isPending}
            onPress={() => void onUndo(undoable)}
          >
            {undo.isPending ? t("receipt.undoing") : t("receipt.undo")}
          </Button>
        )}
      </div>
    </section>
  );
}
