"use client";

/**
 * `/open/agent/:id` — one agent in the receiver card. The body is
 * `AgentObject`; the console draws the same sections in its agent drawer.
 */

import { useRouter } from "next/navigation";
import { navHref } from "../../../lib/console-nav";
import { AgentObject } from "../../_lib/object/views/agent-object";
import { OPEN_FRAME } from "../open-shell";

export function AgentView({
  id,
  viewerIsPodAdmin,
}: {
  id: string;
  viewerIsPodAdmin: boolean;
}) {
  const router = useRouter();
  return (
    <AgentObject
      id={id}
      frame={OPEN_FRAME}
      viewerIsPodAdmin={viewerIsPodAdmin}
      // Removed: the page no longer has an object; Home is where a member
      // and an admin both land.
      onRemoved={() => router.replace(navHref("home"))}
    />
  );
}
