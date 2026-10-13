"use client";

/**
 * `ObjectHeader` — the ONE header of an object page, in the console and on
 * an `/open` receiver alike: what it is (kind icon + noun from the vocabulary
 * registry), its name, one sentence on its state, its status, and ONE primary
 * action with any secondaries beside it.
 *
 * Prior-art rule (POD-ADMIN-CONSOLE-DECISIONS §4): one header, status as a
 * sentence, one primary action. Wave-2 pages compose this rather than each
 * building their own title block.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { ProfileIdentityInput } from "@synap-core/types/vocabulary";
import {
  StatusPill,
  type StatusKind,
} from "../../(admin)/components/status-pill";
import { kindIcon, kindLabel } from "./kind-icon";

export interface ObjectCrumb {
  label: string;
  /** Omitted on the last crumb (the page you are on). */
  href?: string;
}

/** The crumbs back to where this page sits, the last one the page itself. */
export function Breadcrumbs({ crumbs }: { crumbs: ObjectCrumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-[12px] text-foreground/65">
        {crumbs.map((crumb, i) => (
          <li
            key={`${crumb.label}-${i}`}
            className="flex min-w-0 items-center gap-1"
          >
            {i > 0 && (
              <span aria-hidden className="text-foreground/40">
                /
              </span>
            )}
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="truncate rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export interface ObjectHeaderProps {
  /** Registry kind (`automation`, `session`, `entity`, …) — icon + noun. */
  kind: string;
  /** The entity's profile, so a task draws a task's icon. */
  profile?: ProfileIdentityInput | null;
  /**
   * The noun line, when the registry noun is not the whole story (an entity's
   * profile name, "Rule · cron"), or the noun with a neutral fact chip beside
   * it (an app's "how it connects"). Defaults to the registry noun.
   */
  noun?: ReactNode;
  title: string;
  /** One plain sentence: what this is doing, or what is wrong with it. */
  summary?: ReactNode;
  status?: { kind: StatusKind; label: string } | null;
  /** The one thing to do here. */
  primaryAction?: ReactNode;
  /** Everything else, quieter (an "Open in app ↗" exit, a pause). */
  secondaryActions?: ReactNode;
  breadcrumb?: ObjectCrumb[];
}

export function ObjectHeader({
  kind,
  profile,
  noun,
  title,
  summary,
  status,
  primaryAction,
  secondaryActions,
  breadcrumb,
}: ObjectHeaderProps) {
  const Icon = kindIcon(kind, profile);
  const nounLine = noun ?? kindLabel(kind);
  return (
    <header className="flex flex-col gap-3">
      {breadcrumb && breadcrumb.length > 0 && (
        <Breadcrumbs crumbs={breadcrumb} />
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-content3 text-foreground"
          >
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="min-w-0 break-words text-balance font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
                {title}
              </h1>
              {status && <StatusPill kind={status.kind} label={status.label} />}
              <div className="flex items-center gap-1.5 text-[12.5px] text-foreground/65">
                {nounLine}
              </div>
            </div>
            {summary && (
              <p className="max-w-2xl text-[13px] leading-relaxed text-foreground/65">
                {summary}
              </p>
            )}
          </div>
        </div>
        {(primaryAction || secondaryActions) && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
            {primaryAction}
            {secondaryActions}
          </div>
        )}
      </div>
    </header>
  );
}
