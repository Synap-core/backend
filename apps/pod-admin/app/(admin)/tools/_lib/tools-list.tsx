"use client";

/**
 * Tools — the one list (contract a0f787b7): a search box, type chips with
 * counts (`?type=`), a list / gallery switch (`?view=`, kept per viewer), and
 * every row opens its tool's page. Shaping and every rule in `tools-model.ts`;
 * the one status mark in `tool-status.ts`.
 *
 * Four reads, all user-floored: `capabilities.compositions` (the installed
 * capabilities and their run health), `capabilities.catalog` (their state and
 * actions), `skills.list` in every space (instructions and code, drained in
 * `useAllSkills`), and `workspaces.list` (space names). The list waits for all
 * of them to answer or fail; a failed read says so above the list and its
 * tools are absent, never shown as "none".
 */

import { Chip, Input } from "@heroui/react";
import { LayoutGrid, List, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { navHref } from "../../../../lib/console-nav";
import { readableDescription } from "../../../../lib/marketplace";
import { useReplaceParams } from "../../../../lib/use-replace-params";
import { useT } from "../../../../lib/i18n/locale-provider";
import { kindIcon } from "../../../_lib/object/kind-icon";
import { FilterChips } from "../../components/filter-chips";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { StatusPill } from "../../components/status-pill";
import { TOOLS_CATALOGS } from "./copy";
import type { CardLike, CompositionLike } from "./installed-model";
import {
  CAPABILITY_READ_OPTIONS,
  CATALOG_INPUT,
  filterTools,
  initialToolsView,
  storeToolsView,
  toolCounts,
  toolFilterOf,
  toolItems,
  toolSecondary,
  toolWhere,
  type SkillLike,
  type ToolFilter,
  type ToolItem,
  type ToolsView,
} from "./tools-model";
import { useAllSkills } from "./use-all-skills";

const CapabilityIcon = kindIcon("capability");
const SkillIcon = kindIcon("skill");

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function ToolsList() {
  const t = useT(TOOLS_CATALOGS);
  const router = useRouter();
  const params = useSearchParams();
  const replaceParams = useReplaceParams();
  const filter = toolFilterOf(params.get("type"));
  const [view, setView] = useState<ToolsView>(() =>
    initialToolsView(params.get("view"), browserStorage())
  );
  const [search, setSearch] = useState("");

  const compositions = trpc.capabilities.compositions.useQuery(
    undefined,
    CAPABILITY_READ_OPTIONS
  );
  const catalog = trpc.capabilities.catalog.useQuery(
    CATALOG_INPUT,
    CAPABILITY_READ_OPTIONS
  );
  const skills = useAllSkills();
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    const err = compositions.error ?? catalog.error ?? skills.error;
    if (err) redirectToLoginIfUnauthorized(err);
  }, [compositions.error, catalog.error, skills.error]);

  const settled =
    !compositions.isLoading && !catalog.isLoading && !skills.isLoading;
  const items = useMemo(
    () =>
      toolItems({
        compositions: compositions.isSuccess
          ? (compositions.data as readonly CompositionLike[])
          : null,
        cards: catalog.isSuccess ? (catalog.data as readonly CardLike[]) : null,
        skills: skills.skills as readonly SkillLike[] | null,
      }),
    [
      compositions.isSuccess,
      compositions.data,
      catalog.isSuccess,
      catalog.data,
      skills.skills,
    ]
  );
  const query = search.trim();
  const shown = useMemo(
    () => filterTools(items, filter, query),
    [items, filter, query]
  );
  const counts = useMemo(() => toolCounts(items, query), [items, query]);

  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string) => byId.get(id);
  }, [spaces.data]);

  // A count is a fact only when the read behind it answered.
  const capsKnown = compositions.isSuccess;
  const skillsKnown = !skills.isError && skills.skills !== null;
  const skillCount = (n: number) => (skills.capped ? `${n}+` : n);
  const chips: Array<{
    key: ToolFilter;
    label: string;
    count?: number | string;
  }> = [
    {
      key: "all",
      label: t("type.all"),
      count:
        settled && capsKnown && skillsKnown
          ? skillCount(counts.all)
          : undefined,
    },
    {
      key: "capabilities",
      label: t("type.capabilities"),
      count: settled && capsKnown ? counts.capabilities : undefined,
    },
    {
      key: "instructions",
      label: t("type.instructions"),
      count:
        settled && skillsKnown ? skillCount(counts.instructions) : undefined,
    },
    {
      key: "code",
      label: t("type.code"),
      count: settled && skillsKnown ? skillCount(counts.code) : undefined,
    },
  ];

  const chooseView = (next: ToolsView) => {
    setView(next);
    storeToolsView(next, browserStorage());
    replaceParams((p) => {
      if (next === "list") p.delete("view");
      else p.set("view", next);
    });
  };

  const bothFailed = compositions.isError && skills.isError;
  const emptyMessage =
    items.length === 0 ? (
      <>
        {t("empty.none")}{" "}
        <Link
          href={navHref("marketplace")}
          className="rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {t("empty.browse")}
        </Link>
      </>
    ) : query ? (
      t("empty.search", { query })
    ) : (
      t("empty.type")
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label={t("search.aria")}
          placeholder={t("search.placeholder")}
          value={search}
          onValueChange={setSearch}
          size="sm"
          radius="md"
          variant="bordered"
          startContent={<Search size={14} className="text-foreground/40" />}
          className="max-w-md flex-1"
        />
        <ViewSwitch view={view} onChange={chooseView} />
      </div>

      <FilterChips
        param="type"
        defaultKey="all"
        active={filter}
        chips={chips}
        ariaLabel={t("type.aria")}
        className="mb-1"
      />

      {compositions.isError && (
        <ResourceRowError
          message={t("failed.capabilities")}
          onRetry={() => void compositions.refetch()}
        />
      )}
      {skills.isError && (
        <ResourceRowError
          message={t("failed.skills")}
          onRetry={skills.refetch}
        />
      )}
      {catalog.isError && compositions.isSuccess && (
        <p className="text-[12px] text-status-stale" role="status">
          {t("failed.catalog")}
        </p>
      )}

      {!settled ? (
        <ResourceRowSkeleton count={5} />
      ) : bothFailed ? null : shown.length === 0 ? (
        <ResourceRowEmpty message={emptyMessage} />
      ) : view === "gallery" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((item) => (
            <ToolCard
              key={item.key}
              item={item}
              where={toolWhere(item, spaceName)}
            />
          ))}
        </div>
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {shown.map((item) => (
            <ResourceRow
              key={item.key}
              Icon={item.type === "capability" ? CapabilityIcon : SkillIcon}
              primary={item.name}
              secondary={toolSecondary(item, toolWhere(item, spaceName))}
              status={item.status}
              onSelect={() => router.push(item.href)}
              wrap
            />
          ))}
        </div>
      )}

      {settled && skills.capped && (
        <p className="text-[11.5px] text-foreground/65">
          {t("skills.capped", { n: skills.shown })}
        </p>
      )}
    </div>
  );
}

