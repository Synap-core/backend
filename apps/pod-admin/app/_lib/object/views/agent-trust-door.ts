/**
 * Where an agent's trust is changed, for this viewer. The page that widens or
 * revokes what an agent may do alone is the console's agents × work matrix,
 * narrowed to THIS agent (`/governance/agents?agent=<id>`: each cell's Widen /
 * Revoke). How its writes land pod-wide is set on its own page, above this
 * door (`agentUsers.setPosture`). What an agent may do is
 * running the pod, and pod admin runs the pod (decision 94cd8636), yet the
 * agent's own panel sent everyone away to the desktop app's Settings.
 *
 * The page is pod-admin only, so a member is told who can change it rather
 * than handed a link that answers /forbidden (`consoleTargetVisibleTo`).
 */

import {
  consolePath,
  consoleTargetVisibleTo,
  type ConsoleAudience,
  type ConsoleTarget,
} from "@synap-core/types/console";
import { agentsAndWorkHref } from "../../../../lib/agent-matrix/matrix-view-model";
import { objectViewsT } from "./copy";

const GOVERNANCE: ConsoleTarget = { page: "governance" };

export type AgentTrustDoor =
  | { kind: "link"; href: string; label: string }
  | { kind: "note"; text: string };

export function agentTrustDoor(
  role: ConsoleAudience,
  agentUserId: string
): AgentTrustDoor {
  const t = objectViewsT();
  const base = consolePath(GOVERNANCE);
  if (base && consoleTargetVisibleTo(GOVERNANCE, role)) {
    return {
      kind: "link",
      href: agentsAndWorkHref(base, { agentUserId }),
      label: t("agent.trust.change"),
    };
  }
  return { kind: "note", text: t("agent.trust.askAdmin") };
}
