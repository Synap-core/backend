/**
 * The pod derives the version it stamps from the definition it applied, with
 * the Control Plane's own rule (see `applied-package-version.ts`).
 */
import { describe, it, expect } from "vitest";
import { appliedPackageVersion } from "./applied-package-version.js";

const SOURCE = { name: "@synap-core/workspace-templates", version: "9.9.9" };

// The SAME fixture + literal is pinned in synap-control-plane-api
// `src/seeds/publish-package-core.provenance.test.ts` (`definitionVersion`).
// Change one, change both — a drift means the pod stamps versions the CP never
// minted, and every catalog install reads as drifted (or worse, the reverse).
const PARITY_FIXTURE = {
  workspaceName: "Parity",
  icon: "sparkles",
  layoutConfig: { primarySurface: { kind: "cell", cellKey: "content-home" } },
  profiles: [{ slug: "task", properties: [{ slug: "title", type: "text" }] }],
  contentHash: "ignored",
  sourcePackage: SOURCE,
};

describe("appliedPackageVersion", () => {
  it("matches the CP's definitionVersion for the shared parity fixture", () => {
    expect(appliedPackageVersion(PARITY_FIXTURE)).toBe("h-415dd71e1e6c");
  });

  it("ignores the caller's label and the apply request fields", () => {
    expect(
      appliedPackageVersion({
        ...PARITY_FIXTURE,
        _meta: { slug: "content-os", version: "h-448ffcae9220" },
        targetWorkspaceId: "8f894661-db21-4f6d-ba30-5334f7b67bef",
        instanceName: "Sandbox",
        projectId: "p-1",
        projectName: "X",
        agentUserId: "a-1",
        force: true,
      })
    ).toBe("h-415dd71e1e6c");
  });

  it("a stale definition (no primarySurface) can never claim the fresh version", () => {
    const stale = {
      ...PARITY_FIXTURE,
      layoutConfig: { primarySurface: null },
    };
    expect(appliedPackageVersion(stale)).toMatch(/^h-[0-9a-f]{12}$/);
    expect(appliedPackageVersion(stale)).not.toBe("h-415dd71e1e6c");
  });
});
