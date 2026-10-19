"use client";

/**
 * `/open/automation/:id` — one rule, hosted on the web (D6), in the receiver
 * card. The page itself is `AutomationObject`, shared with the console's
 * `/rules/[id]`; this file is only the receiver frame around it, where a run
 * row opens that run's own web page.
 */

import { useRouter } from "next/navigation";
import { openIn } from "../../../lib/open-in";
import { AutomationObject } from "../../_lib/object/views/automation-object";
import { OPEN_FRAME } from "../open-shell";

export function AutomationView({ id }: { id: string }) {
  const router = useRouter();
  return (
    <AutomationObject
      id={id}
      frame={OPEN_FRAME}
      onOpenRun={(run) =>
        router.push(
          openIn({
            kind: "object",
            objectKind: "run",
            id: run.id,
            params: { flowType: "automation" },
          }).href
        )
      }
    />
  );
}
