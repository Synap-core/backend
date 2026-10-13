"use client";

/**
 * Marketplace › Catalog — browse what this pod can install.
 *
 * The catalog is the POD's: `marketplace.list` reads the catalog the pod keeps
 * in sync with its sources (every 10 minutes), so browsing never waits on a
 * source and a source being down shows the last synced copy, not an error —
 * and never a sign-in page. A pod with no source says so plainly.
 *
 * Deliberately absent, and not an oversight:
 *   • No "Verified" badge. `isVerified` is set by domain registration on the
 *     CP, so it certifies a DNS record, not a package — a typosquat has
 *     already earned one. Rendering it here would launder that into trust.
 *   • No ranking or sorting by install count. Popularity is not a quality
 *     signal and it entrenches whatever installed first.
 *
 * Progressive disclosure: this page answers "what exists"; `[slug]` answers
 * "what is it, and what will it do to my pod" before anything is written.
 */

import { Chip, Input, Spinner } from "@heroui/react";
import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { readableDescription } from "../../../../lib/marketplace";
import {
  ResourceRowEmpty,
  ResourceRowError,
} from "../../components/resource-row";
import { FilterChips } from "../../components/filter-chips";
import { kindIcon } from "../../../_lib/object/kind-icon";
import {
  catalogDetailHref,
  catalogFreshness,
  catalogKindLabel,
} from "./catalog-model";
import type { CatalogEntry } from "./types";

const PAGE_SIZE = 60;
/** The chip that clears the kind filter (not a catalog kind). */
const ALL = "all";

export function CatalogTab() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<CatalogEntry["kind"] | null>(null);

  // Debounce the search box — each keystroke otherwise re-ranks the catalog.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const catalog = trpc.marketplace.list.useQuery(
    {
      query: debounced || undefined,
      kind: kind ?? undefined,
      limit: PAGE_SIZE,
    },
    {
      // Keep the last page on screen while the next filter loads.
      placeholderData: (prev) => prev,
      staleTime: 60_000,
      // A catalog read that fails is shown in place; retrying a pod that just
      // said no only delays that message.
      retry: false,
    }
  );

  const page = catalog.data;
  const entries = useMemo(() => page?.entries ?? [], [page]);

  // Kind chips carry a count only when the page holds the WHOLE catalog, so a
  // number beside "Space" is a fact rather than a sample of the first page. A
  // tooltip caveat would not fix a wrong number — it is invisible to touch and
  // keyboard — so past one page there is no number at all; the footer's
  // "Showing N of total" carries the scale.
  const countsInPage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return counts;
  }, [entries]);
  const pageIsWholeCatalog = !!page && page.total <= entries.length;

  const noSource = !!page && page.sources.length === 0;
  const freshness = page ? catalogFreshness(page.sources) : null;

  return (
    <div>
      <Input
        aria-label="Search the catalog"
        placeholder="Search the catalog…"
        value={search}
        onValueChange={setSearch}
        size="sm"
        radius="sm"
        variant="bordered"
        startContent={<Search size={14} className="text-foreground/40" />}
        className="mb-3 max-w-md"
      />

      {page && (
        <FilterChips
          ariaLabel="Kind"
          active={kind ?? ALL}
          chips={[
            { key: ALL as typeof ALL | CatalogEntry["kind"], label: "All" },
            ...page.kinds.map((k) => ({
              key: k.kind,
              label: catalogKindLabel(k.objectKind),
              count:
                kind === null && !debounced && pageIsWholeCatalog
                  ? (countsInPage.get(k.kind) ?? 0)
                  : undefined,
            })),
          ]}
          // Pressing the active kind again clears it.
          onSelect={(k) => setKind(k === ALL || k === kind ? null : k)}
        />
      )}

      {catalog.isLoading && (
        <div className="flex items-center gap-2 py-10 text-[12.5px] text-foreground/65">
          <Spinner size="sm" /> Loading the catalog…
        </div>
      )}

      {catalog.error && !page && (
        <ResourceRowError
          message={`The pod couldn't read its catalog: ${catalog.error.message}`}
          onRetry={() => void catalog.refetch()}
        />
      )}

      {noSource && (
        <ResourceRowEmpty message="This pod has no catalog source, so there is nothing to browse. A pod connected to Synap lists the Synap catalog here." />
      )}

      {page && !noSource && entries.length === 0 && (
        <ResourceRowEmpty
          message={
            debounced || kind
              ? "Nothing in the catalog matches this filter."
              : (freshness ?? "The catalog is empty.")
          }
        />
      )}

      {entries.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((entry) => (
              <EntryCard
                key={`${entry.source}|${entry.kind}|${entry.slug}`}
                entry={entry}
                showSource={(page?.sources.length ?? 0) > 1}
              />
            ))}
          </div>
          {page && page.total > entries.length && (
            <p className="mt-4 text-[11.5px] text-foreground/65">
              Showing {entries.length} of {page.total}. Narrow the search to see
              the rest.
            </p>
          )}
        </>
      )}

      {freshness && entries.length > 0 && (
        <p className="mt-3 text-[11.5px] text-foreground/65">{freshness}</p>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  showSource,
}: {
  entry: CatalogEntry;
  showSource: boolean;
}) {
  const Icon = kindIcon(entry.objectKind);
  return (
    <Link
      href={catalogDetailHref(entry)}
      // Up to PAGE_SIZE cards are on screen at once, and every prefetch is a
      // full gate run in `proxy.ts` (a whoami + a role probe against the pod).
      // Prefetching them all spent ~120 pod calls per visit from ONE
      // rate-limit bucket and tipped the pod into 429s — which then read as
      // "signed out". The detail page loads its data client-side anyway, so
      // prefetch buys nothing here.
      prefetch={false}
      className="
        group flex flex-col gap-2 rounded-2xl p-4
        bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10
        transition-colors hover:bg-foreground/[0.07]
      "
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/70">
            <Icon size={14} />
          </span>
          <span className="truncate text-[13.5px] font-medium tracking-tight text-foreground">
            {entry.name}
          </span>
        </div>
        <Chip
          size="sm"
          radius="sm"
          variant="flat"
          className="shrink-0 text-[11px]"
        >
          {catalogKindLabel(entry.objectKind)}
        </Chip>
      </div>

      <p className="line-clamp-2 text-[12px] leading-relaxed text-foreground/65">
        {readableDescription(entry.description) ?? "No description."}
      </p>

      <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-1 text-[11px] text-foreground/65">
        <span className="truncate font-mono">{entry.slug}</span>
        {showSource && <span className="shrink-0">· {entry.sourceName}</span>}
      </div>
    </Link>
  );
}
