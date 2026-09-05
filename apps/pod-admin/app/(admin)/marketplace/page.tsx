"use client";

/**
 * Marketplace — browse the Synap catalog and install a package onto this pod.
 *
 * ONE catalog: the Control Plane's `synap_packages`, read through this app's
 * `/api/marketplace/packages` proxy. Pod Admin adds no second registry.
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

import { Button, Chip, Input, Spinner } from "@heroui/react";
import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  PACKAGE_KINDS,
  type CatalogPage,
  type CatalogPackage,
} from "../../../lib/marketplace";
import { ResourceRowEmpty, ResourceRowError } from "../components/resource-row";
import { kindIcon, kindLabel } from "./_lib/kind-icon";

const PAGE_SIZE = 60;

export default function MarketplacePage() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry — a state value the effect depends on, so retrying after a
  // network failure actually re-runs the fetch (re-setting `debounced` to the
  // same string would not).
  const [reloadNonce, setReloadNonce] = useState(0);

  // Debounce the search box — each keystroke otherwise runs an ILIKE across
  // the whole catalog on the CP.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (debounced) query.set("search", debounced);
    if (kind) query.set("category", kind);

    fetch(`/api/marketplace/packages?${query}`, { credentials: "include" })
      .then(async (res) => {
        const body = (await res.json()) as CatalogPage & { error?: string };
        if (!res.ok)
          throw new Error(body.error ?? `Catalog error ${res.status}`);
        return body;
      })
      .then((body) => {
        if (!cancelled) setPage(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPage(null);
          setError(err instanceof Error ? err.message : "Catalog unavailable");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debounced, kind, reloadNonce]);

  const packages = page?.packages ?? [];

  // Kind chips carry their catalog count so an empty filter is visible BEFORE
  // it is clicked. Counts are for the current result set, hence the label.
  const countsInPage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of packages)
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return counts;
  }, [packages]);

  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-5 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Marketplace
        </h1>
        <p className="text-[12.5px] text-foreground/55">
          Workspaces, capabilities and cards published to the Synap catalog.
          Installing shows you what it will do to this pod first.
        </p>
      </header>

      <div className="mb-4 flex flex-col gap-3">
        <Input
          aria-label="Search the catalog"
          placeholder="Search packages…"
          value={search}
          onValueChange={setSearch}
          size="sm"
          radius="sm"
          variant="bordered"
          startContent={<Search size={14} className="text-foreground/40" />}
          className="max-w-md"
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            label="All"
            active={kind === null}
            onPress={() => setKind(null)}
          />
          {PACKAGE_KINDS.map((k) => (
            <FilterChip
              key={k}
              label={kindLabel(k)}
              count={kind === null ? countsInPage.get(k) : undefined}
              active={kind === k}
              onPress={() => setKind(kind === k ? null : k)}
            />
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-10 text-[12.5px] text-foreground/55">
          <Spinner size="sm" /> Loading the catalog…
        </div>
      )}

      {!loading && error && (
        <ResourceRowError
          message={error}
          onRetry={() => setReloadNonce((n) => n + 1)}
        />
      )}

      {!loading && !error && packages.length === 0 && (
        <ResourceRowEmpty
          message={
            debounced || kind
              ? "No packages match this filter."
              : "The catalog is empty."
          }
        />
      )}

      {!loading && !error && packages.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {packages.map((pkg) => (
              <PackageCard key={pkg.id} pkg={pkg} />
            ))}
          </div>
          {page && page.total > packages.length && (
            <p className="mt-4 text-[11.5px] text-foreground/45">
              Showing {packages.length} of {page.total}. Narrow the search to
              see the rest.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      size="sm"
      radius="sm"
      variant={active ? "flat" : "light"}
      onPress={onPress}
      className={[
        "h-7 min-w-0 px-2.5 text-[12px] font-medium",
        active
          ? "bg-foreground/[0.09] text-foreground"
          : "text-foreground/55 hover:text-foreground",
      ].join(" ")}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1 text-foreground/40 tabular-nums">{count}</span>
      )}
    </Button>
  );
}

function PackageCard({ pkg }: { pkg: CatalogPackage }) {
  const Icon = kindIcon(pkg.category);
  return (
    <Link
      href={`/marketplace/${encodeURIComponent(pkg.slug)}`}
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
            {pkg.displayName}
          </span>
        </div>
        <Chip
          size="sm"
          radius="sm"
          variant="flat"
          className="shrink-0 text-[11px]"
        >
          {kindLabel(pkg.category)}
        </Chip>
      </div>

      <p className="line-clamp-2 text-[12px] leading-relaxed text-foreground/60">
        {pkg.description ?? "No description."}
      </p>

      <div className="mt-auto flex items-center gap-1.5 pt-1 text-[11px] text-foreground/40">
        <span className="font-mono">{pkg.slug}</span>
        {pkg.domain && <span>· {pkg.domain}</span>}
      </div>
    </Link>
  );
}
