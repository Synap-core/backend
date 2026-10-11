/**
 * Compile-time contract: the pod's lifecycle model (`@synap/database`
 * `utils/lifecycle-model.ts`) is EXACTLY this package's. No runtime code.
 * Add a category or an option field on one side only and `tsc` here fails.
 */
import type {
  LIFECYCLE_CATEGORIES as POD_CATEGORIES,
  LifecycleCategory as PodCategory,
  LifecycleOption as PodOption,
} from "@synap/database";
import type {
  LIFECYCLE_CATEGORIES,
  LifecycleCategory,
  LifecycleOption,
} from "./index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export const _category: Equal<PodCategory, LifecycleCategory> = true;
export const _categoryOrder: Equal<
  typeof POD_CATEGORIES,
  typeof LIFECYCLE_CATEGORIES
> = true;
export const _option: Equal<PodOption, LifecycleOption> = true;
