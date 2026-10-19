/**
 * THE rule both Library doors (tRPC `library.*`, Hub REST `/library/*`) apply
 * (founder, 2026-10-13; widened 2026-10-18):
 *
 *   NOTHING AN AGENT SENDS LANDS IN THE LIBRARY; AN AGENT MAY PROPOSE HOW TO
 *   ORGANISE WHAT IS ALREADY THERE.
 *
 * An agent's words, links and files go to its own door, MCP `synap_capture`,
 * unchanged — every Library write (add, curate, readNow, build, runAction,
 * readWith, cancelReadWith, retryMedia) refuses it. Its ideas about the
 * Library's ORGANISATION (groups, their existing items, notes, the space a
 * group is built into, a build request) go to `library.propose` /
 * `POST /library/propose` / MCP `synap_organize_library` — always a governed
 * proposal (`library/organize`, `services/library/organize.ts`) the person
 * approves; nothing changes before.
 *
 * An agent caller = an agent API key (`agentUserId` set by the auth
 * middleware) or the Intelligence Service's internal key.
 */

import { TRPCError } from "@trpc/server";

export const AGENT_USE_CAPTURE = "AGENT_USE_CAPTURE" as const;

export const AGENT_USE_CAPTURE_MESSAGE =
  "The Library holds what a person keeps. An agent sends its words, links and files to synap_capture; it may propose how to organise the Library (synap_organize_library).";

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
