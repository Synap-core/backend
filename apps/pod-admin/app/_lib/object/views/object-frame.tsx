"use client";

/**
 * `ObjectFrame` — WHERE an object page draws, kept apart from WHAT it draws.
 *
 * One object page per kind, two frames (D6): the `/open` receiver card a
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
  }) => ReactNode;
  object: (props: ObjectPageProps) => ReactNode;
  /** Crumbs above the title. A receiver has none; the console names its list. */
  breadcrumb?: (title: string) => ObjectCrumb[];
  /** Where another object of `kind` opens in this frame ("Run again" lands there). */
  pathFor?: (kind: string, id: string) => string;
}

/** The console's frame: the page itself, under a crumb back to `list`. */
export function consoleFrame(list: {
  label: string;
  href: string;
}): ObjectFrame {
  const crumbs = (title: string): ObjectCrumb[] => [
    { label: list.label, href: list.href },
    { label: title },
  ];
  return {
    breadcrumb: crumbs,
    pathFor: (_kind, id) => `${list.href}/${encodeURIComponent(id)}`,
    loading: (label) => (
      <PageShell>
        <PageSkeleton rows={3} label={label} />
      </PageShell>
    ),
    failure: ({ kind, id, failure }) => (
      <PageShell>
        <ObjectPage
          header={{
            kind,
            title: failure.title,
            summary: failure.message,
            status: { kind: "unknown", label: failure.chip },
            breadcrumb: crumbs(failure.chip),
            secondaryActions: <OpenInAppLink type={kind} id={id} />,
          }}
        />
      </PageShell>
    ),
    object: (props) => (
      <PageShell>
        <ObjectPage {...props} />
      </PageShell>
    ),
  };
}
