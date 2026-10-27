/**
 * The grant grammar — declared ONCE in `@synap-core/types/grants`
 * (`packages/types/src/grants/grammar.ts`, with its docs and its tests) and
 * re-exported here, so the engine and every door keep importing it from
 * `@synap/governance-policy/grants`. Pure — no I/O.
 */
export {
  QUALIFIED_GRANT_SUBJECTS,
  GRANT_ACTIONS,
  GRANT_GATE_ACTIONS,
  type GrantScope,
  isNarrowedScope,
  type GrantRequest,
  InvalidPermissionError,
  parsePermission,
  requestSegments,
  patternMatches,
  permits,
  allowedQualifiers,
  assertPermissions,
  DEFAULT_KEY_TTL_DAYS,
  resolveKeyExpiry,
} from "@synap-core/types/grants";
