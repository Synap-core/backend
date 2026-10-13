"use client";

/**
 * `/rules/[id]` — one rule in the console. The page is `AutomationObject`, the
 * same body `/open/automation/:id` draws in the receiver card; this route only
 * supplies the console frame (crumb back to Rules).
 */

import { useParams } from "next/navigation";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { AutomationObject } from "../../../_lib/object/views/automation-object";
import { consoleFrame } from "../../../_lib/object/views/object-frame";

const FRAME = consoleFrame({
  label: navLabel("rules"),
  href: navHref("rules"),
});

export default function RulePage() {
  const { id } = useParams<{ id: string }>();
  return <AutomationObject id={id} frame={FRAME} />;
}
