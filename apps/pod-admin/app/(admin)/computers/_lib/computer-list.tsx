"use client";

/**
 * The computers list — ONE implementation for `/computers` (every member's,
 * pod admin, with an Owner column) and `/my-computers` (the person's own).
 * The page supplies the rows and what the viewer may see; this draws the
 * filter chips (`?status=`), the expired-key callout, and the rows (a table
 * from `md` up, stacked rows on a phone), and receives `?focus=<id>`.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Laptop } from "lucide-react";
import type { ReactNode } from "react";
import { formatRelative } from "../../../../lib/format";
import { MD_UP, useMediaQuery } from "../../../../lib/use-media-query";
import { CopyButton } from "../../../_lib/copy-button";
import { FilterChips } from "../../components/filter-chips";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
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
  const router = useRouter();
  const params = useSearchParams();
  const filter = computerFilterOf(params.get(FILTER_PARAM));
  const wide = useMediaQuery(MD_UP);
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
          <p className="text-[12.5px] font-medium text-foreground">{expired}</p>
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
        ) : wide ? (
          <ComputerTable
            computers={visible}
            hrefFor={hrefFor}
            showOwner={showOwner}
            viewerId={viewerId}
            onOpen={(id) => router.push(hrefFor(id))}
          />
        ) : (
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {visible.map((c) => (
              <div
                key={c.id}
                data-row-id={c.id}
                className="rounded-md transition-shadow"
              >
                <ResourceRow
                  Icon={Laptop}
                  primary={c.name}
                  secondary={[
                    c.hostname,
                    platformLabel(c.platform),
                    showOwner ? ownerWords(c, viewerId) : null,
                    `seen ${formatRelative(c.lastSeenAt, { empty: "never" })}`,
                    agentsPhrase(c.agents.length),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  status={keyStatus(c.key)}
                  onSelect={() => router.push(hrefFor(c.id))}
                  wrap
                />
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </>
  );
}

/** A command a person copies onto the computer, in mono with Copy. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 break-all rounded-md bg-foreground/[0.06] px-2 py-1 font-mono text-[12px] text-foreground">
        {command}
      </code>
      <CopyButton
        text={command}
        label="Copy"
        variant="light"
        ariaLabel={`Copy ${command}`}
      />
    </div>
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

const TABLE_COLUMNS =
  "grid items-center gap-3 grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1.8fr)]";
const TABLE_COLUMNS_OWNER =
  "grid items-center gap-3 grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1.8fr)]";

function ComputerTable({
  computers,
  hrefFor,
  showOwner,
  viewerId,
  onOpen,
}: {
  computers: readonly ComputerLike[];
  hrefFor: (id: string) => string;
  showOwner: boolean;
  viewerId: string | null;
  onOpen: (id: string) => void;
}) {
  const columns = showOwner ? TABLE_COLUMNS_OWNER : TABLE_COLUMNS;
  return (
    <div role="table" aria-label="Computers" className="-mx-2">
      <div
        role="row"
        className={`${columns} border-b border-foreground/[0.06] px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65`}
      >
        <div role="columnheader">Computer</div>
        <div role="columnheader">Platform</div>
        {showOwner && <div role="columnheader">Owner</div>}
        <div role="columnheader">Last seen</div>
        <div role="columnheader">Key</div>
        <div role="columnheader">Agents</div>
      </div>
      <div role="rowgroup" className="divide-y divide-foreground/[0.05]">
        {computers.map((c) => {
          const owner = ownerWords(c, viewerId);
          return (
            <div
              key={c.id}
              role="row"
              data-row-id={c.id}
              onClick={() => onOpen(c.id)}
              className={`${columns} min-h-14 cursor-pointer rounded-md px-2 py-2 text-[12.5px] transition-colors hover:bg-foreground/[0.03]`}
            >
              <div role="cell" className="flex min-w-0 flex-col">
                <Link
                  href={hrefFor(c.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="max-w-full truncate rounded-sm text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {c.name}
                </Link>
                {c.hostname && (
                  <span className="truncate font-mono text-[11.5px] text-foreground/55">
                    {c.hostname}
                  </span>
                )}
              </div>
              <Cell>{platformLabel(c.platform) ?? "—"}</Cell>
              {showOwner && (
                <Cell>{owner ? capitalize(owner) : "Unknown"}</Cell>
              )}
              <Cell>{formatRelative(c.lastSeenAt, { empty: "never" })}</Cell>
              <div role="cell" className="min-w-0">
                <StatusPill {...keyStatus(c.key)} />
              </div>
              <div role="cell" className="flex min-w-0 flex-wrap gap-1">
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
                  <span className="text-[11.5px] text-foreground/55">
                    +{c.agents.length - AGENT_CHIPS}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Cell({ children }: { children: ReactNode }) {
  return (
    <div role="cell" className="min-w-0 truncate text-foreground/65">
      {children}
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
