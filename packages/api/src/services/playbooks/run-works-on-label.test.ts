import { describe, it, expect } from "vitest";
import { runWorksOnLabel } from "./playbook-lifecycle.js";

/**
 * The NAME of a run with no subject (plan fbfadf54 5b). The seam (the label
 * reaching `focus_sessions.title` through `runPlaybook`, `goal` unchanged) is
 * in run-title-and-prompt.test.ts, which needs a database.
 */
describe("runWorksOnLabel (a run with no subject is named by what it works on)", () => {
  const RECIPE_ID = "1b91229e-f202-4a7a-9b57-1d6f5a48ec7c";
  const names: Record<string, string> = { [RECIPE_ID]: "Consolidate findings" };
  const nameOf = async (id: string) => names[id] ?? null;

  it("names the pod object a param's id points at, by its title", async () => {
    await expect(
      runWorksOnLabel(
        [
          { name: "recipe", type: "text", required: true },
          { name: "runs", type: "number" },
        ],
        { recipe: RECIPE_ID, runs: 10 },
        nameOf
      )
    ).resolves.toBe("Consolidate findings");
  });

  it("an id that names nothing visible is skipped, never shown", async () => {
    await expect(
      runWorksOnLabel(
        [{ name: "recipe", type: "text", required: true }],
        { recipe: "00000000-0000-4000-8000-000000000000" },
        nameOf
      )
    ).resolves.toBeNull();
  });

  it("else the first required text param's own value", async () => {
    await expect(
      runWorksOnLabel(
        [
          { name: "depth", type: "number" },
          { name: "area", type: "text", required: true },
        ],
        { depth: 2, area: "governance" },
        nameOf
      )
    ).resolves.toBe("governance");
  });

  it("else nothing: a boolean or number param does not name a run", async () => {
    await expect(
      runWorksOnLabel(
        [{ name: "dryRun", type: "boolean", required: true }],
        { dryRun: true },
        nameOf
      )
    ).resolves.toBeNull();
    await expect(runWorksOnLabel([], {}, nameOf)).resolves.toBeNull();
  });
});
