"use client";

/**
 * Marketplace › Installed — every capability installed on the pod, where it
 * lives, whether its verbs are turned on, how its parts are wired, and how
 * its runs are going. Shaping in `installed-model.ts`.
 *
 * Nothing is approved here, on purpose (D5): the container's `approved` flag
 * gates no run, so the one act is to turn its verbs on — in the Tools tab,
 * focused on this capability. `?focus=<capabilityId>` highlights a row.
 */

import { Button } from "@heroui/react";
import Link from "next/link";
import { useEffect, useMemo } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { navHref } from "../../../../lib/console-nav";
import { formatRelative } from "../../../../lib/format";
import { kindIcon } from "../../../_lib/object/kind-icon";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { useFocusRow } from "../../components/use-focus-row";
import { installedRows, type InstalledRow } from "./installed-model";

const CapabilityIcon = kindIcon("capability");

/** Shared with the Tools tab: one cached catalog read for both. */
export const CATALOG_INPUT = {} as const;
export const CAPABILITY_READ_OPTIONS = { staleTime: 30_000 } as const;

export function InstalledTab() {
  const compositions = trpc.capabilities.compositions.useQuery(
    undefined,
    CAPABILITY_READ_OPTIONS
  );
  // Verb counts only — a failed catalog read leaves them unknown, never 0.
  const catalog = trpc.capabilities.catalog.useQuery(
    CATALOG_INPUT,
    CAPABILITY_READ_OPTIONS
  );

  useEffect(() => {
    if (compositions.error) redirectToLoginIfUnauthorized(compositions.error);
  }, [compositions.error]);
  useFocusRow({ ready: !compositions.isLoading });

  const rows = useMemo(
    () =>
      installedRows(
        compositions.data ?? [],
        catalog.isSuccess ? catalog.data : null
      ),
    [compositions.data, catalog.isSuccess, catalog.data]
  );

  return (
    <section className="rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
      {compositions.isLoading ? (
        <ResourceRowSkeleton count={4} />
      ) : compositions.isError ? (
        <ResourceRowError
          message="Couldn't load what is installed."
          onRetry={() => void compositions.refetch()}
        />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty message="Nothing is installed yet. Browse the Catalog to add a capability." />
      ) : (
        rows.map((row) => <InstalledRowView key={row.id} row={row} />)
      )}
    </section>
  );
}

function secondaryLine(row: InstalledRow): string {
  return [
    row.where,
    row.verbsOff !== null && row.verbsTotal > 0
      ? `${row.verbsOn} of ${row.verbsTotal} verbs on`
      : null,
    row.members > 0 ? `${row.wired} of ${row.members} parts wired` : null,
    row.lastRunAt ? `last ran ${formatRelative(row.lastRunAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function InstalledRowView({ row }: { row: InstalledRow }) {
  return (
    <div
      data-row-id={row.id}
      className="rounded-md border-b border-foreground/[0.05] last:border-b-0"
    >
      <ResourceRow
        Icon={CapabilityIcon}
        primary={row.name}
        secondary={secondaryLine(row)}
        status={row.pill}
        wrap
        actions={
          row.verbsOff !== null && row.verbsOff > 0 ? (
            <Button
              as={Link}
              href={navHref("marketplace", { tab: "tools", focus: row.id })}
              size="sm"
              variant="flat"
              radius="md"
              aria-label={`Turn on ${row.name}'s verbs`}
            >
              Turn on
            </Button>
          ) : undefined
        }
      />
      {row.gapsLine && (
        <p className="px-3 pb-2 pl-10 text-[12px] text-foreground/65">
          {row.gapsLine}
        </p>
      )}
    </div>
  );
}
