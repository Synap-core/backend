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
import { Fragment, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
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

export interface ObjectHeaderProps {
  /** Registry kind (`automation`, `session`, `entity`, …) — icon + noun. */
  kind: string;
  /** The entity's profile, so a task draws a task's icon. */
  profile?: ProfileIdentityInput | null;
  /**
   * The noun line, when the registry noun is not the whole story (an entity's
   * profile name, "Rule · cron"). Defaults to the registry noun.
   */
  noun?: string;
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
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-[12px] text-foreground/65">
            {breadcrumb.map((crumb, i) => (
              <Fragment key={`${crumb.label}-${i}`}>
                {i > 0 && (
                  <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
                )}
                <li className="min-w-0 truncate">
                  {crumb.href ? (
                    <Link
                      href={crumb.href}
                      className="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current="page">{crumb.label}</span>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
          >
            <Icon className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
              {nounLine}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="min-w-0 break-words text-balance font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
                {title}
              </h1>
              {status && <StatusPill kind={status.kind} label={status.label} />}
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
