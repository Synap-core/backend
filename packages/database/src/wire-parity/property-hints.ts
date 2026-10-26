/**
 * Compile-time contract: the pod's uiHints unions (`schema/property-defs.ts`)
 * are EXACTLY `@synap-core/types/property-hints`'. No runtime code. Add a member
 * on one side only and `tsc` here fails.
 */
import type {
  PropertyDisplayAs,
  PropertyInputType,
} from "@synap-core/types/property-hints";
import type {
  PROPERTY_INPUT_TYPES as POD_INPUT_TYPES,
  PropertyInputType as PodInputType,
  PropertyUIHints as PodUIHints,
} from "../schema/property-defs.js";
import type { Equal } from "./equal.js";

export const _inputTypes: Equal<PodInputType, PropertyInputType> = true;
export const _inputTypeList: Equal<
  (typeof POD_INPUT_TYPES)[number],
  PropertyInputType
> = true;
export const _displayAs: Equal<
  NonNullable<PodUIHints["displayAs"]>,
  PropertyDisplayAs
> = true;
