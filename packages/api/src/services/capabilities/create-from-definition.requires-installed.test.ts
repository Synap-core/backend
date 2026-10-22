/**
 * A skill's `requires` reaches a tool ANOTHER capability installed.
 *
 * The scope a verb's one decision covers (`verbAct`) is its `requires` links.
 * A composite verb — `launch_site`, which calls both `vercel` and `cloudflare`,
 * each installed by its own capability — used to lose every name its own
 * template did not define, so its calls to the other tool were gated again
 * (a second proposal for the same act). Now:
 *  - a template-local name resolves to the tool the template installed;
 *  - any other name resolves to the ONE installed tool of that name in scope;
 *  - 0 or 2+ installed tools of that name resolve to nothing (never a guess).
 *
 * NOT covered: the scope query itself (`installedToolIdsByName` in
 * createCapabilityFromDefinition — pod-wide, plus the install workspace).
 */
import { describe, expect, it } from "vitest";
import { resolveRequiredToolIds } from "./create-from-definition.js";

const installed: Record<string, string[]> = {
  cloudflare: ["tool-cf"],
  twice: ["tool-a", "tool-b"],
};
const lookup = async (name: string) => installed[name] ?? [];

describe("resolveRequiredToolIds", () => {
  it("resolves a local name and an installed name from another capability", async () => {
    const local = new Map([["vercel", "tool-vercel"]]);
    expect(
      await resolveRequiredToolIds(["vercel", "cloudflare"], local, lookup)
    ).toEqual(["tool-vercel", "tool-cf"]);
  });

  it("a local name wins over an installed tool of the same name", async () => {
    const local = new Map([["cloudflare", "tool-local"]]);
    expect(await resolveRequiredToolIds(["cloudflare"], local, lookup)).toEqual(
      ["tool-local"]
    );
  });

  it("a missing or ambiguous name resolves to nothing", async () => {
    expect(
      await resolveRequiredToolIds(["nope", "twice"], new Map(), lookup)
    ).toEqual([]);
  });
});
