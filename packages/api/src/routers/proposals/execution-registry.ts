/**
 * Proposal Execution Registry
 *
 * Singleton registry that maps a proposal's `${targetType}/${proposalType}` key
 * to the executor that materializes it on approval. Mirrors the
 * `@synap-core/event-renderer` registry: the type strings ARE the classification
 * key — no predicate matching needed.
 *
 * Resolution order (the caller does the two-step lookup, same precedence as the
 * old top-down if-chain):
 *   1. Exact composite key match     — `resolve("entity/create")`
 *   2. proposalType-only fallback    — `resolve("messaging.external.send")`
 *   3. Wildcard catch-all (key "* /*", written without the space) — generic path
 *   4. undefined                     — caller throws NOT_IMPLEMENTED (now ONLY
 *      truly-unregistered keys, no longer a silent forgotten-branch)
 *
 * Registration happens at module load (see registerApproveExecutors in
 * proposals.ts). Each executor's body is the verbatim former approve branch, so
 * behaviour — returns, events, ordering, idempotency — is identical.
 */

import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import type { Context } from "../../context.js";
import type {
  StoredProposalData,
  ProposalMaterializedRecord,
} from "@synap-core/types";
import type { PropertyDecisionMap } from "@synap/database";

const logger = createLogger({ module: "proposal-execution-registry" });

type ProposalRow = {
  id: string;
  targetType: string;
  targetId: string;
  proposalType: string;
  workspaceId: string | null;
  sessionId: string | null;
  projectId: string | null;
  agentUserId: string | null;
  sourceMessageId: string | null;
  data: unknown;
};

/**
 * Dependency bag handed to every executor. proposals.ts owns these (module-scope
 * helpers, router callers, db) and passes them in — keeping executor bodies
 * verbatim while avoiding a circular import back into the router module.
 */
export interface ProposalExecutorDeps {
  db: unknown;
  // Helpers (verbatim references from proposals.ts)
  emitProposalReviewed: (
    proposalId: string,
    workspaceId: string | null | undefined,
    status: "approved" | "rejected",
    userId?: string
  ) => void;
  reportProposalOutcome: (params: {
    proposalId: string;
    outcome: "approved" | "rejected";
    sourceMessageId: string | null | undefined;
    agentUserId: string | null | undefined;
    targetType: string | null | undefined;
    proposalType?: string | null | undefined;
    source?: string | null | undefined;
    rejectionReason?: string | null | undefined;
  }) => void;
  stampProjectMembership: (
    proposal: {
      projectId: string | null;
      sessionId: string | null;
      workspaceId: string | null;
    },
    entityIds: string[],
    userId: string
  ) => Promise<void>;
  resolveMessagingAccountForPlatform: (
    userId: string,
    platform?: string
  ) => Promise<{ id: string } | null>;
  /** Anything else an executor needs that is cheaper to inject than re-import. */
  [key: string]: unknown;
}

export interface ProposalExecutorArgs {
  proposal: ProposalRow;
  payload: StoredProposalData | null | undefined;
  userId: string;
  input: {
    proposalId: string;
    comment?: string;
    /**
     * Optional per-field property-reconciliation decisions, keyed by proposed
     * property key. Honored ONLY by the `entity/create` and `entity/update`
     * executors (single-entity). Absent ⇒ defaults apply (matched→keep,
     * high-confidence fuzzy→remap, otherwise→keep-as-new + create def).
     */
    propertyDecisions?: PropertyDecisionMap;
    /**
     * Approve-time FACET channel (single-entity path). `facets` is the
     * caller-NAMED list of facets to attach to the created entity — attached
     * verbatim, no default/eligibility logic. Honored by the `entity/create`
     * executor; other executors ignore it.
     */
    facets?: Array<{ profileSlug: string; status?: string }>;
  };
  ctx: Context;
  deps: ProposalExecutorDeps;
}

/** The shape every approve branch returns today (superset — branches set a subset). */
export interface ProposalExecutorResult {
  success: boolean;
  alreadyApproved?: boolean;
  primaryId?: string;
  created?: number;
  linked?: number;
}

export interface ProposalExecutor {
  /** Exact `${targetType}/${proposalType}`, a proposalType-only key, or trailing-`*` wildcard. */
  key: string;
  execute(args: ProposalExecutorArgs): Promise<ProposalExecutorResult>;
}

class ProposalExecRegistryClass {
  private exact = new Map<string, ProposalExecutor>();
  private wildcards: Array<{ pattern: RegExp; ref: ProposalExecutor }> = [];

