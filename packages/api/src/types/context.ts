/**
 * Context Types
 *
 * Proper type definitions for tRPC context to avoid `any` types.
 */

/**
 * Database client type
 *
 * Note: Using `any` here to preserve Drizzle's schema inference.
 * Attempting to use PostgresJsDatabase<any> loses the schema generic
 * and breaks db.query.tableName access patterns.
 */
export type DatabaseClient = any;

/**
 * Ory Kratos identity
 */
export interface KratosIdentity {
  id: string;
  traits: {
    email: string;
    name?: string;
    [key: string]: unknown;
  };
}

/**
 * Ory Kratos session
 */
export interface KratosSession {
  identity: KratosIdentity;
  active: boolean;
  expires_at?: string;
  authenticated_at?: string;
}

/**
 * User object (simplified from Kratos identity)
 */
export interface User {
  id: string;
  email: string;
  name?: string;
}

/**
 * Full tRPC context
 */
export interface Context {
  db: DatabaseClient;
  authenticated: boolean;
  userId?: string | null;
  user?: User | null;
  session?: KratosSession | null;
  req?: Request;
  socketIO?: any; // Socket.IO server instance (type: Server from 'socket.io')
  workspaceId?: string | null; // Workspace ID from X-Workspace-Id header
  /**
   * Project ID from the X-Project-Id header — the cross-cutting PROJECT lens,
   * orthogonal to the workspace lens. Optional narrowing only: it is intersected
   * with the user-access floor, so a stale/forged id can never widen access.
   * `undefined`/`null` = no project narrowing. See `AccessContext.projectLens`.
   */
  projectId?: string | null;
  workspaceRole?: string | null; // User's role in the workspace (set by workspaceProcedure)
  /**
   * Request source — "intelligence" when the request comes from the Intelligence Hub
   * via API key auth. Set automatically by api-key-auth middleware; never set by humans.
   */
  source?: string | null;
  /**
   * Hard flag — true only when authenticated via a hub-protocol scoped API key.
   * Cannot be spoofed by a human JWT session.
   */
  isHubProtocol?: boolean;
  /**
   * The authenticating API key's type (`user_pat` | `service` | `agent` | …) and
   * its workspace binding, threaded from api-key-auth middleware. They let the
   * hub-protocol tRPC surface apply the SAME service-key workspace confinement
   * (resolveConfinedWorkspace) the Hono REST door already applies. NOTE: identity
   * is NEVER relaxed on keyType — a `service` key is self-mintable on this pod
   * (setup.ts `/setup/service` Path 4), so it grants no impersonation right; see
   * `hub-protocol/guard.ts`.
   */
  keyType?: string | null;
  keyWorkspaceId?: string | null;
  /**
   * The agent user ID acting on behalf of this request, when the caller is an
   * AI agent (set from the hub-protocol key's `linkedUserId`). Drives the
   * governance membrane: when present, mutations route through
   * checkPermissionOrPropose (propose instead of auto-apply). Undefined for
   * operator/human-driven requests, which stay synchronous.
   */
  agentUserId?: string | null;
  /**
   * INTERNAL CHANNEL — never from a request. No context factory populates it
   * and there is no wire passthrough. **Keep it that way** — a ctx factory that
   * ever read this from a header or input would hand any caller an "assume my
   * write is already approved" primitive.
   *
   * ⚠️ CORRECTED 2026-09-07. This docblock previously said "set ONLY by
   * `applyProposalApproval`'s composite caller … it arrives solely from that
   * internal object literal." That was FALSE on the day it was written. There
   * are TWO producers, and the omission mattered because the field is read as a
   * security carve-out (below), so the comment understated where that carve-out
   * applies:
   *   · `routers/proposals/apply-approval.ts` — the approval composite caller.
   *   · `services/capture-agent/submit-capture-graph.ts` — the capture
   *     auto-apply composite caller (its existence is asserted by
   *     `__tripwires__/capture-graph-governance-linkage.test.ts`).
   *
   * THE INVARIANT, stated so a third producer knows what it is signing up to:
   * set this ONLY from an internal caller that has ALREADY obtained a
   * governance decision for the write it is about to make. It means "a decision
   * exists for this", not merely "an internal caller made this".
   *
   * Two load-bearing meanings:
   *  · PROVENANCE — stamped as `source_proposal_id`, the JOIN that recovers the
   *    APPROVER via `proposals.reviewedBy`.
   *  · "this write is ALREADY APPROVED" — `relations.create` reads it to skip
   *    re-entering the governance membrane. Without that skip the ladder falls
   *    to `propose` (relation.create is not in DEFAULT_AUTO_APPROVE) and the
   *    edge is silently never created while the receipt reports it linked.
   *
   * Declared here rather than cast at each reader: it was read through
   * `(ctx as { governanceProposalId?: string })` in seven places across three
   * files, one of which now guards the security fix above — so renaming the
   * field would have broken all seven with ZERO typecheck signal.
   */
  governanceProposalId?: string;
  /**
   * The message ID that triggered this hub-protocol request.
   * When set, proposals created during this request are linked to this message.
   */
  sourceMessageId?: string | null;
  /**
   * Session ID that triggered this hub-protocol request.
   * When set, proposals created during this request are linked to this session.
   */
  sessionId?: string | null;
}
