/**
 * Approve executors — thin aggregator. Each domain's `registerProposalExecutor`
 * calls live in `./executors/<domain>.ts`, grouped by the `${targetType}/${
 * proposalType}` key prefix (document/*, channel/*, entity/* + facet/*,
 * property_def/*, focus_session/*, project/*, view/*, profile/*, skill/*,
 * tool/*, automation/*, playbook/*, cell/define, workspace/*, messaging.*,
 * capability.*, provider.action). Shared header helpers (`reportApproved`,
 * `dispatchExternalOnce`) live in `./executors/shared.ts` — a leaf module.
 *
 * Each `execute()` body is the VERBATIM branch body from the old flat
 * if-chain in proposals.ts (same caller construction, same db updates, same
 * `emitProposalReviewed`/`reportProposalOutcome` calls in the same position,
 * same returns, same idempotency guards). Behaviour is identical — the only
 * change is the dispatch mechanism (registry lookup vs. if-ladder), and now
 * the FILE the registration call lives in.
 *
 * Registration runs once, from `registerApproveExecutors()` in proposals.ts,
 * which passes module-scope helpers via `deps` so the bodies stay verbatim
 * without a circular import. Registration ORDER does not affect resolution
 * (the registry is a Map keyed by exact `${targetType}/${proposalType}`, with
 * the wildcard catch-all key checked only after both exact lookups miss — see
 * `execution-registry.ts#resolve`), but the catch-all is still registered
 * LAST here to keep that invariant obvious at a glance.
 */

import { registerDocumentExecutors } from "./executors/document.js";
import { registerChannelExecutors } from "./executors/channel.js";
import { registerEntityExecutors } from "./executors/entity.js";
import { registerPropertyDefExecutors } from "./executors/property-def.js";
import { registerFocusSessionExecutors } from "./executors/focus-session.js";
import { registerDevApprovalExecutors } from "./executors/dev-approval.js";
import { registerProjectExecutors } from "./executors/project.js";
import { registerViewExecutors } from "./executors/view.js";
import { registerProfileExecutors } from "./executors/profile.js";
import { registerSkillExecutors } from "./executors/skill.js";
import { registerToolExecutors } from "./executors/tool.js";
import { registerRoleExecutors } from "./executors/role.js";
import { registerArtifactExecutors } from "./executors/artifact.js";
import { registerRuleExecutors } from "./executors/rule.js";
import { registerAutomationExecutors } from "./executors/automation.js";
import { registerPlaybookExecutors } from "./executors/playbook.js";
import { registerPlaybookStageGateExecutors } from "./executors/playbook-stage-gate.js";
import { registerCellExecutors } from "./executors/cell.js";
import { registerWorkspaceExecutors } from "./executors/workspace.js";
import { registerMessagingExecutors } from "./executors/messaging.js";
import { registerCapabilityExecutors } from "./executors/capability.js";
import { registerProviderExecutors } from "./executors/provider.js";
import { registerWidgetExecutors } from "./executors/widget.js";
import { registerCatchAllExecutor } from "./executors/catch-all.js";

let registered = false;

/**
 * Register every approve executor exactly once (idempotent — safe to call from
 * multiple import sites). Called at module load by proposals.ts.
 */
export function registerApproveExecutors(): void {
  if (registered) return;
  registered = true;

  registerDocumentExecutors();
  registerChannelExecutors();
  registerEntityExecutors();
  registerPropertyDefExecutors();
  registerFocusSessionExecutors();
  registerDevApprovalExecutors();
  registerProjectExecutors();
  registerViewExecutors();
  registerProfileExecutors();
  registerSkillExecutors();
  registerToolExecutors();
  registerRoleExecutors();
  registerArtifactExecutors();
  registerRuleExecutors();
  registerAutomationExecutors();
  registerPlaybookExecutors();
  registerPlaybookStageGateExecutors();
  registerCellExecutors();
  registerWorkspaceExecutors();
  registerMessagingExecutors();
  registerCapabilityExecutors();
  registerProviderExecutors();
  registerWidgetExecutors();
  // Wildcard catch-all — registered LAST (see module docstring).
  registerCatchAllExecutor();
}
