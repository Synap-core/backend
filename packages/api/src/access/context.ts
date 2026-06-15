/**
 * AccessContext — the normalized identity an access decision is made against.
 *
 * Both API boundaries converge here, and ONLY here:
 *   - `AccessContext.operator(ctx)` — the operator/UI surface (tRPC, Kratos cookie)
 *   - `AccessContext.agent(ctx)`    — the AI surface (Hub Protocol, agent API key)
 *
 * The constructor is private, so an AccessContext can only be minted by one of
 * the two boundary factories after they've read an *authenticated* context.
 *
 * Design intent (the separation rule): the visibility + governance DECISION is
 * identity-agnostic and shared; the two factories are the only overlap between
 * the UI and AI surfaces and they merely *normalize* each boundary's already-
 * authenticated context into one object. They do NOT merge the two auth
 * mechanisms (cookie vs API key) — those stay entirely separate upstream.
 *
 * SCOPE TODAY: the read path (ScopedDb) consumes only `userId` — operator and
 * agent are scoped identically (workspaces are lenses; filter by user). The
 * `actor` / `agentUserId` discriminator below is therefore PROVISIONAL: it
 * exists so the AI write gate can one day take an AccessContext and trust the
 * "is this an AI action?" bit. That integration does NOT exist yet
 * (checkPermissionOrPropose still takes its own opts bag). Until it lands, keep
 * the discriminator minimal — don't grow it without a consumer.
 * TODO(write-gate): route checkPermissionOrPropose through AccessContext so the
 * discriminator is consumed, and thread agentUserId into the hub caller context
 * (createHubProtocolCallerContext) — today the delegated hub ctx sets
 * isHubProtocol but not agentUserId, so a hub read resolves actor="operator".
 */

export type Actor = "operator" | "agent";

export class AccessContext {
  private constructor(
    /** The human whose data is in scope (attribution owner on AI actions). */
    readonly userId: string,
    /** Set iff a confirmed AI agent is the actor; the agent's user id. */
    readonly agentUserId: string | undefined,
    /** "operator" (human/UI) or "agent" (AI/Hub Protocol). */
    readonly actor: Actor,
    /**
     * The active workspace LENS, or `undefined` for the pod-wide (user-wide)
     * view. The user floor is ALWAYS applied regardless; the lens only narrows
     * (see `workspaceLensWhere`). 3-state: `undefined` = all my workspaces +
     * globals · `null` = globals only · `"<id>"` = that workspace + globals.
     */
    readonly workspaceLens: string | null | undefined = undefined
  ) {}

  /** Operator/UI boundary — built from the tRPC context (Kratos cookie). */
  static operator(ctx: { userId?: string | null }): AccessContext {
    if (!ctx.userId) {
      throw new Error(
        "AccessContext.operator: called without an authenticated userId"
      );
    }
    return new AccessContext(ctx.userId, undefined, "operator");
  }

  /** AI boundary — built from the Hub Protocol context (agent API key). */
  static agent(ctx: {
    userId?: string | null;
    agentUserId?: string | null;
  }): AccessContext {
    if (!ctx.userId) {
      throw new Error(
        "AccessContext.agent: called without an authenticated userId"
      );
    }
    const agentUserId = ctx.agentUserId ?? undefined;
    // Mirror checkPermissionOrPropose: the AI-governance ladder only fires when
    // a confirmed agentUserId is present, so the actor is "agent" only then.
    return new AccessContext(
      ctx.userId,
      agentUserId,
      agentUserId ? "agent" : "operator"
    );
  }

  /**
   * Convergence point — pick the right factory from a request Context. This is
   * the ONE place the two boundaries meet: `isHubProtocol` is a hard,
   * non-spoofable flag set only by the agent-key auth middleware, so it cleanly
   * routes to the agent factory; everything else is an operator. Read scoping
   * is identical either way (both carry a userId).
   */
  static from(ctx: {
    userId?: string | null;
    agentUserId?: string | null;
    isHubProtocol?: boolean;
  }): AccessContext {
    return ctx.isHubProtocol
      ? AccessContext.agent(ctx)
      : AccessContext.operator(ctx);
  }

  /**
   * Return a copy narrowed to a workspace lens (from `X-Workspace-Id` / an
   * explicit request param). Opt-in: a context with no lens stays user-wide, so
   * existing scopedDb consumers are unchanged. Pass `undefined` for user-wide,
   * `null` for globals-only, a workspace id to narrow to it (+ globals).
   */
  withLens(workspaceLens: string | null | undefined): AccessContext {
    return new AccessContext(
      this.userId,
      this.agentUserId,
      this.actor,
      workspaceLens
    );
  }

  /** True iff a confirmed agentUserId is present (NOT merely "came via hub"). */
  get isAgent(): boolean {
    return this.actor === "agent";
  }
}
