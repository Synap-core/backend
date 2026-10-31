"use client";

/**
 * `/open/tool/:id` — one integration in the receiver card. A tool in a
 * capability the reader can see opens that capability's page; any other is
 * drawn on its own. The body is `ToolObject`.
 */

import { ToolObject } from "../../_lib/object/views/tool-object";
import { OPEN_FRAME } from "../open-shell";

export function ToolView({ id }: { id: string }) {
  return <ToolObject id={id} frame={OPEN_FRAME} />;
}
