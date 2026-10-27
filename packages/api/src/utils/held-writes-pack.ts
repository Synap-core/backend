/**
 * The held-writes pack (W-B1): past its daily write ceiling (rung 2.56) an
 * agent's replayable writes are kept on ONE pending pack per (agent, UTC day)
 * instead of one proposal each. Filed by `fileHeldWrites`; approved by
 * the `agent/held_writes` executor, which replays each kept write.
 *
 * A leaf: it imports nothing. `permission-check.ts` re-exports it; a module
 * that only needs the pack's identity imports it from here, so it does not
 * pull the whole gate (and, through it, the channel routers) into its graph.
 */
export const HELD_WRITES_TARGET_TYPE = "agent";
export const HELD_WRITES_PROPOSAL_TYPE = "held_writes";
