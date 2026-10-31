"use client";

/**
 * Marketplace › Updates — every installed package whose catalog version
 * moved, grouped by what the pod says it needs from the person (Collection
 * template): Needs your OK · Needs your choice · Updates on its own · Yours,
 * and the packages whose catalog could not be read ("Can't check", with why).
 * Each update is a door to its Review page. The one primary applies the
 * updates that need nothing from anyone.
 *
 * States: loading (rows in the list's shape), a failed read (Retry, never
 * "nothing waiting": a catalog nobody could read is not an up-to-date pod),
 * and nothing waiting (REASSURE, with when it was checked).
 */

import { Button } from "@heroui/react";
import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { formatRelative } from "@synap-core/types/value-format";
import { kindIcon } from "../../../../_lib/object/kind-icon";
import {
  useConsoleLocale,
  useT,
} from "../../../../../lib/i18n/locale-provider";
import {
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";
import {
  packageUpdateNeedsLabel,
  type PackageUpdateSummary,
  type PackageUpdateUnreadable,
} from "./contract";
import { en, fr } from "./copy";
import { UpdateMark } from "./update-mark";
import { groupMarkLabel, rowSecondary } from "./update-words";
import {
  UNREADABLE_MARK,
  groupMark,
  groupUpdates,
  updatesNeedingNothing,
  type UpdateGroup,
} from "./updates-model";
import {
  useApplyPackageUpdate,
  usePackageUpdateList,
} from "./use-package-updates";

const CATALOGS = { en, fr };

/** The Review page of one update. */
export function packageUpdateHref(slug: string): string {
  return `/marketplace/updates/${encodeURIComponent(slug)}`;
}

/** At most this many names in the "already match" line. */
const CURRENT_NAMES = 3;

export function UpdatesTab() {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const list = usePackageUpdateList();

  if (list.isLoading) {
    return (
      <div role="status" aria-busy="true" aria-label={t("list.loading")}>
        <ResourceRowSkeleton count={4} />
      </div>
    );
  }
  if (list.isError || !list.data) {
    return (
      <ResourceRowError
        message={t("list.failed")}
        onRetry={() => void list.refetch()}
      />
    );
  }

  const { groups, current } = groupUpdates(list.data.updates);
  const unreadable = list.data.unreadable;
  const checked = formatRelative(list.dataUpdatedAt, Date.now(), { locale });

  return (
    <div className="flex flex-col gap-6">
      <BatchApply list={list.data.updates} />

      {groups.length === 0 && unreadable.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-6 text-[13px] text-foreground/75">
          <CheckCircle2
            aria-hidden
            className="h-4 w-4 shrink-0 text-status-healthy"
          />
          {t("list.current", { when: checked })}
        </div>
      )}

      {groups.map(({ group, items }) => (
        <section key={group} aria-labelledby={`updates-${group}`}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h2
              id={`updates-${group}`}
              className="text-[14px] font-medium tracking-tight text-foreground"
            >
              {packageUpdateNeedsLabel(group)}
            </h2>
            <span className="text-[12px] text-foreground/65">
              <GroupMeta group={group} />
            </span>
          </div>
          <ul className="flex flex-col divide-y divide-foreground/[0.05] rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
            {items.map((s) => (
              <li key={s.slug}>
                <UpdateRow summary={s} group={group} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {unreadable.length > 0 && (
        <section aria-labelledby="updates-unreadable">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h2
              id="updates-unreadable"
              className="text-[14px] font-medium tracking-tight text-foreground"
            >
              {t("group.unreadable")}
            </h2>
            <span className="text-[12px] text-foreground/65">
              {t("group.unreadable.meta")}
            </span>
          </div>
          <ul className="flex flex-col divide-y divide-foreground/[0.05] rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
            {unreadable.map((u) => (
              <li key={`${u.kind}:${u.slug}`}>
                <UnreadableRow item={u} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {(groups.length > 0 || unreadable.length > 0) && current.length > 0 && (
        <p className="flex items-start gap-2 text-[12.5px] text-foreground/65">
          <CheckCircle2
            aria-hidden
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-healthy"
          />
          {t("list.currentCount", {
            n: current.length,
            names:
              current
                .slice(0, CURRENT_NAMES)
                .map((s) => s.name)
                .join(", ") + (current.length > CURRENT_NAMES ? "…" : ""),
          })}
        </p>
      )}
    </div>
  );
}

function GroupMeta({ group }: { group: UpdateGroup }) {
  const t = useT(CATALOGS);
  switch (group) {
    case "choice":
      return <>{t("group.choice.meta")}</>;
    case "consent":
      return <>{t("group.consent.meta")}</>;
    case "review":
      return <>{t("group.review.meta")}</>;
    case "nothing":
      return <>{t("group.nothing.meta")}</>;
  }
}

function UpdateRow({
  summary,
  group,
}: {
  summary: PackageUpdateSummary;
  group: UpdateGroup;
}) {
  const t = useT(CATALOGS);
  const Icon = kindIcon(summary.kind);
  return (
    <Link
      href={packageUpdateHref(summary.slug)}
      // One pod round trip per prefetch (`proxy.ts`): a long list would spend
      // the rate-limit bucket on pages nobody opens (catalog-tab.tsx).
      prefetch={false}
      className="group flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 transition-colors hover:bg-content2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
    >
      <Icon
        aria-hidden
        className="h-4 w-4 shrink-0 text-foreground/40"
        strokeWidth={2}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">
          {summary.name}
        </span>
        <span className="truncate text-[11.5px] text-foreground/65">
          {rowSecondary(t, summary)}
        </span>
      </span>
      <UpdateMark mark={groupMark(group)} label={groupMarkLabel(t, group)} />
    </Link>
  );
}

/** A package the pod could not compare: named, with the pod's reason, no door. */
function UnreadableRow({ item }: { item: PackageUpdateUnreadable }) {
  const t = useT(CATALOGS);
  const Icon = kindIcon(item.kind);
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <Icon
        aria-hidden
        className="h-4 w-4 shrink-0 text-foreground/40"
        strokeWidth={2}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">
          {item.name}
        </span>
        <span className="text-[11.5px] text-foreground/65">{item.reason}</span>
      </span>
      <UpdateMark mark={UNREADABLE_MARK} label={t("mark.unreadable")} />
    </div>
  );
}

type BatchState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | {
      kind: "done";
      applied: number;
      proposed: number;
      failed: number;
      total: number;
    };

/**
 * "Apply N updates that need nothing from you": each through the same apply
 * door as the Review page, one after the other, with no choice to send.
 * Hidden when there are none (OMIT).
 */
function BatchApply({ list }: { list: readonly PackageUpdateSummary[] }) {
  const t = useT(CATALOGS);
  const apply = useApplyPackageUpdate();
  const [state, setState] = useState<BatchState>({ kind: "idle" });
  const ready = updatesNeedingNothing(list);

  async function run() {
    const total = ready.length;
    let applied = 0;
    let proposed = 0;
    let failed = 0;
    setState({ kind: "running", done: 0, total });
    for (const [i, s] of ready.entries()) {
      try {
        if (!s.latestVersion) throw new Error("no catalog version");
        const result = await apply.mutateAsync({
          slug: s.slug,
          expectedVersion: s.latestVersion,
          choices: {},
        });
        if (result.status === "proposed") proposed += 1;
        else applied += 1;
      } catch {
        failed += 1;
      }
      setState({ kind: "running", done: i + 1, total });
    }
    setState({ kind: "done", applied, proposed, failed, total });
  }

  if (ready.length === 0 && state.kind !== "done") return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p
        role="status"
        aria-live="polite"
        className="text-[12.5px] text-foreground/70"
      >
        {state.kind === "running" &&
          t("list.applying", { done: state.done, n: state.total })}
        {state.kind === "done" &&
          (state.failed > 0
            ? t("list.appliedSome", {
                done: state.applied + state.proposed,
                n: state.total,
                failed: state.failed,
              })
            : state.proposed > 0
              ? t("list.proposedSome", { n: state.proposed })
              : t("list.applied", { n: state.applied }))}
      </p>
      {ready.length > 0 && (
        <Button
          color="primary"
          size="sm"
          radius="md"
          isLoading={state.kind === "running"}
          onPress={() => void run()}
        >
          {t("list.applyNothing", { n: ready.length })}
        </Button>
      )}
    </div>
  );
}
