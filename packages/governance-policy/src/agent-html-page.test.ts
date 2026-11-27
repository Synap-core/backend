import { describe, it, expect } from "vitest";
import { PROPOSE_REASON, decideAgentPolicy, writesHtmlPage } from "./index.js";

/**
 * Decision D1 default (surfaces review, 27 Nov 2026): an agent's executable
 * HTML page is floored at rung 2.09 whatever door it comes through, as
 * `cell/create` is, and the pod's `@agent-builds-structure` switch does not
 * yield it (it does not yield `cell/create` either).
 *
 * WHAT THIS DOES NOT COVER: that the gate passes the fact (the api test
 * `permission-check.agent-html-page.pglite.test.ts` does).
 */

const FLOORED = {
  verdict: "propose",
  reason: PROPOSE_REASON.AGENT_STRUCTURE_WRITE,
  reasonCode: "AGENT_STRUCTURE_WRITE",
} as const;

describe("writesHtmlPage — the one classification", () => {
  it("names the three html doors", () => {
    expect(writesHtmlPage("document", "create", { type: "html" })).toBe(true);
    expect(writesHtmlPage("surface", "create", { body: "html" })).toBe(true);
    expect(
      writesHtmlPage("whiteboard", "place", {
        resources: [{ kind: "entity" }, { kind: "html", html: "<p/>" }],
      })
    ).toBe(true);
    expect(
      writesHtmlPage("whiteboard", "place", {
        resources: [{ kind: "artboard-deck", slides: [] }],
      })
    ).toBe(true);
  });

  it("and nothing else", () => {
    expect(writesHtmlPage("document", "create", { type: "markdown" })).toBe(
      false
    );
    expect(writesHtmlPage("document", "update", { type: "html" })).toBe(false);
    expect(writesHtmlPage("surface", "create", { body: "view" })).toBe(false);
    expect(
      writesHtmlPage("whiteboard", "place", { resources: [{ kind: "entity" }] })
    ).toBe(false);
    expect(writesHtmlPage("document", "create", undefined)).toBe(false);
  });
});

describe("rung 2.09 (page) — an agent's html page always proposes", () => {
  it("no rule, wildcard, ownership or switch widens it", () => {
    const pair = { subjectType: "document", action: "create" };
    expect(decideAgentPolicy({ ...pair, agentHtmlPage: true })).toEqual(
      FLOORED
    );
    expect(
      decideAgentPolicy({
        ...pair,
        agentHtmlPage: true,
        governanceRuleVerdict: "auto",
        isAgentOwnedWorkspace: true,
        autoApproveFor: ["document.*", "*"],
        floorsYield: { agentBuildsStructure: true },
      })
    ).toEqual(FLOORED);
  });

  it("control: the same write without the fact follows its rule", () => {
    expect(
      decideAgentPolicy({
        subjectType: "document",
        action: "create",
        governanceRuleVerdict: "auto",
      }).verdict
    ).toBe("execute");
  });
});
