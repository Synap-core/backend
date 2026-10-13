"use client";

/**
 * `/open/session/:id` — the shared session body (`SessionBody`) in the
 * receiver card. The console draws the same body at `/sessions/:id`.
 */

import { SessionBody } from "../../_lib/object/views/session-body";
import { OPEN_FRAME } from "../open-shell";

export function SessionView({ id }: { id: string }) {
  return <SessionBody id={id} frame={OPEN_FRAME} />;
}
