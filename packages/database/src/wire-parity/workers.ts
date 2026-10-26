/**
 * Compile-time contract: the pod's copy of the worker target edge role
 * (`utils/worker-enablement.ts`) is EXACTLY `@synap-core/types/workers`', the
 * worker node spec speaks that package's size words, and the one result writer
 * (`utils/worker-target-result.ts`) speaks its result words. No runtime code.
 * Change one side only and `tsc` here fails.
 */
import type {
  WORKER_TARGET_ROLE,
  WorkerSize,
  WorkerTargetResult,
} from "@synap-core/types/workers";
import type { PlaybookRunWorkerSpec } from "../schema/automations.js";
import type { WORKER_TARGET_LINK_ROLE } from "../utils/worker-enablement.js";
import type { WorkerTargetLinkResult } from "../utils/worker-target-result.js";
import type { Equal } from "./equal.js";

export const _targetRole: Equal<
  typeof WORKER_TARGET_LINK_ROLE,
  typeof WORKER_TARGET_ROLE
> = true;
export const _size: Equal<PlaybookRunWorkerSpec["size"], WorkerSize> = true;
export const _result: Equal<WorkerTargetLinkResult, WorkerTargetResult> = true;
