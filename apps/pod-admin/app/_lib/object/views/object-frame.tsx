"use client";

/**
 * `ObjectFrame` — WHERE an object page draws, kept apart from WHAT it draws.
 *
 * One object page per kind, two frames: the `/open` receiver card a
 * member lands on from a link (`OPEN_FRAME`, `app/open/open-shell.tsx`), and
 * the console route an admin reaches from a list (`consoleFrame`). The body
 * (`views/*`) fetches, decides and composes the `ObjectPage`; the frame only
 * says how loading, a failed read and the loaded page are presented, which
 * crumbs lead back, and where another object of a kind opens in it.
 */

import type { ReactNode } from "react";
import {
  PageShell,
  PageSkeleton,
} from "../../../(admin)/components/page-header";
import type { LoadFailure } from "../load-failure";
import type { ObjectCrumb } from "../object-header";
import { ObjectPage, type ObjectPageProps } from "../object-page";
import { OpenInAppLink } from "../open-in-app-link";

export interface ObjectFrame {
  loading: (label: string) => ReactNode;
  failure: (args: {
    kind: string;
    id: string;
    failure: LoadFailure;
    /**
     * `false` for an object the Synap app has no page for (a computer, a
     * connected app): no "Open in app" beside the failure. Word the failure
     * to match (`loadFailure(..., { inApp: false })`).
     */
    openIn?: boolean;
  }) => ReactNode;
  object: (props: ObjectPageProps) => ReactNode;
  /** Crumbs above the title. A receiver has none; the console names its list. */
  breadcrumb?: (title: string) => ObjectCrumb[];
  /** Where another object of `kind` opens in this frame ("Run again" lands there). */
  pathFor?: (kind: string, id: string) => string;
}

/**
 * The console's frame: the page itself, under a crumb back to `list`. A
 * self-service list (`/my-computers`) passes its `personal` column width.
 */
export function consoleFrame(list: {
  label: string;
  href: string;
  width?: "console" | "personal";
}): ObjectFrame {
  const crumbs = (title: string): ObjectCrumb[] => [
    { label: list.label, href: list.href },
    { label: title },
  ];
  return {
    breadcrumb: crumbs,
    pathFor: (_kind, id) => `${list.href}/${encodeURIComponent(id)}`,
    loading: (label) => (
      <PageShell width={list.width}>
        <PageSkeleton rows={3} label={label} />
      </PageShell>
    ),
    failure: ({ kind, id, failure, openIn = true }) => (
      <PageShell width={list.width}>
        <ObjectPage
          header={{
            kind,
            title: failure.title,
            summary: failure.message,
            status: { kind: "unknown", label: failure.chip },
            breadcrumb: crumbs(failure.chip),
            secondaryActions: openIn ? (
              <OpenInAppLink type={kind} id={id} />
            ) : undefined,
          }}
        />
      </PageShell>
    ),
    object: (props) => (
      <PageShell width={list.width}>
        <ObjectPage {...props} />
      </PageShell>
    ),
  };
}
