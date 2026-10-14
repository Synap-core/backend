/**
 * THE rule both Library doors (tRPC `library.*`, Hub REST `/library/*`) apply:
 * nothing an AGENT sends lands in the Library (founder, 2026-10-13). An agent's
 * words, links and files go to its own door, MCP `synap_capture`, unchanged.
 *
 * An agent caller = an agent API key (`agentUserId` set by the auth
 * middleware) or the Intelligence Service's internal key.
 */

import { TRPCError } from "@trpc/server";

export const AGENT_USE_CAPTURE = "AGENT_USE_CAPTURE" as const;

export const AGENT_USE_CAPTURE_MESSAGE =
  "The Library holds what a person keeps. An agent sends its words, links and files to synap_capture.";

export function isAgentCaller(caller: {
  agentUserId?: string | null;
  keyType?: string | null;
}): boolean {
  return Boolean(caller.agentUserId) || caller.keyType === "is_internal";
}

/** Throws FORBIDDEN (`reasonCode: AGENT_USE_CAPTURE`) for an agent caller. */
export function refuseAgent(caller: {
  agentUserId?: string | null;
  keyType?: string | null;
}): void {
  if (isAgentCaller(caller)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: AGENT_USE_CAPTURE_MESSAGE,
      cause: { reasonCode: AGENT_USE_CAPTURE },
    });
  }
}
