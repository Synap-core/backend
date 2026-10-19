"use client";

/**
 * `/open/run/:id[?flowType=]` — one run in the receiver card. The body is the
 * shared run body (`RunObject`), which the console draws in its run drawer.
 */

import { RunObject } from "../../_lib/object/views/run-object";
import { OPEN_FRAME } from "../open-shell";

export function RunView({
  id,
  flowType,
}: {
  id: string;
  flowType: string | undefined;
}) {
  return <RunObject id={id} flowType={flowType} frame={OPEN_FRAME} />;
}
