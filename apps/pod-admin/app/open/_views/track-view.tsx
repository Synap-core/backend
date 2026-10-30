"use client";

/**
 * `/open/track/:id` — one goal in the receiver card. The page is
 * `GoalObject`: how close it is to done, the judge's verbs, its sessions.
 */

import { GoalObject } from "../../_lib/object/views/goal-object";
import { OPEN_FRAME } from "../open-shell";

export function TrackView({ id }: { id: string }) {
  return <GoalObject id={id} frame={OPEN_FRAME} />;
}
