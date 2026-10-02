/**
 * posthog-analytics — the PACKAGE definition is coherent with the pod runtime.
 *
 * The definition (`templates/capabilities/posthog-analytics.capability.json`) is
 * what a pod actually installs: it creates the vault secret, the `posthog_api`
 * tool, and the four verb rows. Three classes of defect are invisible at install
 * time and each one produces a capability that looks installed and calmly
 * returns nothing:
 *
 *  1. A skill naming a verb with NO handler in `BUILTIN_VERBS` → the run fails
 *     `not_found` "No builtin handler registered".
 *  2. A param advertised in the catalog but absent from the handler's Zod
 *     schema (or vice versa) → either an undiscoverable argument or a call the
 *     handler refuses. This is the same invariant the `catalog-schema-coherence`
 *     tripwire holds, asserted here in BOTH directions for this package.
 *  3. A `{{token}}` in `tools[].config.baseUrl` with no declared param. The
 *     applier scans unresolved tokens only in `vault[].value` and
 *     `tools[].credentialRef` — NOT in `baseUrl` — so a renamed project id would
 *     interpolate to the EMPTY STRING and silently query
 *     `https://host/api/projects/`. That is the scope story failing open, which
 *     is why it is guarded here rather than trusted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The REAL registries — never a local re-listing. A slice kept beside the
// registry is a second source of truth that can pass these assertions while the
// pod runs something else.
import {
  BUILTIN_VERBS,
  BUILTIN_VERB_PARAM_SCHEMAS,
  READ_ONLY_BUILTIN_VERBS,
} from "../capabilities/builtin-verbs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFINITION_PATH = join(
  HERE,
  "../../../../../templates/capabilities/posthog-analytics.capability.json"
);

interface SkillDef {
  name: string;
  kind?: string;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
}
interface Definition {
  key: string;
  name: string;
  params?: Array<{ name: string; required?: boolean }>;
  vault?: Array<{ ref: string; value: string; podWide?: boolean }>;
  tools: Array<{
    name: string;
    credentialRef?: string;
    config?: Record<string, unknown>;
  }>;
  skills: SkillDef[];
  provides?: string[];
}

const definition = JSON.parse(
  readFileSync(DEFINITION_PATH, "utf8")
) as Definition;

const declaredParamNames = new Set(
  (definition.params ?? []).map((p) => p.name)
);
const declaredSkills = new Set(definition.skills.map((s) => s.name));
/**
 * The verb namespace this package owns, DERIVED from what it declares (never
 * hand-listed) — used to find orphan registrations in the reverse direction.
 */
const namespace = `${definition.skills[0]!.name.split(".")[0]!}.`;
const registeredInNamespace = Object.keys(BUILTIN_VERBS).filter((v) =>
  v.startsWith(namespace)
);

function tokensIn(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
}

describe("the package's skills reach real, read-only handlers", () => {
  it("declares four builtin skills, and every one has a registered handler", () => {
    expect(definition.skills).toHaveLength(4);
    for (const skill of definition.skills) {
      expect(skill.kind).toBe("builtin");
      expect(
        BUILTIN_VERBS[skill.name],
        `${skill.name} has no handler in BUILTIN_VERBS — the installed skill would fail "No builtin handler registered"`
      ).toBeTypeOf("function");
    }
  });

  it("every declared skill is READ-ONLY, and the read-only set has no orphan", () => {
    for (const skill of definition.skills) {
      expect(
        READ_ONLY_BUILTIN_VERBS.has(skill.name),
        `${skill.name} would file an agent's analytics READ as a review proposal`
      ).toBe(true);
    }
    for (const verb of READ_ONLY_BUILTIN_VERBS) {
      if (!verb.startsWith(namespace)) continue;
      expect(
        declaredSkills.has(verb),
        `${verb} is read-only but no skill declares it`
      ).toBe(true);
    }
  });

  it("registers exactly the declared verbs, each with a Zod schema", () => {
    // Derived from the namespace on both sides: a registered `posthog.*` verb the
    // package does not declare would be runnable yet uninstallable, and a
    // declared verb with no registration would fail at run time.
    expect(registeredInNamespace.sort()).toEqual([...declaredSkills].sort());
    for (const verb of declaredSkills) {
      expect(
        BUILTIN_VERB_PARAM_SCHEMAS[verb],
        `${verb} has no Zod schema in BUILTIN_VERB_PARAM_SCHEMAS, so its params are undiscoverable`
      ).toBeDefined();
    }
  });
});

describe("the advertised params are exactly the handler's params", () => {
  for (const skill of definition.skills) {
    it(`${skill.name}: catalog ⟷ Zod are the same key set`, () => {
      const schema = BUILTIN_VERB_PARAM_SCHEMAS[skill.name];
      expect(
        schema,
        `${skill.name} missing from BUILTIN_VERB_PARAM_SCHEMAS`
      ).toBeDefined();
      const zodKeys = Object.keys(schema!.shape).sort();
      const catalogKeys = Object.keys(
        skill.parameters?.properties ?? {}
      ).sort();
      expect(catalogKeys).toEqual(zodKeys);
    });
  }
});

describe("the install-time tokens resolve (or the scope story fails open)", () => {
  it("the tool points at the declared vault ref", () => {
    const tool = definition.tools[0]!;
    const refs = (definition.vault ?? []).map((v) => v.ref);
    expect(tool.name).toBe("posthog_api");
    expect(refs).toContain(tool.credentialRef);
  });

  it("vault values only interpolate DECLARED params", () => {
    for (const v of definition.vault ?? []) {
      for (const token of tokensIn(v.value)) {
        expect(
          declaredParamNames.has(token),
          `vault secret interpolates {{${token}}} which is not a declared param — it would install as the empty string`
        ).toBe(true);
      }
    }
  });

  it("baseUrl pins host AND project from declared params, and nothing else", () => {
    const baseUrl = String(definition.tools[0]!.config?.baseUrl ?? "");
    expect(baseUrl).toContain("{{analyticsHost}}");
    expect(baseUrl).toContain("{{projectId}}");
    const tokens = tokensIn(baseUrl);
    // Exactly the two scope-defining params — an extra token here is exactly the
    // silent-empty-string class the applier does not scan for.
    expect([...tokens].sort()).toEqual(["analyticsHost", "projectId"]);
    for (const token of tokens) {
      expect(declaredParamNames.has(token)).toBe(true);
    }
  });

  it("projectId is REQUIRED — it is the one param the applier will not catch missing", () => {
    const required = new Set(
      (definition.params ?? []).filter((p) => p.required).map((p) => p.name)
    );
    expect(required.has("projectId")).toBe(true);
    expect(required.has("personalApiKey")).toBe(true);
  });

  it("the analytics key is pod-wide so every member/agent reads the pod's project", () => {
    expect(definition.vault?.[0]?.podWide).toBe(true);
  });

  it("declares the routing intent it provides", () => {
    expect(definition.provides).toEqual(["list_records"]);
    for (const skill of definition.skills) {
      // Every verb carries a routing intent; without one it is invisible to
      // list_capabilities({intent}).
      expect(
        (skill as { intent?: unknown }).intent,
        `${skill.name} declares no intent`
      ).toBe("list_records");
    }
  });
});
