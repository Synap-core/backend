/**
 * Compile-time contract: the pod's copy of the worker target edge role
 * (`@synap/database` `utils/worker-enablement.ts`, which cannot import this
 * package) is EXACTLY this package's, and the pod's worker node spec speaks
 * this package's size words, and the one result writer
 * (`utils/worker-target-result.ts`) speaks this package's result words. No runtime code. Change one side only and `tsc`
 * here fails.
 */
import type {
  WORKER_TARGET_LINK_ROLE,
  PlaybookRunWorkerSpec,
  WorkerTargetLinkResult,
} from "@synap/database";
import type {
  WORKER_TARGET_ROLE,
  WorkerSize,
  WorkerTargetResult,
} from "./index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export const _targetRole: Equal<
  typeof WORKER_TARGET_LINK_ROLE,
  typeof WORKER_TARGET_ROLE
> = true;
export const _size: Equal<PlaybookRunWorkerSpec["size"], WorkerSize> = true;
export const _result: Equal<WorkerTargetLinkResult, WorkerTargetResult> = true;
