import { describe, expect, it } from "vitest";
import { ROUTE_CHOICE_META_KEY, readRouteChoice } from "./index.js";

const A = { agentUserId: "a", name: "Researcher" };
const B = { agentUserId: "b", name: "Writer" };

describe("readRouteChoice", () => {
  it("reads a well-formed choice", () => {
    expect(
      readRouteChoice({
        [ROUTE_CHOICE_META_KEY]: { triggerMessageId: "m1", candidates: [A, B] },
      })
    ).toEqual({ triggerMessageId: "m1", candidates: [A, B] });
  });

  it("a nameless candidate still gets a chip label", () => {
    expect(
      readRouteChoice({
        routeChoice: { triggerMessageId: "m1", candidates: [A, { agentUserId: "b" }] },
      })?.candidates[1]
    ).toEqual({ agentUserId: "b", name: "Agent" });
  });

  it("anything malformed is no chip at all", () => {
    expect(readRouteChoice(null)).toBeNull();
    expect(readRouteChoice({})).toBeNull();
    expect(readRouteChoice({ routeChoice: { candidates: [A, B] } })).toBeNull();
    expect(
      readRouteChoice({ routeChoice: { triggerMessageId: "m1", candidates: [A, { name: "x" }] } })
    ).toBeNull();
    // One candidate is not a choice.
    expect(
      readRouteChoice({ routeChoice: { triggerMessageId: "m1", candidates: [A] } })
    ).toBeNull();
  });

  it("an answered choice names the agent that answers", () => {
    expect(
      readRouteChoice({
        routeChoice: { triggerMessageId: "m1", candidates: [A, B], answeredAgentUserId: "b" },
      })
    ).toEqual({ triggerMessageId: "m1", candidates: [A, B], answeredAgentUserId: "b" });
    // An answer naming no candidate is not trusted.
    expect(
      readRouteChoice({
        routeChoice: { triggerMessageId: "m1", candidates: [A, B], answeredAgentUserId: "zzz" },
      })
    ).toEqual({ triggerMessageId: "m1", candidates: [A, B] });
  });
});
