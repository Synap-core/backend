"use client";

/**
 * `/rules/[id]` — one rule in the console. The page is `AutomationObject`, the
 * same body `/open/automation/:id` draws in the receiver card; this route only
 * supplies the console frame (crumb back to Rules) and the run drawer its run
 * rows open, as a template's do.
 */

import { useParams } from "next/navigation";
import { useState } from "react";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { AutomationObject } from "../../../_lib/object/views/automation-object";
import { consoleFrame } from "../../../_lib/object/views/object-frame";
import { RunDrawer, type RunTarget } from "../../runs/_lib/run-drawer";

const FRAME = consoleFrame({
  label: navLabel("rules"),
  href: navHref("rules"),
});

export default function RulePage() {
  const { id } = useParams<{ id: string }>();
  const [target, setTarget] = useState<RunTarget | null>(null);
  return (
    <>
      <AutomationObject
        id={id}
        frame={FRAME}
        onOpenRun={(run) =>
          setTarget({
            flowType: "automation",
            id: run.id,
            flowName: run.flowName,
          })
        }
      />
      <RunDrawer target={target} onClose={() => setTarget(null)} />
    </>
  );
}
