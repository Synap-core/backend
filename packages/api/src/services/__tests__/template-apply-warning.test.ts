/**
 * `templateApplyWarning` — THE sentence every reader serves for why a space's
 * last template apply did not finish (MCP template_health, Hub GET /workspaces
 * → `synap templates`, the /packages/apply response → `synap templates update`).
 * The live awaiting-approval read is pinned on PGlite in
 * `rest/packages.finish-template-apply.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  STALE_BUILD_MS,
  dataChangesHeldSentence,
  healthApplyState,
  templateApplyWarning,
} from "../template-health.js";
import { readTemplateState } from "@synap/database";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const rec = (state: string) => ({
  templateApply: { state, version: "h", at: "t" },
});

describe("templateApplyWarning — one wording", () => {
  it("awaiting approval names the still-pending proposals; none pending ⇒ the rest is left to run", () => {
    expect(
      templateApplyWarning("crm", rec("awaiting-approval"), ["p1", "p2"])
    ).toBe(
      "Waiting on your approval of 2 proposals (p1, p2), then run `synap templates update crm`."
    );
    // Every proposal decided: nothing waits, but the update is not finished —
    // never a silent null under a "waiting" state (review2 UX-M4).
    expect(templateApplyWarning("crm", rec("awaiting-approval"), [])).toBe(
      "Not finished: run `synap templates update crm` to apply the rest of crm."
    );
  });

  it("a build abandoned for more than ten minutes reads as an update that stopped", () => {
    const at = (msAgo: number) => ({
      template: {
        slug: "crm",
        version: null,
        state: "building",
        at: new Date(NOW - msAgo).toISOString(),
      },
    });
    expect(
      templateApplyWarning("crm", at(STALE_BUILD_MS + 1), [], { now: NOW })
    ).toBe(
      "Not finished: the last update of crm stopped before it completed. Run `synap templates update crm` to resume."
    );
    // In flight: nothing to say yet.
    expect(
      templateApplyWarning("crm", at(60_000), [], { now: NOW })
    ).toBeNull();
  });

  it("a held update says it waits for the person's agreement, only when nothing else is unfinished", () => {
    const active = { template: { slug: "crm", state: "active", at: "t" } };
    expect(
      templateApplyWarning("crm", active, [], { dataChangesHeld: true })
    ).toBe(dataChangesHeldSentence("crm"));
    expect(templateApplyWarning("crm", active, [])).toBeNull();
    expect(
      templateApplyWarning("crm", rec("partial"), [], { dataChangesHeld: true })
    ).toBe(
      "Not finished: part of crm did not apply. Run `synap templates update crm` to retry."
    );
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

describe("healthApplyState — the state every client draws its mark from", () => {
  const state = (s: string, at = "2026-10-15T11:59:00Z") =>
    readTemplateState({ template: { slug: "crm", state: s, at } });

  it("awaiting approval with nothing left pending reads layer-2-not-run", () => {
    expect(healthApplyState(state("awaiting-approval"), ["p1"], NOW)).toBe(
      "awaiting-approval"
    );
    expect(healthApplyState(state("awaiting-approval"), [], NOW)).toBe(
      "layer-2-not-run"
    );
  });

  it("a building record older than ten minutes (or of unknown age) reads failed", () => {
    expect(healthApplyState(state("building"), [], NOW)).toBe("building");
    expect(
      healthApplyState(
        state("building", new Date(NOW - STALE_BUILD_MS - 1).toISOString()),
        [],
        NOW
      )
    ).toBe("failed");
    expect(healthApplyState(state("building", ""), [], NOW)).toBe("failed");
  });

  it("every other state is served as recorded; no state ⇒ null", () => {
    for (const s of ["active", "partial", "layer-2-not-run", "failed"])
      expect(healthApplyState(state(s), [], NOW)).toBe(s);
    expect(healthApplyState(null, [], NOW)).toBeNull();
  });
});
