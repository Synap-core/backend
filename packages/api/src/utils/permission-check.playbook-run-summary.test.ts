import { describe, expect, it } from "vitest";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { buildProposalSummary } from "./permission-check.js";

/**
 * A pending "run a template" proposal is titled in the glossary's word. The
 * founder's Governance → Needs you showed `Run Playbook "…"` — those rows were
 * filed BEFORE the vocabulary renamed a playbook to a "Template", and keep the
 * summary stored at filing time. This pins that every NEW row is composed by
 * the vocabulary door (`buildObjectActionTitle`) — no local literal. Payload
 * shape = the one a `run_playbook` filing stores (`name` + `playbookId`, with
 * the display name as `targetName`).
 */
describe("buildProposalSummary — running a playbook", () => {
  const data = {
    name: "Stage Gate Probe",
    targetName: "Stage Gate Probe",
    playbookId: "pb-1",
    params: { target: "x" },
  };

  it('reads "Run Template", the user word', () => {
    expect(buildProposalSummary("playbook", "run", data)).toBe(
      'Run Template "Stage Gate Probe"'
    );
  });

  it("carries the CURRENT vocabulary noun, never the kind token", () => {
    const summary = buildProposalSummary("playbook", "run", data);
    expect(summary).toContain(resolveObjectNoun("playbook"));
    expect(summary).not.toMatch(/playbook/i);
  });
});
