/**
 * The reach words: one set, said by the marketplace preflight and by every
 * review surface of a part that acts on its own. "Could not tell" is never
 * said as "reaches nothing".
 */
import { describe, expect, it } from "vitest";
import { canReachLine, existingConnections, partReachWords } from "../reach.js";

describe("partReachWords", () => {
  it("names the hosts and the connections it uses", () => {
    expect(
      partReachWords({
        hosts: ["api.apify.com"],
        connections: ["Apify"],
        unreadSteps: 0,
      })
    ).toBe("api.apify.com, your existing Apify connection");
  });

  it("a measured part that reaches nothing says so", () => {
    expect(partReachWords({ hosts: [], connections: [], unreadSteps: 0 })).toBe(
      "Nothing outside your pod"
    );
  });

  it("a step it could not read is never 'nothing'", () => {
    expect(partReachWords({ hosts: [], connections: [], unreadSteps: 2 })).toBe(
      "Not known for 2 steps"
    );
    expect(
      partReachWords({ hosts: ["a.example"], connections: [], unreadSteps: 1 })
    ).toBe("a.example; not known for 1 step");
  });
});

describe("the preflight's words", () => {
  it("one line of hosts, one phrase of connections", () => {
    expect(canReachLine(["api.acme.test", "hooks.acme.test"])).toBe(
      "Can reach: api.acme.test, hooks.acme.test"
    );
    expect(existingConnections(["Gmail", "Notion", "Slack"], "my")).toBe(
      "my existing Gmail, Notion and Slack connections"
    );
  });
});
