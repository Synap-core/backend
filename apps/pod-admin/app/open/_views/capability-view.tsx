"use client";

/**
 * `/open/capability/:id` — one capability in the receiver card: its state for
 * everyone, its verb switches for those the pod lets turn them on. The body is
 * `CapabilityObject`; the console has no page of its own for one (Marketplace
 * lists them).
 */

import { CapabilityObject } from "../../_lib/object/views/capability-object";
import { OPEN_FRAME } from "../open-shell";

export function CapabilityView({
  id,
  viewerIsPodAdmin,
}: {
  id: string;
  viewerIsPodAdmin: boolean;
}) {
  return (
    <CapabilityObject
      id={id}
      frame={OPEN_FRAME}
      viewerIsPodAdmin={viewerIsPodAdmin}
    />
  );
}
