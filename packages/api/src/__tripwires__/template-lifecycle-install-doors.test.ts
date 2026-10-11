/**
 * Template LIFECYCLES survive the tRPC install doors (work model L1).
 *
 * The same defect class `template-skills-install-doors.test.ts` pins for
 * skills: `createFromDefinition` / `reconcileFromDefinition` parse
 * `definition.profiles[]` with zod objects that STRIP an undeclared key. The
 * one install door (`installFromCatalog`) goes through `createFromDefinition`,
 * so without `lifecycle` in that schema every catalog install declared no
 * lifecycle — silently, while `createWorkspaceFromDefinition` stood ready to
 * declare it. The apply half (fold + declare, including a re-apply onto a
 * profile that already exists) is pinned on PGlite by
 * `@synap/database` `reconcile-lifecycle.pglite.test.ts`.
 *
 * Driven from the REAL sold template through the real converter, so the
 * assertion is that the catalog's own declaration arrives.
 */
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definitionEngineProcedures } from "../routers/workspaces/definition-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const WT_DEFINE = join(
  here,
  "../../../../../synap-app/packages/workspace-templates/src/define.ts"
);
const WS = "00000000-0000-4000-8000-000000000001";

type Profile = { slug: string; lifecycle?: unknown };
async function realProfiles(slug: string): Promise<Profile[]> {
  const { toPackageDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  return (toPackageDefinition(slug) as { profiles: Profile[] }).profiles;
}

type Parser = { parse: (v: unknown) => unknown };
const inputOf = (name: "createFromDefinition" | "reconcileFromDefinition") =>
  (
    definitionEngineProcedures[name] as unknown as {
      _def: { inputs: Parser[] };
    }
  )._def.inputs[0]!;

describe("template lifecycles — the tRPC install doors carry them", () => {
  it("the SOLD crm template declares deal's lifecycle (non-vacuity)", async () => {
    const deal = (await realProfiles("crm")).find((p) => p.slug === "deal");
    expect(deal?.lifecycle).toMatchObject({ property: "commercialStage" });
  });

  it("createFromDefinition keeps every profile's lifecycle", async () => {
    const profiles = await realProfiles("crm");
    const declared = profiles.filter((p) => p.lifecycle);
    expect(declared.length).toBeGreaterThan(0);
    const parsed = inputOf("createFromDefinition").parse({
      definition: { workspaceName: "CRM", description: "d", profiles },
    }) as { definition: { profiles: Profile[] } };
    for (const p of declared)
      expect(
        parsed.definition.profiles.find((x) => x.slug === p.slug)?.lifecycle,
        p.slug
      ).toEqual(p.lifecycle);
  });

  it("reconcileFromDefinition keeps every profile's lifecycle", async () => {
    const profiles = await realProfiles("foundation");
    const declared = profiles.filter((p) => p.lifecycle);
    expect(declared.map((p) => p.slug)).toEqual(
      expect.arrayContaining(["lead", "client"])
    );
    const parsed = inputOf("reconcileFromDefinition").parse({
      workspaceId: WS,
      definition: { profiles },
    }) as { definition: { profiles: Profile[] } };
    for (const p of declared)
      expect(
        parsed.definition.profiles.find((x) => x.slug === p.slug)?.lifecycle,
        p.slug
      ).toEqual(p.lifecycle);
  });
});
