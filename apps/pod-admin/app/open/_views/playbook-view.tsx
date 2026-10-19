"use client";

/**
 * `/open/playbook/:id` — one template in the receiver card. The page is
 * `PlaybookObject`, shared with the console's `/templates/[id]`; here a run row
 * opens that run's own web page.
 */

import { useRouter } from "next/navigation";
import { openIn } from "../../../lib/open-in";
import { PlaybookObject } from "../../_lib/object/views/playbook-object";
import { OPEN_FRAME } from "../open-shell";

export function PlaybookView({
  id,
  viewerIsPodAdmin,
}: {
  id: string;
  viewerIsPodAdmin: boolean;
}) {
  const router = useRouter();
  return (
    <PlaybookObject
      id={id}
      frame={OPEN_FRAME}
      viewerIsPodAdmin={viewerIsPodAdmin}
      onOpenRun={(run) =>
        router.push(
          openIn({
            kind: "object",
            objectKind: "run",
            id: run.id,
            params: { flowType: "playbook" },
          }).href
        )
      }
    />
  );
}
