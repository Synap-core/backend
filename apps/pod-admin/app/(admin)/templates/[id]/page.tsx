"use client";

/**
 * `/templates/[id]` — one template in the console. The page is
 * `PlaybookObject`, the same body `/open/playbook/:id` draws in the receiver
 * card; this route only supplies the console frame (crumb back to Templates),
 * the run drawer its run rows open, and the way back to the list after an
 * archive.
 */

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { consoleFrame } from "../../../_lib/object/views/object-frame";
import { PlaybookObject } from "../../../_lib/object/views/playbook-object";
import { RunDrawer, type RunTarget } from "../../runs/_lib/run-drawer";

const FRAME = consoleFrame({
  label: navLabel("templates"),
  href: navHref("templates"),
});

export default function TemplatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [target, setTarget] = useState<RunTarget | null>(null);
  return (
    <>
      <PlaybookObject
        id={id}
        frame={FRAME}
        // The console is pod-admin only (`proxy.ts`).
        viewerIsPodAdmin
        onOpenRun={(run) =>
          setTarget({
            flowType: "playbook",
            id: run.id,
            flowName: run.flowName,
          })
        }
        onArchived={() => router.push(navHref("templates"))}
      />
      <RunDrawer target={target} onClose={() => setTarget(null)} />
    </>
  );
}
