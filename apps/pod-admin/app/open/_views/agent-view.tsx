"use client";

/**
 * `/open/agent/:id` — one agent in the receiver card, for a member. A pod
 * admin is sent to the agent's console page instead (`openRedirect` →
 * `agentHref`), which draws the same body, `AgentObject`, in the console
 * frame.
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
