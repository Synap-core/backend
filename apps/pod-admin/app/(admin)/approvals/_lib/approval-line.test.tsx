/**
 * Every approval on Approvals can be taken back, and says where it came from
 * (decision b387ca45 D5). Rendered (react-dom/server) from rows stamped the
 * way each writer stamps them, one per origin, so the assertion is on what
 * the row DRAWS: a Take back button, or the door to where it is changed
 * (the switch, the agent's page), or the approval a computer's copy goes
 * with. Not covered: that the revoke the button opens succeeds (the pod's
 * `governanceRules.revoke`, tested with the router).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/approvals",
}));

import { ApprovalLine } from "./approval-line";
import {
  ORIGIN_KEYS,
  type ApprovalRowLike,
} from "../../../../lib/governance-rules/approvals-model";

function row(over: Partial<ApprovalRowLike> = {}): ApprovalRowLike {
  return {
    id: "r1",
    principalKind: "agent",
    agentUserId: "ag-1",
    agentLabel: "Claude",
    principalClass: null,
    scopeKind: "workspace",
    workspaceId: "ws-1",
    targetKind: "capability",
    targetPattern: "apify_linkedin_profile",
    targetProfile: null,
    verdict: "auto",
    sourceProposalId: null,
    createdBy: "user:person-1",
    ...over,
  };
}

const ROWS: Record<(typeof ORIGIN_KEYS)[number], ApprovalRowLike> = {
  request: row({ sourceProposalId: "pr-1" }),
  playbook: row({
    targetKind: "action",
    targetPattern: "playbook.run",
    targetSubjectId: "pb-1",
  }),
  "pod-default": row({
    principalKind: "any",
    agentUserId: null,
    scopeKind: "pod",
    workspaceId: null,
    targetKind: "action",
    targetPattern: "@reversible",
  }),
  posture: row({ createdBy: "system:settings-mirror:person-1" }),
  computer: row({ createdBy: "system:host-seed:rule-9" }),
  "tool-page": row({
    principalKind: "any",
    agentUserId: null,
    scopeKind: "pod",
    workspaceId: null,
  }),
  person: row(),
  pod: row({ createdBy: "system:governance-backfill" }),
  unknown: row({ createdBy: "legacy" }),
};

const render = (r: ApprovalRowLike) =>
  renderToStaticMarkup(
    <ApprovalLine
      row={r}
      title="A title"
      where="A space"
      onTakeBack={() => {}}
    />
  );

/** The ways back a row can draw, as they appear in the markup. */
const WAYS_BACK = [
  />Take back</,
  />Change the switch</,
  />Change on its page</,
  />Its approval</,
];

describe("ApprovalLine", () => {
  it("draws a way back on every origin", () => {
    for (const key of ORIGIN_KEYS) {
      const out = render(ROWS[key]);
      expect(
        WAYS_BACK.some((re) => re.test(out)),
        `${key}: ${out}`
      ).toBe(true);
    }
  });

  it("says where every row came from", () => {
    for (const key of ORIGIN_KEYS) {
      expect(render(ROWS[key]), key).toContain("From:");
    }
  });

  it("makes the origin a door when the thing it came from has a page", () => {
    expect(render(ROWS.request)).toContain('href="/proposal/pr-1"');
    expect(render(ROWS.playbook)).toContain('href="/processes/pb-1"');
  });

  it("sends a pod default to its switch and a posture row to its agent, never a revoke", () => {
    const pod = render(ROWS["pod-default"]);
    expect(pod).toContain(">Change the switch<");
    expect(pod).not.toContain(">Take back<");
    const posture = render(ROWS.posture);
    expect(posture).toContain('href="/agents/ag-1"');
    expect(posture).not.toContain(">Take back<");
  });

  it("sends a computer's copy to the approval it copies", () => {
    expect(render(ROWS.computer)).toContain('href="/approvals?focus=rule-9"');
  });

  it("marks the verdict with the vocabulary's words", () => {
    expect(render(row({ verdict: "auto" }))).toContain("Runs on its own");
    expect(render(row({ verdict: "propose" }))).toContain("Asks first");
    expect(render(row({ verdict: "deny" }))).toContain("Never");
  });
});
