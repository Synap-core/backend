"use client";

/**
 * `/agents/[id]` — one agent in the console (`agentHref`), keyed by its agent
 * USER id. The body is `AgentObject`, the same page `/open/agent/:id` draws
 * in the receiver card for a member (a pod admin who follows that link is
 * sent here, `openRedirect`); this route supplies the console frame (crumb
 * back to Agents), the link to its owner's Members row, and the way back to
 * the list once its creator's agents are removed. Its computer and its keys
 * are facts of the body already.
 */

import { useParams, useRouter } from "next/navigation";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { AgentObject } from "../../../_lib/object/views/agent-object";
import { consoleFrame } from "../../../_lib/object/views/object-frame";

const FRAME = consoleFrame({
  label: navLabel("agents"),
  href: navHref("agents"),
});

const ownerHref = (userId: string) => navHref("members", { focus: userId });

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  return (
    <AgentObject
      id={id}
      frame={FRAME}
      // The console is pod-admin only (`proxy.ts`).
      viewerIsPodAdmin
      ownerHref={ownerHref}
      onRemoved={() => router.replace(navHref("agents"))}
    />
  );
}
