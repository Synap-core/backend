/**
 * C7 part 1 (plan d679e92c): a session started for ANOTHER agent, or a
 * teammate's planned sub-session of the conversation's own session, is never
 * bound to the calling conversation — that stamp is what re-bound the lead's
 * writes to its lanes (finding 06f4bc12).
 *
 * Each fixture rules out one candidate rule:
 *   - "always stamp" (the defect)     → the agentIds and the lane fixtures;
 *   - "never stamp a child"           → the detour fixture (a detour keeps it)
 *     and the child-of-another-conversation fixture;
 *   - "agentIds present ⇒ no stamp"   → the agentIds-is-the-caller fixture.
 */
import { describe, it, expect } from "vitest";
import {
  decideNewSessionClientKey,
  startedForAnotherAgent,
} from "./session-client-binding.js";

const LEAD = "key:k1|conv:claude-code:lead";
const AGENT = "agent-1";

describe("decideNewSessionClientKey", () => {
  it("a plain start is bound to the conversation", () => {
    expect(
      decideNewSessionClientKey({ clientKey: LEAD, agentUserId: AGENT })
    ).toBe(LEAD);
  });

  it("a session started for ANOTHER agent is not", () => {
    expect(
      decideNewSessionClientKey({
        clientKey: LEAD,
        agentUserId: AGENT,
        agentIds: ["agent-2"],
      })
    ).toBeNull();
  });

  it("naming only the caller in agentIds still binds", () => {
    expect(
      decideNewSessionClientKey({
        clientKey: LEAD,
        agentUserId: AGENT,
        agentIds: [AGENT],
      })
    ).toBe(LEAD);
  });

  it("a teammate's lane (planned child of this conversation's session) is not", () => {
    expect(
      decideNewSessionClientKey({
        clientKey: LEAD,
        agentUserId: AGENT,
        parentSessionId: "wave",
        parentClientKey: LEAD,
      })
    ).toBeNull();
  });

  it("a DETOUR of this conversation's session keeps the binding", () => {
    expect(
      decideNewSessionClientKey({
        clientKey: LEAD,
        agentUserId: AGENT,
        parentSessionId: "wave",
        suspendedIntent: "finish the migration first",
        parentClientKey: LEAD,
      })
    ).toBe(LEAD);
  });

  it("a child of ANOTHER conversation's session is bound to this one", () => {
    expect(
      decideNewSessionClientKey({
        clientKey: LEAD,
        agentUserId: AGENT,
        parentSessionId: "other",
        parentClientKey: "key:k1|conv:claude-code:other",
      })
    ).toBe(LEAD);
  });

  it("no conversation key, nothing to stamp", () => {
    expect(
      decideNewSessionClientKey({ clientKey: undefined, agentUserId: AGENT })
    ).toBeNull();
  });
});

describe("startedForAnotherAgent", () => {
  it("reads only ids other than the caller", () => {
    expect(startedForAnotherAgent(undefined, AGENT)).toBe(false);
    expect(startedForAnotherAgent([AGENT], AGENT)).toBe(false);
    expect(startedForAnotherAgent([AGENT, "agent-2"], AGENT)).toBe(true);
  });
});
