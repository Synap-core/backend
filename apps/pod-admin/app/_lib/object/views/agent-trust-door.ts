/**
 * Where an agent's trust is changed, for this viewer. The page that widens or
 * revokes what an agent may do alone is the console's agents × work matrix
 * (`/governance/agents`: each cell's Widen / Revoke). What an agent may do is
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
import { objectViewsT } from "./copy";

const GOVERNANCE: ConsoleTarget = { page: "governance" };

export type AgentTrustDoor =
  | { kind: "link"; href: string; label: string }
  | { kind: "note"; text: string };

export function agentTrustDoor(role: ConsoleAudience): AgentTrustDoor {
  const t = objectViewsT();
  const href = consolePath(GOVERNANCE);
  if (href && consoleTargetVisibleTo(GOVERNANCE, role)) {
    return { kind: "link", href, label: t("agent.trust.change") };
  }
  return { kind: "note", text: t("agent.trust.askAdmin") };
}
