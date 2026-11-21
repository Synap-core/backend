/**
 * Approvals › By tool (lane W3): the agents × tools grid, rendered from the
 * rows' grid model. Pinned: every AI and each agent are rows, each tool a
 * column and a door to its page, a cell's mark is its rows' verdict
 * ("Mixed" when they differ), an empty cell follows every AI.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  toolIndex,
  toolsGrid,
  type ToolRuleRow,
} from "../../../../lib/governance-rules/tool-approvals-model";
import { ToolsGridView } from "./tools-grid";

const TOOL = "cap-apify";
const AGENT = "agent-1";
const index = toolIndex(
  [
    {
      id: TOOL,
      name: "Apify",
      verbs: [
        { verbId: "apify_run_actor", skillId: null },
        { verbId: "apify_linkedin_profile", skillId: null },
      ],
    },
    {
      id: "cap-gmail",
      name: "Gmail",
      verbs: [{ verbId: "gmail_send", skillId: null }],
    },
  ],
  []
);
let seq = 0;
const row = (over: Partial<ToolRuleRow & { agentLabel: string }>) =>
  ({
    id: `r${++seq}`,
    principalKind: "any",
    agentUserId: null,
    agentLabel: null,
    principalClass: null,
    scopeKind: "pod",
    workspaceId: null,
    targetKind: "capability",
    targetPattern: TOOL,
    targetProfile: null,
    verdict: "auto",
    sourceProposalId: null,
    ...over,
  }) as ToolRuleRow;

const render = (rows: ToolRuleRow[]) =>
  renderToStaticMarkup(
    <ToolsGridView
      grid={toolsGrid(rows, index)}
      toolName={() => null}
      listHref={(a) => `/approvals?agent=${a}`}
    />
  );

describe("Approvals › By tool", () => {
  it("draws who × tool, every name a door", () => {
    const html = render([
      row({ verdict: "auto" }),
      row({
        principalKind: "agent",
        agentUserId: AGENT,
        agentLabel: "Scout",
        targetPattern: "gmail_send",
        verdict: "deny",
      }),
    ]);
    expect(html).toContain("data-tools-grid");
    expect(html).toContain(`href="/open/capability/${TOOL}"`);
    expect(html).toContain('href="/open/capability/cap-gmail"');
    expect(html).toContain(`href="/agents/${AGENT}"`);
    expect(html).toContain("Every AI");
    expect(html).toContain('data-grid-cell="auto"');
    expect(html).toContain('data-grid-cell="never"');
    // Scout has no row on Apify: that cell follows every AI.
    expect(html).toContain('data-grid-cell="none"');
  });

  it("rows that differ in one cell are Mixed", () => {
    const html = render([
      row({ targetPattern: "apify_run_actor", verdict: "auto" }),
      row({ targetPattern: "apify_linkedin_profile", verdict: "propose" }),
    ]);
    expect(html).toContain('data-grid-cell="mixed"');
    expect(html).toContain("Mixed");
  });

  it("no row names a tool: says so, never an empty table", () => {
    const html = render([
      row({ targetKind: "action", targetPattern: "entity.create" }),
    ]);
    expect(html).toContain("data-tools-grid-empty");
    expect(html).not.toContain("data-tools-grid=");
  });
});
