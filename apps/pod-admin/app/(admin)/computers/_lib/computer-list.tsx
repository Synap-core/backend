"use client";

/**
 * The computers list — ONE implementation for `/computers` (every member's,
 * pod admin, with an Owner column) and `/my-computers` (the person's own).
 * The page supplies the rows and what the viewer may see; this draws the
 * filter chips (`?status=`), the expired-key callout, and the rows (the
 * shared `ResponsiveTable`: a table from `md` up, stacked rows on a phone),
 * and receives `?focus=<id>`.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Laptop } from "lucide-react";
import type { ReactNode } from "react";
import { formatRelative } from "../../../../lib/format";
import { CommandLine } from "../../../_lib/command-line";
import { FilterChips } from "../../components/filter-chips";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import {
  ResponsiveTable,
  type TableColumn,
} from "../../components/responsive-table";
import { SectionCard } from "../../components/section-card";
import { StatusPill } from "../../components/status-pill";
import { useFocusRow } from "../../components/use-focus-row";
import {
  COMPUTER_FILTERS,
  CONNECT_COMMAND,
  RECONNECT_COMMAND,
  agentsPhrase,
  computerCounts,
  computerFilterOf,
  computerMatches,
  expiredLine,
  keyStatus,
  ownerWords,
  platformLabel,
  rosterLine,
  type ComputerFilter,
  type ComputerLike,
} from "./computer-model";

/** The list's filter lives in `?status=`; All is the bare URL. */
const FILTER_PARAM = "status";
/** Agent names shown on a row before "+N". */
const AGENT_CHIPS = 3;

export interface ComputerListProps {
  computers: readonly ComputerLike[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Where one computer opens (`/computers/<id>` or `/my-computers/<id>`). */
  hrefFor: (id: string) => string;
  /** Show whose computer each row is (the admin's view of every member's). */
  showOwner: boolean;
  viewerId: string | null;
}

export function ComputerList({
  computers,
  isLoading,
  isError,
  onRetry,
  hrefFor,
  showOwner,
  viewerId,
}: ComputerListProps) {
  const params = useSearchParams();
  const filter = computerFilterOf(params.get(FILTER_PARAM));
  useFocusRow({ ready: !isLoading && !!computers });

  const all = computers ?? [];
  const counts = computerCounts(all);
  const visible = all.filter((c) => computerMatches(filter, c));
  const expired = expiredLine(all);
  const ready = !isLoading && !isError;

  return (
    <>
      <FilterChips<ComputerFilter>
        param={FILTER_PARAM}
        defaultKey="all"
        active={filter}
        ariaLabel="Filter computers by key"
        chips={COMPUTER_FILTERS.map((f) => ({
          key: f.key,
          label: f.label,
          count: ready ? counts[f.key] : undefined,
        }))}
      />

      {ready && expired && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg bg-status-down/[0.06] px-3 py-2.5 ring-1 ring-inset ring-status-down/25">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-[12.5px] font-medium text-foreground">
              {expired}
            </p>
            {filter !== "expired" && (
              <Link
                href={`?${FILTER_PARAM}=expired`}
                scroll={false}
                className="rounded-sm text-[12.5px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Show them
              </Link>
            )}
          </div>
          <p className="text-[12.5px] leading-relaxed text-foreground/65">
            Its agents can&apos;t reach the pod until it has a fresh key. Run
            this on that computer:
          </p>
          <CommandLine command={RECONNECT_COMMAND} />
        </div>
      )}

      <SectionCard
        title={COMPUTER_FILTERS.find((f) => f.key === filter)!.label}
        hint={ready && all.length > 0 ? rosterLine(all) : undefined}
      >
        {isLoading ? (
          <ResourceRowSkeleton count={3} />
        ) : isError ? (
          <ResourceRowError
            message="Couldn't load computers."
            onRetry={onRetry}
          />
        ) : visible.length === 0 ? (
          <ResourceRowEmpty message={emptyMessage(filter, all.length)} />
        ) : (
          <ResponsiveTable
            ariaLabel="Computers"
            rows={visible}
            rowKey={(c) => c.id}
            rowId={(c) => c.id}
            href={(c) => hrefFor(c.id)}
            name={{
              header: "Computer",
              width: "minmax(0,2fr)",
              label: (c) => c.name,
              sub: (c) =>
                c.hostname ? (
                  <span className="font-mono">{c.hostname}</span>
                ) : null,
            }}
            columns={columns(showOwner, viewerId)}
            phone={(c) => ({
              Icon: Laptop,
              secondary: [
                c.hostname,
                platformLabel(c.platform),
                showOwner ? ownerWords(c, viewerId) : null,
                `seen ${formatRelative(c.lastSeenAt, { empty: "never" })}`,
                agentsPhrase(c.agents.length),
              ]
                .filter(Boolean)
                .join(" · "),
              status: keyStatus(c.key),
            })}
          />
        )}
      </SectionCard>
    </>
  );
}

function emptyMessage(filter: ComputerFilter, total: number): ReactNode {
  if (total === 0)
    return (
      <>
        A computer appears here the first time an agent connects from it. To add
        one, run <code className="font-mono">{CONNECT_COMMAND}</code> on that
        machine.
      </>
    );
  switch (filter) {
    case "active":
      return "No computer has a key that is good for more than a week.";
    case "expiring":
      return "No key is about to expire.";
    case "expired":
      return "No computer's key has expired.";
    case "revoked":
      return "No computer has been revoked.";
    default:
      return "Nothing here.";
  }
}

/** The table's columns after the name; Owner only on the admin's view. */
function columns(
  showOwner: boolean,
  viewerId: string | null
): TableColumn<ComputerLike>[] {
  return [
    {
      header: "Platform",
      width: "minmax(0,0.8fr)",
      cell: (c) => platformLabel(c.platform) ?? "—",
    },
    ...(showOwner
      ? [
          {
            header: "Owner",
            width: "minmax(0,0.9fr)",
            cell: (c: ComputerLike) => {
              const owner = ownerWords(c, viewerId);
              return owner ? capitalize(owner) : "Unknown";
            },
          },
        ]
      : []),
    {
      header: "Last seen",
      width: "minmax(0,0.9fr)",
      cell: (c) => formatRelative(c.lastSeenAt, { empty: "never" }),
    },
    {
      header: "Key",
      width: "minmax(0,1.1fr)",
      className: "min-w-0",
      cell: (c) => <StatusPill {...keyStatus(c.key)} />,
    },
    {
      header: "Agents",
      width: "minmax(0,1.8fr)",
      className: "flex min-w-0 flex-wrap gap-1",
      cell: (c) => (
        <>
          <span className="text-foreground/65">
            {agentsPhrase(c.agents.length)}
          </span>
          {c.agents.slice(0, AGENT_CHIPS).map((a) => (
            <span
              key={a.id}
              className="max-w-[9rem] truncate rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[11.5px] text-foreground/80"
            >
              {a.name}
            </span>
          ))}
          {c.agents.length > AGENT_CHIPS && (
            <span className="text-[11.5px] text-foreground/65">
              +{c.agents.length - AGENT_CHIPS}
            </span>
          )}
        </>
      ),
    },
  ];
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
