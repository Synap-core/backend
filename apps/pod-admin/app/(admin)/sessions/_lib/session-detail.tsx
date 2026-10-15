"use client";

/**
 * `/sessions/:id` — the shared session body (`SessionBody`, the same one
 * `/open/session/:id` draws) in the console frame: the page column, and a
 * breadcrumb back to the list on every state, so a failed read still has a
 * way back.
 */

import { navHref, navLabel } from "../../../../lib/console-nav";
import { SessionBody } from "../../../_lib/object/views/session-body";
import { consoleFrame } from "../../../_lib/object/views/object-frame";

const FRAME = consoleFrame({
  label: navLabel("sessions"),
  href: navHref("sessions"),
});

export function SessionDetail({ id }: { id: string }) {
  return <SessionBody id={id} frame={FRAME} />;
}
