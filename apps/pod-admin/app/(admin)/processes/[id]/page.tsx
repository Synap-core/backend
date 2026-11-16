"use client";

/**
 * `/processes/[id]` — one process in the console. The page is
 * `ProcessObject`, the same body `/open/playbook/:id` draws in the receiver
 * card; this route only supplies the console frame (crumb back to
 * Processes) and the way back to the list after an archive. `/templates/:id`
 * redirects here (`console-nav.ts` legacy).
 */

import { useParams, useRouter } from "next/navigation";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { consoleFrame } from "../../../_lib/object/views/object-frame";
import { ProcessObject } from "../../../_lib/object/views/process-object";

const FRAME = consoleFrame({
  label: navLabel("processes"),
  href: navHref("processes"),
});

export default function ProcessPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  return (
    <ProcessObject
      id={id}
      frame={FRAME}
      // The console is pod-admin only (`proxy.ts`).
      viewerIsPodAdmin
      onArchived={() => router.push(navHref("processes"))}
    />
  );
}
