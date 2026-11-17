"use client";

/**
 * `/open/session/:id` — the shared session body (`SessionBody`) in the
 * receiver card. The console's `/sessions/:id` redirects here
 * (`WORK_MOVED_TO_APP`, lib/console-nav.ts).
 */

import { SessionBody } from "../../_lib/object/views/session-body";
import { OPEN_FRAME } from "../open-shell";

export function SessionView({ id }: { id: string }) {
  return <SessionBody id={id} frame={OPEN_FRAME} />;
}