function ViewSwitch({
  view,
  onChange,
}: {
  view: ToolsView;
  onChange: (v: ToolsView) => void;
}) {
  const t = useT(TOOLS_CATALOGS);
  const options = [
    { key: "list" as const, label: t("view.list"), Icon: List },
    { key: "gallery" as const, label: t("view.gallery"), Icon: LayoutGrid },
  ];
  return (
    <div
      role="group"
      aria-label={t("view.aria")}
      className="inline-flex items-center gap-0.5 rounded-md bg-foreground/[0.04] p-0.5 ring-1 ring-inset ring-foreground/10"
    >
      {options.map(({ key, label, Icon }) => {
        const pressed = key === view;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={pressed}
            aria-label={label}
            title={label}
            onClick={() => onChange(key)}
            className={[
              "inline-flex h-7 w-8 items-center justify-center rounded-[5px] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              pressed
                ? "bg-foreground/[0.08] text-foreground"
                : "text-foreground/55 hover:text-foreground",
            ].join(" ")}
          >
            <Icon size={14} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

function ToolCard({ item, where }: { item: ToolItem; where: string }) {
  const t = useT(TOOLS_CATALOGS);
  const Icon = item.type === "capability" ? CapabilityIcon : SkillIcon;
  const chip =
    item.type === "capability"
      ? t("chip.capability")
      : item.type === "instruction"
        ? t("chip.instruction")
        : t("chip.code");
  return (
    <Link
      href={item.href}
      // Many cards at once, and every prefetch is a gate run in `proxy.ts`
      // (the catalog tab's lesson): the tool page reads client-side anyway.
      prefetch={false}
      className="
        group flex flex-col gap-2 rounded-2xl p-4
        bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10
        transition-colors hover:bg-foreground/[0.07]
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
      "
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/70">
            <Icon size={14} aria-hidden />
          </span>
          <span className="truncate text-[13.5px] font-medium tracking-tight text-foreground">
            {item.name}
          </span>
        </div>
        <Chip
          size="sm"
          radius="sm"
          variant="flat"
          className="shrink-0 text-[11px]"
        >
          {chip}
        </Chip>
      </div>
      <p className="line-clamp-2 text-[12px] leading-relaxed text-foreground/65">
        {readableDescription(item.description) ?? t("card.noDescription")}
      </p>
      <div className="mt-auto flex min-w-0 items-center gap-2 pt-1 text-[11px] text-foreground/65">
        <StatusPill kind={item.status.kind} label={item.status.label} />
        <span className="truncate">{where}</span>
      </div>
    </Link>
  );
}
