"use client";

/**
 * `/open/automation/:id` — one rule, hosted on the web (D6), in the receiver
 * card. The page itself is `AutomationObject`, shared with the console's
 * `/rules/[id]`; this file is only the receiver frame around it.
 */

import { AutomationObject } from "../../_lib/object/views/automation-object";
import { OPEN_FRAME } from "../open-shell";

export function AutomationView({ id }: { id: string }) {
  return <AutomationObject id={id} frame={OPEN_FRAME} />;
}
