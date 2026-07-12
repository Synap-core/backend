/**
 * Capture workspace routing — thin re-export.
 *
 * The pure decision + its types MOVED to @synap/database in Wave 1 (the
 * `WorkspaceResolutionService` door reaches the SAME gate without a second
 * copy, and @synap/jobs can't import @synap/api). Existing importers/tests keep
 * pulling `resolveCaptureRouting` from here unchanged.
 */
export {
  resolveCaptureRouting,
  type WorkspaceRoutingMode,
  type CaptureRoutingResult,
} from "@synap/database";
