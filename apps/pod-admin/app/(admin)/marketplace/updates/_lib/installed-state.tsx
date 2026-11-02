"use client";

/**
 * The package page of something installed leads with how its copy on this pod
 * stands against the catalog, with the same marks as the Updates tab (one
 * derivation, `groupUpdates`):
 *   - an update waits → its mark and "Review update" (the Review page);
 *   - yours (you edited it, the catalog did not change it) → "Compare with the
 *     catalog" and "Stop updates for this skill";
 *   - matches the catalog → one quiet line.
 * A failed read says so, with Retry; a package the list does not carry
 * (another source's, or an older pod) shows nothing (OMIT).
 */

import { Button } from "@heroui/react";
import { ChevronRight, CircleSlash } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useT } from "../../../../../lib/i18n/locale-provider";
import { ConfirmModal } from "../../../components/confirm-modal";
import { ResourceRowError } from "../../../components/resource-row";
import { catalogKindLabel } from "../../_lib/catalog-model";
import { en, fr } from "./copy";
import { UpdateMark } from "./update-mark";
import { countsLine, groupMarkLabel } from "./update-words";
import { groupMark, updateGroupOf } from "./updates-model";
import { packageUpdateHref } from "./updates-tab";
import {
  useDetachPackage,
  usePackageUpdateList,
  usePackageUpdatePlan,
} from "./use-package-updates";

const CATALOGS = { en, fr };

export function InstalledState({ slug }: { slug: string }) {
  const t = useT(CATALOGS);
  const list = usePackageUpdateList();
  const summary = list.data?.updates.find((s) => s.slug === slug);
  const group = summary ? updateGroupOf(summary) : null;
  // "Stop updates" detaches every installed row: they are in the plan.
  const plan = usePackageUpdatePlan(slug, { enabled: group === "nothing" });
  const detach = useDetachPackage();
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState<"done" | "failed" | null>(null);

  if (list.isLoading) {
    return (
      <div className="h-14 rounded-lg bg-foreground/[0.04] shimmer-pulse" />
    );
  }
  if (list.isError || !list.data) {
    return (
      <ResourceRowError
        message={t("installed.failed")}
        onRetry={() => void list.refetch()}
      />
    );
  }
  if (!summary || !group) return null;

  const kind = catalogKindLabel(summary.kind).toLowerCase();
  const counts = countsLine(t, summary);

  async function onStop() {
    try {
      await detach.mutateAsync(plan.data?.rows ?? []);
      setStopped("done");
    } catch {
      setStopped("failed");
    }
    setStopping(false);
  }

  return (
    <section
      aria-label={t("installed.title")}
      className="flex flex-col gap-3 rounded-lg bg-foreground/[0.02] p-4 ring-1 ring-inset ring-foreground/10"
    >
      <div className="flex flex-wrap items-center gap-2">
        <UpdateMark mark={groupMark(group)} label={groupMarkLabel(t, group)} />
        {group === "current" ? (
          <span className="text-[12.5px] text-foreground/65">
            {t("installed.current")}
          </span>
        ) : (
          counts && (
            <span className="text-[12.5px] text-foreground/65">{counts}</span>
          )
        )}
        {group !== "current" && group !== "nothing" && (
          <Button
            as={Link}
            href={packageUpdateHref(slug)}
            size="sm"
            color="primary"
            radius="md"
            className="sm:ml-auto"
          >
            {t("installed.update")}
          </Button>
        )}
      </div>

      {group === "nothing" && stopped !== "done" && (
        <ul className="flex flex-col divide-y divide-foreground/[0.05]">
          <li>
            <Link
              href={packageUpdateHref(slug)}
              className="flex min-h-11 items-center gap-2 rounded-sm text-[13px] text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <span className="flex-1">{t("installed.compare")}</span>
              <ChevronRight
                aria-hidden
                className="h-4 w-4 text-foreground/40"
              />
            </Link>
          </li>
          <li>
            <Button
              variant="light"
              radius="sm"
              fullWidth
              isDisabled={!plan.data}
              onPress={() => setStopping(true)}
              className="h-auto min-h-11 justify-start gap-2 px-0 text-left text-[13px] text-foreground data-[hover=true]:bg-transparent data-[hover=true]:text-primary"
            >
              <CircleSlash
                aria-hidden
                className="h-4 w-4 shrink-0 text-foreground/50"
              />
              <span className="flex flex-1 flex-col">
                <span>{t("installed.stop", { kind })}</span>
                <span className="text-[12px] text-foreground/60">
                  {t("installed.stop.hint")}
                </span>
              </span>
            </Button>
          </li>
        </ul>
      )}

      {stopped && (
        <p
          role="status"
          className={`text-[12.5px] ${stopped === "failed" ? "text-status-down" : "text-foreground/75"}`}
        >
          {stopped === "done"
            ? t("stop.done", { name: summary.name })
            : t("stop.failed")}
        </p>
      )}

      <ConfirmModal
        isOpen={stopping}
        onClose={() => setStopping(false)}
        onConfirm={() => void onStop()}
        title={t("stop.title", { name: summary.name })}
        consequence={t("stop.body")}
        confirmLabel={t("stop.confirm")}
        confirmColor="warning"
        isPending={detach.isPending}
      />
    </section>
  );
}

/** The sentence before Install: what happens when the catalog changes it. */
export function UpdatePromise() {
  const t = useT(CATALOGS);
  return (
    <p className="text-[12.5px] leading-relaxed text-foreground/65">
      {t("installed.promise")}
    </p>
  );
}
