/**
 * Compile-time contract: the automation rows `@synap-core/types/automations`
 * declares are EXACTLY the rows inferred from this package's tables
 * (`schema/automations.ts`). No runtime code. A column added, retyped or made
 * nullable on one side only fails `tsc` here. (The flow definition itself is
 * not copied: the tables import it from `@synap-core/types/automations/flow`.)
 */
import type {
  Automation as WireAutomation,
  NewAutomation as WireNewAutomation,
  AutomationRun as WireAutomationRun,
  NewAutomationRun as WireNewAutomationRun,
  AutomationStepRun as WireAutomationStepRun,
  NewAutomationStepRun as WireNewAutomationStepRun,
} from "@synap-core/types/automations";
import type {
  Automation,
  NewAutomation,
  AutomationRun,
  NewAutomationRun,
  AutomationStepRun,
  NewAutomationStepRun,
} from "../schema/automations.js";
import type { Equal } from "./equal.js";

export const _automation: Equal<Automation, WireAutomation> = true;
export const _newAutomation: Equal<NewAutomation, WireNewAutomation> = true;
export const _automationRun: Equal<AutomationRun, WireAutomationRun> = true;
export const _newAutomationRun: Equal<NewAutomationRun, WireNewAutomationRun> =
  true;
export const _automationStepRun: Equal<
  AutomationStepRun,
  WireAutomationStepRun
> = true;
export const _newAutomationStepRun: Equal<
  NewAutomationStepRun,
  WireNewAutomationStepRun
> = true;
