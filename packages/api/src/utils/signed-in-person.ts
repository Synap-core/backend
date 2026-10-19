import { TRPCError } from "@trpc/server";

/**
 * A person in their own session (cookie or session token) — never a key: an
 * agent key, a computer key, a person's own API key or a Hub Protocol call is
 * FORBIDDEN, with `message` saying what to do instead.
 */
export function assertSignedInPerson(
  ctx: {
    session?: unknown;
    keyType?: unknown;
    agentUserId?: unknown;
    isHubProtocol?: unknown;
  },
  message: string
): void {
  if (!ctx.session || ctx.keyType || ctx.agentUserId || ctx.isHubProtocol)
    throw new TRPCError({ code: "FORBIDDEN", message });
}
