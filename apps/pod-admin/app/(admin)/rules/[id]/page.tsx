"use client";

/**
 * `/rules/[id]` — one rule in the console. The page is `AutomationObject`, the
 * same body `/open/automation/:id` draws in the receiver card; this route only
 * supplies the console frame (crumb back to Rules) and the run drawer its run
 * rows open, as a template's do. A rule the POD applies (`builtin:…`,
 * `declared:…`) is no automation: it draws `PodRuleObject`.
 */

import { useParams } from "next/navigation";
import { useState } from "react";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { AutomationObject } from "../../../_lib/object/views/automation-object";
import { consoleFrame } from "../../../_lib/object/views/object-frame";
import { RunDrawer, type RunTarget } from "../../runs/_lib/run-drawer";
import { isReactionRuleId } from "../_lib/reaction-rule-rows";
import { PodRuleObject } from "../_lib/pod-rule-object";

const FRAME = consoleFrame({
  label: navLabel("rules"),
  href: navHref("rules"),
});

export default function RulePage() {
  const { id: raw } = useParams<{ id: string }>();
  const id = decodeURIComponent(raw);
  const [target, setTarget] = useState<RunTarget | null>(null);
  // A rule the pod applies itself (built-in, or declared on a relation).
  if (isReactionRuleId(id)) return <PodRuleObject id={id} />;
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
