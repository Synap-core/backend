/**
 * Compile-time contract: the pod's lifecycle model (`utils/lifecycle-model.ts`)
 * is EXACTLY `@synap-core/types/lifecycle`'s. No runtime code. Add a category
 * or an option field on one side only and `tsc` here fails.
 */
import type {
  LIFECYCLE_CATEGORIES,
  LifecycleCategory,
  LifecycleOption,
} from "@synap-core/types/lifecycle";
import type {
  LIFECYCLE_CATEGORIES as POD_CATEGORIES,
  LifecycleCategory as PodCategory,
  LifecycleOption as PodOption,
} from "../utils/lifecycle-model.js";
import type { Equal } from "./equal.js";

export const _category: Equal<PodCategory, LifecycleCategory> = true;
export const _categoryOrder: Equal<
  typeof POD_CATEGORIES,
  typeof LIFECYCLE_CATEGORIES
> = true;
export const _option: Equal<PodOption, LifecycleOption> = true;
