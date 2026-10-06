/**
 * Template SKILLS survive every install door and reach the skill applier.
 *
 * The same defect class `template-rules-install-doors.test.ts` pins for rules:
 * the doors in front of `applyPackagePostWorkspace` are zod objects that STRIP
 * an undeclared key. `applyTemplateSkills` exists, but if the Hub
 * `PackageApplySchema`, the tRPC `createFromDefinition` / `reconcileFromDefinition`
 * inputs, or `buildPostWorkspaceBodyFromDefinition` do not carry `skills`, every
 * install silently links nothing — no error, just a space that never gets the
 * skill its template declared.
 *
 * Driven synthetically (the source templates do not declare `skills` yet — the
 * brand-library / content-os declarations are a separate change), because what
 * this asserts is the DOOR contract: a value that enters must arrive. The
 * template→wire half is asserted separately in
 * `workspace-templates/src/skills.test.ts` (toPackageDefinition carries the
 * declared value), so the two tests together cover the whole path.
 */
import { describe, it, expect, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  applyTemplateSkills: vi.fn(
    async (_input: Record<string, unknown>) => [] as unknown[]
  ),
}));

vi.mock("../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../routers/hub-protocol/utils.js")
  >()),
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("../services/skills/template-skills.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/skills/template-skills.js")
  >()),
  applyTemplateSkills: h.applyTemplateSkills,
}));

import { PackageApplySchema } from "../routers/hub-protocol/rest/packages.js";
import { definitionEngineProcedures } from "../routers/workspaces/definition-engine.js";
import { buildPostWorkspaceBodyFromDefinition } from "../routers/workspaces/helpers.js";
import { applyPackagePostWorkspace } from "../services/package-apply-post-workspace.js";

const WS = "00000000-0000-4000-8000-000000000001";
const DECLARED = [
  {
    slug: "system/synap/creative-director",
    when: "any content ask",
    mode: "always",
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const WT_DEFINE = join(
  here,
  "../../../../../synap-app/packages/workspace-templates/src/define.ts"
);
const SLUG = "brand-library";

/** The REAL sold template, through the real converter. */
async function realPkg(): Promise<Record<string, unknown>> {
  const { toPackageDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  return toPackageDefinition(SLUG) as Record<string, unknown>;
}

type Parser = { parse: (v: unknown) => unknown };
const inputOf = (name: "createFromDefinition" | "reconcileFromDefinition") =>
  (
    definitionEngineProcedures[name] as unknown as {
      _def: { inputs: Parser[] };
    }
  )._def.inputs[0]!;

describe("template skills — every install door carries them to the applier", () => {
  it("the SOLD template ships skills (non-vacuity — the template→wire half)", async () => {
    // Closes the other half of the path: workspace-templates proves
    // `toPackageDefinition` carries a declaration, the door cases below prove
    // the doors forward one, and THIS proves the shipped brand-library really
    // declares creative-director — so the whole chain is exercised on real data.
    const skills = (await realPkg()).skills as Array<{
      slug: string;
      mode: string;
    }>;
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some((s) => s.slug.includes("creative-director"))).toBe(true);
    expect(skills.every((s) => typeof s.mode === "string")).toBe(true);
  });

  it("Hub /packages/apply: parsed body → applyPackagePostWorkspace → applyTemplateSkills", async () => {
    // Driven from the REAL definition, so the assertion is that the template's
    // own declared value arrives at the applier.
    const source = await realPkg();
    const body = PackageApplySchema.parse(source) as { skills?: unknown[] };
    // The door must NOT have stripped it.
    expect(body.skills).toEqual(source.skills);

    h.applyTemplateSkills.mockClear();
    const result = await applyPackagePostWorkspace({
      workspaceId: WS,
      body: { _meta: { slug: SLUG }, skills: body.skills },
      userId: "u1",
      scopes: [],
    });
    expect(h.applyTemplateSkills).toHaveBeenCalledTimes(1);
    expect(h.applyTemplateSkills.mock.calls[0]![0]).toMatchObject({
      workspaceId: WS,
      skills: source.skills,
    });
    expect(result.skills).toEqual([]);
  });

  it("tRPC createFromDefinition: input keeps skills, the one builder forwards them", async () => {
    const parsed = inputOf("createFromDefinition").parse({
      definition: {
        workspaceName: "W",
        description: "d",
        profiles: [],
        skills: DECLARED,
      },
    }) as { definition: Record<string, unknown> };
    expect(parsed.definition.skills).toEqual(DECLARED);
    const body = buildPostWorkspaceBodyFromDefinition(
      parsed.definition as Parameters<
        typeof buildPostWorkspaceBodyFromDefinition
      >[0],
      WS
    );
    expect(body.skills).toEqual(DECLARED);
  });

  it("tRPC reconcileFromDefinition: input keeps skills (not passthrough)", async () => {
    const parsed = inputOf("reconcileFromDefinition").parse({
      workspaceId: WS,
      definition: { skills: DECLARED },
    }) as { definition: Record<string, unknown> };
    expect(parsed.definition.skills).toEqual(DECLARED);
  });

  it("the applier is NOT reached when nothing declares skills (non-vacuity)", async () => {
    h.applyTemplateSkills.mockClear();
    await applyPackagePostWorkspace({
      workspaceId: WS,
      body: { _meta: { slug: "brand-library" } },
      userId: "u1",
      scopes: [],
    });
    expect(h.applyTemplateSkills).not.toHaveBeenCalled();
  });
});
