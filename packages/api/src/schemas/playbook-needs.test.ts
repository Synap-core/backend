/**
 * The playbook write door reads NEED refs (0426): a `tools`, `requires` or
 * criterion `check.capability` entry `need:<need>[/<intent>]` must name a
 * need of the vocabulary; an unknown need (a typo) is refused, never stored.
 */
import { describe, it, expect } from "vitest";
import { playbookToolsSchema } from "./playbook-definition.js";
import { requiresSchema } from "./playbook-runner.js";
import { sessionCriteriaSchema } from "./session-criteria.js";

describe("need refs at the playbook write door", () => {
  it("tools: a known need (and intent) is accepted; an unknown one refused", () => {
    expect(
      playbookToolsSchema.safeParse([
        "need:code-host",
        "need:gate/fetch_record",
        "get_entity",
      ]).success
    ).toBe(true);
    const bad = playbookToolsSchema.safeParse(["need:code-hots"]);
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toMatch(/names no need/);
    expect(
      playbookToolsSchema.safeParse(["need:gate/publish_post"]).success
    ).toBe(false);
  });

  it("requires: a capability key or a known need; prose and unknown needs refused", () => {
    expect(
      requiresSchema.safeParse(["media-ffmpeg", "need:deploy-target"]).success
    ).toBe(true);
    expect(requiresSchema.safeParse(["need:nope"]).success).toBe(false);
    expect(requiresSchema.safeParse(["Media FFmpeg"]).success).toBe(false);
  });

  it("criteria: check.capability may name a need", () => {
    const criterion = (capability: string) => [
      {
        key: "merged",
        statement: "The PR is merged",
        check: { kind: "capability", capability },
      },
    ];
    expect(
      sessionCriteriaSchema.safeParse(criterion("need:code-host/fetch_record"))
        .success
    ).toBe(true);
    expect(
      sessionCriteriaSchema.safeParse(criterion("need:nope")).success
    ).toBe(false);
    expect(
      sessionCriteriaSchema.safeParse(criterion("github_check_pr_merged"))
        .success
    ).toBe(true);
  });
});
