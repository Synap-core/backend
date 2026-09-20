/**
 * The AUTHORED read-only declaration (`skills.metadata.readOnly`) — the axis the
 * capability gate honours so a read verb stops proposing on every call.
 *
 * WHAT THESE PIN, and why each one would go red on a plausible regression:
 *
 *  - `declaredReadOnly` accepts ONLY a real boolean. A lenient parse here would
 *    let `"false"` (a truthy string) widen the auto path — this value gates
 *    auto-execution, so coercion is never worth it.
 *  - `projectSkillMetadata` writes the two definition-owned keys INDEPENDENTLY.
 *    Collapsing them (writing both whenever either is declared) would blank an
 *    `allowedHosts` list set through the tRPC door.
 *  - the drift comparator's `metadata` entry reads the SAME key set on both
 *    sides, driven by the DEFINITION. Reading the live bag instead would report
 *    drift a re-apply can never converge — a re-apply on EVERY boot.
 *  - `readOnlyWidened` fires on the WIDENING direction only, by value.
 *
 * WHAT THEY DO NOT COVER, measured: these test the projection/comparator/demotion
 * seam, NOT the gate short-circuit in `execute-capability.ts` (which needs a DB
 * row + the gate). The line that consumes this — `declaredReadOnly(skillRow.metadata)
 * === true` — is pinned only by the fact that removing `metadata` from that
 * file's `skills` select fails typecheck, not by a test here.
 */
import { describe, expect, it } from "vitest";
import {
  declaredReadOnly,
  declaredAllowedHosts,
  projectSkillMetadata,
  capabilityDefinitionDrift,
  PROJECTED_SKILL_FIELDS,
  SKILL_METADATA_READ_ONLY,
  SKILL_METADATA_ALLOWED_HOSTS,
} from "./capability-drift.js";
import { readOnlyWidened } from "./skill-exec-fields.js";

describe("declaredReadOnly", () => {
  it("honours only a real boolean — a non-boolean declares NOTHING", () => {
    expect(declaredReadOnly({ readOnly: true })).toBe(true);
    expect(declaredReadOnly({ readOnly: false })).toBe(false);
    // The whole point: these must NOT be coerced. `"false"` is truthy.
    for (const bad of ["true", "false", 1, 0, "yes", null, [], {}]) {
      expect(
        declaredReadOnly({ readOnly: bad }),
        `${JSON.stringify(bad)} must not declare a read-only posture`
      ).toBeUndefined();
    }
    expect(declaredReadOnly({})).toBeUndefined();
    expect(declaredReadOnly(null)).toBeUndefined();
  });
});

describe("projectSkillMetadata — the two definition-owned keys are independent", () => {
  it("declaring readOnly alone does NOT blank a live allowedHosts list", () => {
    const live = { allowedHosts: ["api.vendor.com"], marketSource: "pkg" };
    const out = projectSkillMetadata(live, { readOnly: true });
    expect(out).toEqual({
      allowedHosts: ["api.vendor.com"], // preserved, NOT rewritten
      marketSource: "pkg", // DB-owned key preserved byte-identically
      readOnly: true,
    });
  });

  it("declaring allowedHosts alone does NOT write a readOnly key", () => {
    const out = projectSkillMetadata(
      { marketSource: "pkg" },
      { allowedHosts: ["a.com"] }
    );
    expect(out).toEqual({ marketSource: "pkg", allowedHosts: ["a.com"] });
    expect(out && SKILL_METADATA_READ_ONLY in out).toBe(false);
  });

  it("declaring NEITHER writes nothing at all (Drizzle skips the key)", () => {
    expect(projectSkillMetadata({ allowedHosts: ["a"] }, {})).toBeUndefined();
    expect(projectSkillMetadata({ allowedHosts: ["a"] }, null)).toBeUndefined();
  });
});

