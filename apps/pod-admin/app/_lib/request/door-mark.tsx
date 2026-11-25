"use client";

/**
 * A named thing as a DOOR (ui-composition §3): a lens door (`LensDoor`,
 * `@synap-core/types/lens`) opened through the one exit door (`openIn`),
 * placed for the device, with the open attempt taken. Plain text where
 * nothing opens it on this device. The request row and the request story
 * draw every name through it.
 */

import type { ReactNode } from "react";
import type { LensDoor } from "@synap-core/types/lens";
import { isObjectNavView } from "@synap-core/types/navigation";
import { openIn } from "../../../lib/open-in";
import {
  externalProps,
  rowHref,
  useAppOpenAttempt,
  usePlacedExit,
} from "../../../lib/exit-link";

/** A door reads as one at rest (no hover on a phone): a quiet underline. */
const LINK =
  "rounded-sm underline decoration-foreground/30 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/** The exit a lens door opens. */
export function lensDoorExit(door: LensDoor) {
  return openIn({
    kind: "object",
    objectKind: door.kind,
    id: door.id,
    ...(isObjectNavView(door.view) ? { view: door.view } : {}),
  });
}

function PlacedDoor({
  door,
  className,
  children,
}: {
  door: LensDoor;
  className: string;
  children: ReactNode;
}) {
  const placed = usePlacedExit(lensDoorExit(door));
  const open = useAppOpenAttempt(placed);
  const href = rowHref(placed);
  return href ? (
    <>
      <a
        href={href}
        {...externalProps(href)}
        onClick={(e) => {
          // A door inside a selectable row opens its own object, never the row.
          e.stopPropagation();
          open.onOpen?.();
        }}
        className={`${className} ${LINK}`}
      >
        {children}
      </a>
      {open.offer}
    </>
  ) : (
    <span className={className}>{children}</span>
  );
}

export function DoorMark({
  door,
  className = "inline-flex min-w-0 items-center gap-1",
  children,
}: {
  door: LensDoor | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  if (!door) return <span className={className}>{children}</span>;
  return (
    <PlacedDoor door={door} className={className}>
      {children}
    </PlacedDoor>
  );
}
