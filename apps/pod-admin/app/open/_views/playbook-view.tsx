"use client";

/**
 * `/open/playbook/:id` — one process in the receiver card. The page is
 * `ProcessObject`, shared with the console's `/processes/[id]`. Its runs are
 * counts that open the desktop app (decision D4), so the card has no run
 * list of its own.
 */

import { ProcessObject } from "../../_lib/object/views/process-object";
import { OPEN_FRAME } from "../open-shell";

export function PlaybookView({
  id,
  viewerIsPodAdmin,
}: {
  id: string;
  viewerIsPodAdmin: boolean;
}) {
  return (
    <ProcessObject
      id={id}
      frame={OPEN_FRAME}
      viewerIsPodAdmin={viewerIsPodAdmin}
    />
  );
}
