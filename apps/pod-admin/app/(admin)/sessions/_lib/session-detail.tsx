"use client";

/**
 * `/sessions/:id` — the shared session body (`SessionBody`, the same one
 * `/open/session/:id` draws) in console chrome: the page gutter, and a
 * breadcrumb back to the list on every state, so a failed read still has a
 * way back.
 */

import { Spinner } from "@heroui/react";
import { navHref, navLabel } from "../../../../lib/console-nav";
import {
  ObjectPage,
  type ObjectPageProps,
} from "../../../_lib/object/object-page";
import type { ObjectCrumb } from "../../../_lib/object/object-header";
import {
  SessionBody,
  type ObjectFrame,
} from "../../../_lib/object/views/session-body";
import { OpenInAppLink } from "../../../open/open-shell";
import type { LoadFailure } from "../../../open/open-model";

const LIST_CRUMB: ObjectCrumb = {
  label: navLabel("sessions"),
  href: navHref("sessions"),
};

function ConsolePage(props: ObjectPageProps) {
  return (
    <div className="max-w-[1100px] px-4 py-6 sm:px-6">
      <ObjectPage
        {...props}
        header={{
          ...props.header,
          breadcrumb: [LIST_CRUMB, { label: props.header.title }],
        }}
      />
    </div>
  );
}

function ConsoleLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex max-w-[1100px] items-center justify-center px-4 py-16 sm:px-6">
      <Spinner label={label} />
    </div>
  );
}

function ConsoleFailure({
  kind,
  id,
  failure,
}: {
  kind: string;
  id: string;
  failure: LoadFailure;
}) {
  return (
    <ConsolePage
      header={{
        kind,
        title: failure.title,
        summary: failure.message,
        status: { kind: "unknown", label: failure.chip },
        secondaryActions: <OpenInAppLink type={kind} id={id} />,
      }}
    />
  );
}

const CONSOLE_FRAME: ObjectFrame = {
  Loading: ConsoleLoading,
  Failure: ConsoleFailure,
  Page: ConsolePage,
  pathFor: (id) => `${navHref("sessions")}/${id}`,
};

export function SessionDetail({ id }: { id: string }) {
  return <SessionBody id={id} frame={CONSOLE_FRAME} />;
}
