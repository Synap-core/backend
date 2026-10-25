/**
 * Compile-time contract: the proposal row `@synap-core/types/proposals/row`
 * declares (and this package re-exports as `Proposal`) matches the
 * `proposals` table, and its `ProposalStatus` is EXACTLY the runtime
 * `ProposalStatus` const the pod writes. No runtime code.
 *
 * `Proposal` is an explicit interface, not the inferred row: it declares a
 * subset of the columns. `_proposalColumns` proves every declared field has
 * the column's exact type; `_proposalWithheld` names the columns the wire does
 * NOT carry, so a new column is classified here (carried or withheld) before
 * the build passes.
 */
import type { ProposalStatus as WireProposalStatus } from "@synap-core/types/proposals/row";
import type {
  Proposal,
  ProposalStatus,
  proposals,
} from "../schema/proposals.js";
import type { Equal } from "./equal.js";

type ProposalColumns = typeof proposals.$inferSelect;

/** Columns the wire `Proposal` does not carry. */
type ProposalWithheld = never;

export const _proposalStatus: Equal<ProposalStatus, WireProposalStatus> = true;
export const _proposalColumns: Equal<
  Pick<ProposalColumns, keyof Proposal & keyof ProposalColumns>,
  Proposal
> = true;
export const _proposalWithheld: Equal<
  Exclude<keyof ProposalColumns, keyof Proposal>,
  ProposalWithheld
> = true;
