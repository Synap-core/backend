import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { publishAllowed } from "./publish-guard.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF =
  "Synap-core/backend/.github/workflows/publish-types.yml@refs/tags/v1.2.3";

describe("publish-guard: api-types publishes only from publish-types.yml", () => {
  it("allows the publish-types workflow of Synap-core/backend", () => {
    expect(
      publishAllowed({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: REF })
    ).toBe(true);
  });

  it("refuses a laptop, another workflow, and a fork", () => {
    expect(publishAllowed({})).toBe(false);
    expect(publishAllowed({ GITHUB_WORKFLOW_REF: REF })).toBe(false);
    expect(
      publishAllowed({
        GITHUB_ACTIONS: "true",
        GITHUB_WORKFLOW_REF:
          "Synap-core/backend/.github/workflows/ci.yml@refs/heads/main",
      })
    ).toBe(false);
    expect(
      publishAllowed({
        GITHUB_ACTIONS: "true",
        GITHUB_WORKFLOW_REF: REF.replace("Synap-core", "someone"),
      })
    ).toBe(false);
  });

  // Reachability: the guard is what `prepublishOnly` runs first, and run that
  // way outside the workflow it exits non-zero.
  it("prepublishOnly runs the guard first, and the guard refuses here", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    expect(pkg.scripts.prepublishOnly).toMatch(
      /^node scripts\/publish-guard\.mjs && /
    );
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.GITHUB_WORKFLOW_REF;
    const r = spawnSync("node", ["scripts/publish-guard.mjs"], {
      cwd: PKG,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("publish-types.yml");
  });
});
