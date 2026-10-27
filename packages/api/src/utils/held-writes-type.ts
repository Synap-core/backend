/**
 * The held-writes pack's proposal type, in a module with no imports: the
 * session-content redaction reads it, and importing it from
 * `permission-check.ts` pulled that whole graph (post-message → channels
 * helpers → message-anchor) into the redaction and closed an import cycle.
 */
export const HELD_WRITES_PROPOSAL_TYPE = "held_writes";