describe("drift comparator reads the DEFINITION's key set on both sides", () => {
  const BASE = { name: "exa_search" } as const;
  const entry = PROJECTED_SKILL_FIELDS.metadata;

  it("a template declaring readOnly:true against a live row without it IS drift", () => {
    const def = { ...BASE, metadata: { readOnly: true } };
    const live = { ...BASE, metadata: {} };
    expect(capabilityDefinitionDrift([live], { skills: [def] })).toEqual({
      missing: [],
      drifted: ["exa_search"],
    });
  });

  it("once applied, it is NOT drift again — no re-apply loop", () => {
    const def = { ...BASE, metadata: { readOnly: true } };
    const applied = {
      ...BASE,
      metadata: projectSkillMetadata({}, def.metadata),
    };
    expect(capabilityDefinitionDrift([applied], { skills: [def] })).toEqual({
      missing: [],
      drifted: [],
    });
  });

  it("THE RE-APPLY-EVERY-BOOT TRAP: an undeclared key must not enter the diff", () => {
    // Definition declares ONLY readOnly. The live row carries an allowedHosts
    // list set through the tRPC door. The applier will NOT write allowedHosts,
    // so if the comparator compared it the drift could never be converged and
    // this container would re-apply on every single boot.
    const def = { ...BASE, metadata: { readOnly: true } };
    const live = {
      ...BASE,
      metadata: { readOnly: true, allowedHosts: ["set.via.trpc"] },
    };
    expect(entry.expected(def)).toEqual({ [SKILL_METADATA_READ_ONLY]: true });
    expect(entry.actual(live, def)).toEqual({
      [SKILL_METADATA_READ_ONLY]: true,
    });
    expect(
      capabilityDefinitionDrift([live], { skills: [def] }).drifted,
      "an undeclared metadata key leaked into the diff — this is a re-apply on every boot"
    ).toEqual([]);
  });

  it("still catches an allowedHosts change when BOTH keys are declared", () => {
    const def = {
      ...BASE,
      metadata: { readOnly: true, allowedHosts: ["api.exa.ai"] },
    };
    const live = { ...BASE, metadata: { readOnly: true, allowedHosts: [] } };
    expect(entry.expected(def)).toEqual({
      [SKILL_METADATA_ALLOWED_HOSTS]: ["api.exa.ai"],
      [SKILL_METADATA_READ_ONLY]: true,
    });
    expect(
      capabilityDefinitionDrift([live], { skills: [def] }).drifted
    ).toEqual(["exa_search"]);
  });

  it("a DB-owned key is never drift", () => {
    const def = { ...BASE, metadata: { readOnly: true } };
    const live = {
      ...BASE,
      metadata: { readOnly: true, executionCount: 91, rule: { a: 1 } },
    };
    expect(
      capabilityDefinitionDrift([live], { skills: [def] }).drifted
    ).toEqual([]);
  });
});

describe("readOnlyWidened — approval demotion, one direction, by value", () => {
  it("false/absent → true DEMOTES (the escalation being guarded)", () => {
    expect(readOnlyWidened({ readOnly: true }, {})).toBe(true);
    expect(readOnlyWidened({ readOnly: true }, null)).toBe(true);
    expect(readOnlyWidened({ readOnly: true }, { readOnly: false })).toBe(true);
  });

  it("true → false does NOT demote — it TIGHTENS governance", () => {
    expect(readOnlyWidened({ readOnly: false }, { readOnly: true })).toBe(
      false
    );
  });

  it("an unchanged re-send does NOT demote (value, not presence)", () => {
    // The exact regression a presence test caused on the MCP-server door: a
    // form re-posting the same value on every save would demote forever.
    expect(readOnlyWidened({ readOnly: true }, { readOnly: true })).toBe(false);
  });

  it("a patch that does not mention the key is inert", () => {
    expect(readOnlyWidened({ allowedHosts: ["a"] }, { readOnly: false })).toBe(
      false
    );
    expect(readOnlyWidened(undefined, { readOnly: false })).toBe(false);
  });
});

describe("the shipped exa declaration actually reaches the projection", () => {
  it("exa_search's template metadata projects readOnly:true onto the row", async () => {
    // Reads the REAL template file, not a hand-built fixture: the defect being
    // guarded is "the declaration was never added / was stripped", which a
    // fixture cannot see. Drives it through the REAL projection.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(
      new URL(
        "../../../../../../synap-control-plane-api/src/seeds/capability-templates/exa.capability.json",
        import.meta.url
      )
    );
    const def = JSON.parse(await readFile(path, "utf8")) as {
      skills: Array<{ name: string; metadata?: Record<string, unknown> }>;
    };
    const search = def.skills.find((s) => s.name === "exa_search");
    expect(search, "exa_search vanished from the template").toBeDefined();
    expect(declaredAllowedHosts(search!.metadata)).toBeUndefined();
    expect(
      projectSkillMetadata(null, search!.metadata),
      "exa_search no longer declares readOnly — every search will propose again"
    ).toEqual({ [SKILL_METADATA_READ_ONLY]: true });
  });
});
