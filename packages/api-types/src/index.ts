/**
 * @synap-core/api-types
 *
 * Standalone type definitions for Synap tRPC API.
 *
 * The AppRouter type is extracted from @synap/api during build
 * and included in this package with no external dependencies.
 */

// Generated from @synap/api. The named run contracts let non-tRPC surfaces
// (Browser graph adapters, CLI JSON output, tests) share the exact runtime truth
// without re-declaring snapshots or step activity locally.
export type {
  AppRouter,
  AutomationStepActivityDetail,
  AutomationStepActivityItem,
  AutomationStepStatus,
  RunActivityItem,
  RunDefinitionSnapshot,
  RunPathTaken,
  UnifiedRunDetail,
} from "./generated.js";

// External connect contracts are backend-owned and shared with clients.
export type {
  RegistrationOutcome,
  RegistrationTrace,
  ExternalConnectErrorCode,
  ExternalConnectError,
  SetupAgentSuccess,
  ActivateAddonSuccess,
} from "@synap-core/types";

// Version stamp + runtime drift guard. A client pins a major; the pod reports
// `apiTypesVersion` in `GET /health`. `assertApiTypesCompatible()` warns/throws
// when the two diverge. See ./version.ts.
export {
  API_TYPES_VERSION,
  API_TYPES_MAJOR,
  majorOf,
  checkApiTypesCompatible,
  assertApiTypesCompatible,
} from "./version.js";
export type {
  ApiTypesCompatibility,
  AssertApiTypesOptions,
} from "./version.js";
