/**
 * Template RULES survive every install door and reach the rule applier.
 *
 * `applyPackagePostWorkspace` applies package `rules[]` through
 * `applyTemplateRules` (W3), but the doors in front of it were zod objects
 * that did not declare `rules` — so zod STRIPPED them and no install ever
 * handed the applier a rule: Hub `PackageApplySchema` (POST
 * /api/hub/packages/apply, market.install, the approve executor), and tRPC
 * `reconcileFromDefinition` (not passthrough). `buildPostWorkspaceBodyFromDefinition`
 * — the one body builder of the tRPC create / compose / reconcile branches —
 * did not forward them either.
 *
 * Driven from the WT SOURCE template (brand-library ships rules), through the
 * real door schemas, the real body builder, and the real
 * `applyPackagePostWorkspace`, with only the rule applier spied: the assertion
 * is that the template's own rules VALUE arrives there.
 *
 * NOT covered: `toWorkspaceDefinition` deliberately omits `rules` (define.ts —
 * "the workspace door has no rules field"), so a browser fresh-create that
 * sends the workspace definition carries none; those spaces receive their
 * rules from the boot reconcile (reconcile-workspaces-to-templates).
 */
import { describe, it, expect, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  applyTemplateRules: vi.fn(async (_input: Record<string, unknown>) => [] as unknown[]),
}));

vi.mock("../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../routers/hub-protocol/utils.js")
  >()),
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("../services/rules/template-rules.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/rules/template-rules.js")
  >()),
  applyTemplateRules: h.applyTemplateRules,
}));

import { PackageApplySchema } from "../routers/hub-protocol/rest/packages.js";
import { definitionEngineProcedures } from "../routers/workspaces/definition-engine.js";
import { buildPostWorkspaceBodyFromDefinition } from "../routers/workspaces/helpers.js";
import { applyPackagePostWorkspace } from "../services/package-apply-post-workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const WT_DEFINE = join(
  here,
  "../../../../../synap-app/packages/workspace-templates/src/define.ts"
);
const SLUG = "brand-library";
const WS = "00000000-0000-4000-8000-000000000001";

async function pkg(): Promise<Record<string, unknown>> {
  const { toPackageDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  return toPackageDefinition(SLUG) as Record<string, unknown>;
}
async function wsDef(): Promise<Record<string, unknown>> {
  const { toWorkspaceDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  return toWorkspaceDefinition(SLUG).definition as Record<string, unknown>;
}
type Parser = { parse: (v: unknown) => unknown };
const inputOf = (name: "createFromDefinition" | "reconcileFromDefinition") =>
  (
    definitionEngineProcedures[name] as unknown as {
      _def: { inputs: Parser[] };
    }
  )._def.inputs[0]!;

describe("template rules — every install door carries them to the applier", () => {
  it("the source template ships rules (non-vacuity)", async () => {
    const rules = (await pkg()).rules as Array<{ key: string }>;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => typeof r.key === "string")).toBe(true);
  });

  it("Hub /packages/apply: parsed body → applyPackagePostWorkspace → applyTemplateRules", async () => {
    const source = await pkg();
    const body = PackageApplySchema.parse(source);
    expect(body.rules).toEqual(source.rules);

    h.applyTemplateRules.mockClear();
    // Only the rules layer: the other layers are absent, so no db is touched.
    const result = await applyPackagePostWorkspace({
      workspaceId: WS,
      body: { _meta: { slug: SLUG }, rules: body.rules },
      userId: "u1",
      scopes: [],
    });
    expect(h.applyTemplateRules).toHaveBeenCalledTimes(1);
    expect(h.applyTemplateRules.mock.calls[0]![0]).toMatchObject({
      workspaceId: WS,
      templateSlug: SLUG,
      rules: source.rules,
    });
    expect(result.rules).toEqual([]);
  });

  it("tRPC createFromDefinition: input keeps rules, the one builder forwards them", async () => {
    const source = await pkg();
    const parsed = inputOf("createFromDefinition").parse({
      definition: { ...(await wsDef()), rules: source.rules },
    }) as { definition: Record<string, unknown> };
    expect(parsed.definition.rules).toEqual(source.rules);
    const body = buildPostWorkspaceBodyFromDefinition(
      parsed.definition as Parameters<
        typeof buildPostWorkspaceBodyFromDefinition
      >[0],
      WS
    );
    expect(body.rules).toEqual(source.rules);
  });

  it("tRPC reconcileFromDefinition: input keeps rules (not passthrough)", async () => {
    const source = await pkg();
    const parsed = inputOf("reconcileFromDefinition").parse({
      workspaceId: WS,
      definition: { rules: source.rules },
    }) as { definition: Record<string, unknown> };
    expect(parsed.definition.rules).toEqual(source.rules);
  });
});
