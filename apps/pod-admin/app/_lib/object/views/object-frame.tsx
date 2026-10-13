"use client";

/**
 * `ObjectFrame` — WHERE an object page draws, kept apart from WHAT it draws.
 *
 * One object page per kind, two frames (D6): the `/open` receiver card a
 * member lands on from a link, and the console route an admin reaches from a
 * list. The body (`views/*-object.tsx`) fetches, decides and composes the
 * `ObjectPage`; the frame only says how loading, a failed read and the loaded
 * page are presented, and which crumbs lead back.
 */

import type { ReactNode } from "react";
import { Spinner } from "@heroui/react";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import type { LoadFailure } from "../../../open/open-model";
import type { ObjectCrumb } from "../object-header";
import { ObjectPage, type ObjectPageProps } from "../object-page";

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
    loading: (label) => (
      <ConsoleObjectShell>
        <div className="flex justify-center py-16">
          <Spinner label={label} />
        </div>
      </ConsoleObjectShell>
    ),
    failure: ({ kind, id, failure }) => (
      <ConsoleObjectShell>
        <ObjectPage
          header={{
            kind,
            title: failure.title,
            summary: failure.message,
            status: { kind: "unknown", label: failure.chip },
            breadcrumb: crumbs(failure.chip),
            secondaryActions: (
              <ExitLink
                exit={openIn({ kind: "objectInApp", objectKind: kind, id })}
                label="Open in app"
              />
            ),
          }}
        />
      </ConsoleObjectShell>
    ),
    object: (props) => (
      <ConsoleObjectShell>
        <ObjectPage {...props} />
      </ConsoleObjectShell>
    ),
  };
}

function ConsoleObjectShell({ children }: { children: ReactNode }) {
  return <div className="max-w-[1100px] px-4 py-6 sm:px-6">{children}</div>;
}
