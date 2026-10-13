/**
 * `templateApplyWarning` — THE sentence every reader serves for why a space's
 * last template apply did not finish (MCP template_health, Hub GET /workspaces
 * → `synap templates`, the /packages/apply response → `synap templates update`).
 * The live awaiting-approval read is pinned on PGlite in
 * `rest/packages.finish-template-apply.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { templateApplyWarning } from "../template-health.js";

const rec = (state: string) => ({
  templateApply: { state, version: "h", at: "t" },
});

describe("templateApplyWarning — one wording", () => {
  it("awaiting approval names the still-pending proposals; none pending ⇒ plain drift", () => {
    expect(
      templateApplyWarning("crm", rec("awaiting-approval"), ["p1", "p2"])
    ).toBe(
      "Waiting on your approval of 2 proposals (p1, p2), then run `synap templates update crm`."
    );
    expect(
      templateApplyWarning("crm", rec("awaiting-approval"), [])
    ).toBeNull();
  });

  it("partial, not run and failed each say how to finish", () => {
    expect(templateApplyWarning("crm", rec("partial"), [])).toBe(
      "Not finished: part of crm did not apply. Run `synap templates update crm` to retry."
    );
    expect(templateApplyWarning("crm", rec("layer-2-not-run"), [])).toBe(
      "Not finished: run `synap templates update crm` to apply the rest of crm."
    );
    expect(
      templateApplyWarning("crm", { provisioningStatus: "failed" }, [])
    ).toBe(
      "Not finished: the last update of crm failed. Run `synap templates update crm` to resume."
    );
  });

  it("a finished apply has nothing to say", () => {
    expect(templateApplyWarning("crm", { templateApply: null }, [])).toBeNull();
    expect(templateApplyWarning("crm", {}, [])).toBeNull();
  });
});
