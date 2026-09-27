/**
 * Compile-time contract: the pod's uiHints unions (`@synap/database`
 * `schema/property-defs.ts`) are EXACTLY this package's. No runtime code.
 *
 * The pod keeps its own declaration because it cannot import this package;
 * this file is what makes that second copy safe. Add a member on one side only
 * and `tsc` here fails.
 */
import type {
  PROPERTY_INPUT_TYPES as POD_INPUT_TYPES,
  PropertyInputType as PodInputType,
  PropertyUIHints as PodUIHints,
} from "@synap/database";
import type { PropertyDisplayAs, PropertyInputType } from "./index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export const _inputTypes: Equal<PodInputType, PropertyInputType> = true;
export const _inputTypeList: Equal<
  (typeof POD_INPUT_TYPES)[number],
  PropertyInputType
> = true;
export const _displayAs: Equal<
  NonNullable<PodUIHints["displayAs"]>,
  PropertyDisplayAs
> = true;
