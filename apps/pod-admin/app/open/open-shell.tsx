"use client";

/**
 * The frame every `/open` state draws in: `ReceiverShell`'s card around the
 * shared object skin (`app/_lib/object`). Loading, a failure, a bounce and a
 * hosted object all read as the same page, so a reader who lands on two of
 * them recognises the second.
 */

import type { ReactNode } from "react";
import { CardBody } from "@heroui/react";
import { ReceiverShell, type ReceiverWidth } from "../_lib/receiver-shell";
import { PageSkeleton } from "../(admin)/components/page-header";
import { ObjectPage, type ObjectPageProps } from "../_lib/object/object-page";
import type { LoadFailure } from "../_lib/object/load-failure";
import { OpenInAppLink } from "../_lib/object/open-in-app-link";
import type { ObjectFrame } from "../_lib/object/views/object-frame";
import { labelForOpenType } from "./open-params";

export function OpenCard({
  children,
  width,
}: {
  children: ReactNode;
  width?: ReceiverWidth;
}) {
  return (
    <ReceiverShell width={width}>
      <CardBody className="px-5 py-6 sm:px-7 sm:py-7">{children}</CardBody>
    </ReceiverShell>
  );
}

export function OpenLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <OpenCard>
      <PageSkeleton rows={3} label={label} />
    </OpenCard>
  );
}

/** An object page in the receiver card; `width` as `ReceiverShell` takes it. */
export function OpenObject({
  width,
  ...props
}: ObjectPageProps & { width?: ReceiverWidth }) {
  return (
    <OpenCard width={width}>
      <ObjectPage {...props} />
    </OpenCard>
  );
}

/**
 * A page with nothing to render but a sentence: an invalid link, a failed
 * load, nothing found. `chip` names the state; the exit, when given, is the
 * way on (the app may still open what the web could not).
 */
export function OpenMessage({
  kind,
  title,
  message,
  chip,
  appLink,
}: {
  kind: string;
  title: string;
  message: string;
  chip: string;
  appLink?: { type: string; id: string };
}) {
  return (
    <OpenObject
      header={{
        kind,
        noun: kind === "open" ? "Open" : labelForOpenType(kind),
        title,
        summary: message,
        status: { kind: "unknown", label: chip },
        secondaryActions: appLink ? (
          <OpenInAppLink type={appLink.type} id={appLink.id} />
        ) : undefined,
      }}
    />
  );
}

export function OpenFailure({
  kind,
  failure,
  id,
}: {
  kind: string;
  failure: LoadFailure;
  id: string;
}) {
  return (
    <OpenMessage
      kind={kind}
      title={failure.title}
      message={failure.message}
      chip={failure.chip}
      appLink={{ type: kind, id }}
    />
  );
}

/** The receiver card as an object page's frame — every hosted kind draws in it. */
export const OPEN_FRAME: ObjectFrame = {
  loading: (label) => <OpenLoading label={label} />,
  failure: ({ kind, id, failure }) => (
    <OpenFailure kind={kind} id={id} failure={failure} />
  ),
  object: (props) => <OpenObject {...props} />,
  pathFor: (kind, id) => `/open/${kind}/${encodeURIComponent(id)}`,
};
