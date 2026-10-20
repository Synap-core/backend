import { TRPCError } from "@trpc/server";

interface CallerShape {
  session?: unknown;
  keyType?: unknown;
  agentUserId?: unknown;
  isHubProtocol?: unknown;
}

/**
 * A person in their own session (cookie or session token) — never a key: an
 * agent key, a computer key, a person's own API key or a Hub Protocol call is
 * not one.
 */
export function isSignedInPerson(ctx: CallerShape): boolean {
  return Boolean(
    ctx.session && !ctx.keyType && !ctx.agentUserId && !ctx.isHubProtocol
  );
}

/**
 * {@link isSignedInPerson}, or FORBIDDEN with `message` saying what to do
 * instead.
 */
export function assertSignedInPerson(ctx: CallerShape, message: string): void {
  if (!isSignedInPerson(ctx))
    throw new TRPCError({ code: "FORBIDDEN", message });
}