  /**
   * Register an executor.
   *
   * The key may include wildcards (same matcher as the event-renderer registry):
   *   - a TRAILING `*` (key ends with `*`) → matches one-or-more segments.
   *   - an INTERIOR `*` → matches exactly one path segment.
   * Later exact registrations overwrite earlier ones.
   */
  register(ref: ProposalExecutor): void {
    if (ref.key.includes("*")) {
      const escaped = ref.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const expanded = escaped
        .replace(/\\\*$/, ".+") // trailing wildcard → any depth
        .replace(/\\\*/g, "[^/]+"); // interior wildcard → one segment
      const pattern = new RegExp(`^${expanded}$`);
      const existingIdx = this.wildcards.findIndex(
        (w) => w.pattern.source === pattern.source
      );
      if (existingIdx !== -1) this.wildcards.splice(existingIdx, 1);
      this.wildcards.push({ pattern, ref });
    } else {
      this.exact.set(ref.key, ref);
    }
  }

  /** Exact-map lookup ONLY (no wildcard fallback). */
  resolveExact(key: string): ProposalExecutor | undefined {
    return this.exact.get(key);
  }

  /** Wildcard-only lookup (first registered pattern that matches wins). */
  resolveWildcard(key: string): ProposalExecutor | undefined {
    for (const { pattern, ref } of this.wildcards) {
      if (pattern.test(key)) return ref;
    }
    return undefined;
  }

  // Resolve with the FULL precedence the approve mutation needs, replicating the
  // old top-down if-chain order:
  //   1. exact composite targetType/proposalType  (e.g. "entity/create")
  //   2. exact proposalType-only key              (e.g. "messaging.external.send")
  //   3. wildcard catch-all                       (the */* generic path)
  //
  // Crucially, BOTH exact lookups run before any wildcard — so a proposalType-only
  // executor is never shadowed by the catch-all.
  resolve(
    compositeKey: string,
    proposalTypeKey?: string
  ): ProposalExecutor | undefined {
    const composite = this.exact.get(compositeKey);
    if (composite) return composite;
    if (proposalTypeKey) {
      const byType = this.exact.get(proposalTypeKey);
      if (byType) return byType;
    }
    return this.resolveWildcard(compositeKey);
  }

  /** All registered executors (debugging / docs). */
  getAll(): ProposalExecutor[] {
    return [...this.exact.values(), ...this.wildcards.map((w) => w.ref)];
  }

  /** Clear all registrations (only for testing). */
  _reset(): void {
    this.exact.clear();
    this.wildcards = [];
  }
}

export const proposalExecRegistry = new ProposalExecRegistryClass();

/** Convenience: register an executor against the singleton. */
export function registerProposalExecutor(ref: ProposalExecutor): void {
  proposalExecRegistry.register(ref);
}

/**
 * Resolve + run the executor for ONE proposal — the shared dispatch tail that
 * BOTH approve doors (`proposals.approve` and `proposals.batchApprove`) go
 * through. It lives here rather than in proposals.ts because it is pure
 * registry mechanics with no db/router dependency: the caller injects the
 * APPROVAL_FAILED write via `onApprovalFailed`, which also makes the dispatch
 * unit-testable without booting the router.
 *
 * Why it exists: `batchApprove` used to inline only the generic
 * `.validated`-emit path and never resolved an executor at all, so "Approve
 * all" was a silent no-op for every proposal type whose subject the
 * materializer has no case for. One implementation, two callers — a second
 * copy is what drifted in the first place.
 *
 * Semantics (verbatim from the former single-approve dispatch):
 *   - unregistered key → NOT_IMPLEMENTED (rare: the catch-all matches anything
 *     request-shaped, and itself throws NOT_IMPLEMENTED otherwise)
 *   - executor throws  → `onApprovalFailed` records the terminal failure, then
 *     the error is RE-THROWN so the caller still sees it. Never swallowed —
 *     a silently-failing item is the exact bug this fix closes.
 *   - idempotency      → owned by each executor's already-APPROVED guard.
 */
export async function dispatchProposalApproval(
  args: ProposalExecutorArgs,
  onApprovalFailed: (proposalId: string, errorMessage: string) => Promise<void>
): Promise<ProposalExecutorResult> {
  const executor = proposalExecRegistry.resolve(
    `${args.proposal.targetType}/${args.proposal.proposalType}`,
    args.proposal.proposalType ?? ""
  );

  if (!executor) {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: `Proposal approval for type '${args.proposal.targetType}' is not yet implemented`,
    });
  }

  try {
    return await executor.execute(args);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        proposalId: args.input.proposalId,
        targetType: args.proposal.targetType,
        proposalType: args.proposal.proposalType,
        err: errorMessage,
      },
      "proposal approval failed"
    );
    const safe =
      err instanceof TRPCError
        ? err.message
        : "Couldn't apply — an internal error occurred.";
    await onApprovalFailed(args.input.proposalId, safe);
    throw err;
  }
}

// Re-export commonly-needed types for executor modules.
export type { StoredProposalData, ProposalMaterializedRecord, ProposalRow };
