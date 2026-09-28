/**
 * Rank a verb from what already happened. Reliability is delivered runs over
 * delivered + provider errors. A rejection is the person saying no — it is
 * reported beside the score and does not enter it. Nothing here is read by
 * `decideAgentPolicy`.
 */
export function scoreCapabilityVerb(input: {
  delivered: number;
  errors: number;
  rejected: number;
}): {
  calls: number;
  failures: number;
  rejections: number;
  reliability: number | null;
} {
  const calls = input.delivered + input.errors;
  return {
    calls,
    failures: input.errors,
    rejections: input.rejected,
    reliability: calls === 0 ? null : input.delivered / calls,
  };
}
