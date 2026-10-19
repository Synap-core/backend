"use client";

/**
 * `SubjectActivity` — an object page's Activity tab: what was done to the
 * object, newest first, on its ids as the subject. A pod admin reads
 * `events.adminSubjectActivity`: anyone's acts on apps and computers, which
 * carry no space. A member reads `events.search`, floored to them — their own
 * acts, and acts in spaces they can see — and the hint says so. The page
 * supplies the ids and the words for each row.
 */

import type { ReactNode } from "react";
import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { useConsoleRole } from "../../(admin)/components/side-nav-role";

/** Rows the tab reads — one page, newest first. */
const ACTIVITY_SHOWN = 25;
/** Both doors bound their subject list; an object never needs more. */
const MAX_SUBJECTS = 200;

/** The slice of an event row a line is written from. */
export interface SubjectEventLike {
  eventType: string;
  userId: string;
  data: unknown;
}

export function SubjectActivity({
  subjectIds,
  line,
  empty,
}: {
  /** The object's id, plus any id its acts are recorded on (its keys). */
  subjectIds: readonly string[];
  /** One row in words. */
  line: (e: SubjectEventLike) => string;
  empty?: string;
}) {
  const isAdmin = useConsoleRole() === "admin";
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const viewerId = me.data?.id ?? null;
  const input = {
    subjectIds: subjectIds.slice(0, MAX_SUBJECTS),
    limit: ACTIVITY_SHOWN,
  };
  const enabled = subjectIds.length > 0;
  const adminEvents = trpc.events.adminSubjectActivity.useQuery(input, {
    staleTime: 30_000,
    enabled: enabled && isAdmin,
  });
  const memberEvents = trpc.events.search.useQuery(input, {
    staleTime: 30_000,
    enabled: enabled && !isAdmin,
  });
  const events = isAdmin ? adminEvents : memberEvents;
  const emptyLine =
    empty ??
    (isAdmin
      ? "Nothing recorded on it yet."
      : "Nothing recorded on it that you can see yet.");
  let body: ReactNode;
  if (subjectIds.length === 0) body = <ResourceRowEmpty message={emptyLine} />;
  else if (events.isLoading) body = <ResourceRowSkeleton count={3} />;
  else if (events.isError)
    body = (
      <ResourceRowError
        message="Couldn't load its activity."
        onRetry={() => void events.refetch()}
      />
    );
  else if ((events.data ?? []).length === 0)
    body = <ResourceRowEmpty message={emptyLine} />;
  else
    body = (
      <ul className="flex flex-col divide-y divide-foreground/[0.05]">
        {(events.data ?? []).map((e) => (
          <li
            key={e.id}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
          >
            <span className="min-w-0 text-[12.5px] text-foreground">
              {line(e)}
              {viewerId && e.userId === viewerId && (
                <span className="text-foreground/65"> · by you</span>
              )}
            </span>
            <span className="shrink-0 text-[12px] text-foreground/65">
              {formatRelative(e.timestamp)}
            </span>
          </li>
        ))}
      </ul>
    );
  return (
    <SectionCard
      title="Activity"
      hint={
        isAdmin
          ? "Changes made to it by anyone on this pod."
          : "Changes you can see: yours, and those in spaces you belong to."
      }
    >
      {body}
    </SectionCard>
  );
}
