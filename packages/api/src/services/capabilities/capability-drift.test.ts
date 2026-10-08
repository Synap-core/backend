/**
 * Unit tests for the capability drift engine — the load-bearing logic behind
 * `reconcileCapabilitiesToTemplates`. Pure functions (no DB), so these run
 * without the integration test-DB env. Covers the two bugs dogfooding caught:
 * false-drift on parameterized skill NAMES, and providerSpec-level drift
 * detection (the whole reason the generalization exists — the calendar_list
 * baseUrlOverride fix).
 */
import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  capabilityDefinitionDrift,
  installTimePlaceholders,
  PROJECTED_SKILL_FIELDS,
  RUNTIME_PLACEHOLDER_SKILL_FIELDS,
  type InstalledSkillRow,
} from "./capability-drift.js";

describe("canonicalJson", () => {
  it("is key-order independent (jsonb reorders keys)", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("sorts keys recursively", () => {
    expect(canonicalJson({ x: { c: 3, a: 1 } })).toBe(
      canonicalJson({ x: { a: 1, c: 3 } })
    );
  });

  it("preserves array order (arrays are ordered, not sorted)", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("normalizes undefined/absent to null so both sides compare equal", () => {
    expect(canonicalJson(undefined)).toBe(canonicalJson(null));
  });
});

describe("capabilityDefinitionDrift", () => {
  const skill = (name: string, extra: Partial<InstalledSkillRow> = {}) => ({
    name,
    providerSpec: null,
    parameters: {},
    code: null,
    description: null,
    ...extra,
  });

  it("reports no drift when installed matches the definition", () => {
    const installed: InstalledSkillRow[] = [skill("calendar_list")];
    const def = { skills: [skill("calendar_list")] };
    expect(capabilityDefinitionDrift(installed, def)).toEqual({
      missing: [],
      drifted: [],
    });
  });

  it("reports a definition skill absent from installed as MISSING", () => {
    const def = { skills: [skill("discord_send_message")] };
    const { missing, drifted } = capabilityDefinitionDrift([], def);
    expect(missing).toEqual(["discord_send_message"]);
    expect(drifted).toEqual([]);
  });

  it("detects providerSpec drift (the calendar_list baseUrlOverride class of fix)", () => {
    const installed = [
      skill("calendar_list", { providerSpec: { path: "/calendar/v3/events" } }),
    ];
    const def = {
      skills: [
        skill("calendar_list", {
          providerSpec: {
            path: "/calendar/v3/events",
            baseUrlOverride: "https://www.googleapis.com",
          },
        }),
      ],
    };
    expect(capabilityDefinitionDrift(installed, def).drifted).toEqual([
      "calendar_list",
    ]);
  });

  it("detects drift on code, parameters, and description", () => {
    for (const field of ["code", "parameters", "description"] as const) {
      const installed = [skill("s", { [field]: "old" } as never)];
      const def = { skills: [skill("s", { [field]: "new" } as never)] };
      expect(capabilityDefinitionDrift(installed, def).drifted).toEqual(["s"]);
    }
  });

  it("does NOT false-drift on providerSpec key reordering", () => {
    const installed = [skill("s", { providerSpec: { a: 1, b: 2 } })];
    const def = { skills: [skill("s", { providerSpec: { b: 2, a: 1 } })] };
    expect(capabilityDefinitionDrift(installed, def)).toEqual({
      missing: [],
      drifted: [],
    });
  });

  it("SKIPS a template skill whose NAME carries an unresolved {{param}} (the generic-apikey bug)", () => {
    // A parameterized name never matches the installed interpolated name; reporting
    // it as missing would mint a junk blank-named skill on a reconcile.
    const def = { skills: [skill("{{name}} fetch-and-propose")] };
    const { missing, drifted } = capabilityDefinitionDrift([], def);
    expect(missing).toEqual([]);
    expect(drifted).toEqual([]);
  });

  it("still evaluates plain-named skills alongside a skipped parameterized one", () => {
    const def = {
      skills: [skill("{{name}} fetch-and-propose"), skill("plain_verb")],
    };
    const { missing } = capabilityDefinitionDrift([], def);
    expect(missing).toEqual(["plain_verb"]); // only the plain one
  });
});

/**
 * The reconcile's "needs install params" gate. Each row is chosen where the OLD
 * rule (skill NAMES only) and the derived rule DISAGREE — a row both agree on
 * rules nothing out.
 */
describe("installTimePlaceholders", () => {
  const skill = (over: Record<string, unknown>) => ({
    name: "acct_sync",
    kind: "code",
    code: "return 1;",
    ...over,
  });

  it("a param baked into skill CODE behind a plain name is install-time", () => {
    expect(
      installTimePlaceholders({
        skills: [skill({ code: "const id = '{{accountId}}';" })],
      })
    ).toEqual([{ where: 'skill "acct_sync" code', tokens: ["accountId"] }]);
  });

  it("a param in a tool's CONFIG or DESCRIPTION is install-time", () => {
    expect(
      installTimePlaceholders({
        tools: [
          {
            name: "posthog",
            description: "PostHog for {{projectId}}",
            config: { baseUrl: "https://{{analyticsHost}}" },
          },
        ],
      })
    ).toEqual([
      { where: 'tool "posthog" description', tokens: ["projectId"] },
      { where: 'tool "posthog" config', tokens: ["analyticsHost"] },
    ]);
  });

  it("a param in a skill name is still install-time (the original rule holds)", () => {
    expect(
      installTimePlaceholders({ skills: [skill({ name: "{{key}}_dispatch" })] })
    ).toEqual([{ where: 'skill "{{key}}_dispatch" name', tokens: ["key"] }]);
  });

  it("providerSpec placeholders are RUNTIME verb arguments, never install-time", () => {
    expect(
      installTimePlaceholders({
        skills: [
          skill({ kind: "declarative", providerSpec: { path: "/x/{{id}}" } }),
        ],
      })
    ).toEqual([]);
    for (const f of RUNTIME_PLACEHOLDER_SKILL_FIELDS) {
      expect(Object.keys(PROJECTED_SKILL_FIELDS)).toContain(f);
    }
  });

  it("{{vault:<ref>}} resolves from the template's own vault — not a param", () => {
    expect(
      installTimePlaceholders({
        skills: [skill({ code: "secrets.get('{{vault:githubTokenSecret}}')" })],
        tools: [{ name: "t", config: { ref: "{{vault:githubTokenSecret}}" } }],
      })
    ).toEqual([]);
  });

  it("scans EVERY projected skill field (derived, not hand-listed)", () => {
    // One placeholder per projected field: every field must be reported, so a
    // field dropped from the scan shrinks this list and fails here by name.
    const fields = Object.keys(PROJECTED_SKILL_FIELDS).filter(
      (k) =>
        !(RUNTIME_PLACEHOLDER_SKILL_FIELDS as readonly string[]).includes(k)
    );
    expect(fields.length).toBeGreaterThanOrEqual(11);
    const row: Record<string, unknown> = { name: "plain" };
    for (const f of fields) row[f] = `{{p_${f}}}`;
    const where = installTimePlaceholders({ skills: [row] }).map(
      (p) => p.where
    );
    expect(where.sort()).toEqual(
      fields.map((f) => `skill "plain" ${f}`).sort()
    );
  });
});
