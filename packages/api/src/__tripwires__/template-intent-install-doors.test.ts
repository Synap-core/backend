/**
 * A template's `intent` (what the space produces — object-first homes)
 * survives every install door on its way to the settings writer.
 *
 * The defect class `template-lifecycle-install-doors.test.ts` pins for
 * lifecycles: the doors are zod objects that STRIP an undeclared key, and the
 * CP-cache path maps a package body field by field. Any one of them dropping
 * `intent` leaves a catalog install with no declared intent — silently, since
 * the home then infers one.
 *
 * Driven synthetically: what this asserts is the DOOR contract (a value that
 * enters arrives). The writer half (create/reconcile → `settings.intent`) is
 * pinned on PGlite by `@synap/database` `workspace-intent.pglite.test.ts`.
 *
 * Also pinned: an OVERLAY never carries the intent onto a base that has its
 * own template identity (it is the base template's to declare).
 */
import { describe, it, expect, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // `resolveWorkspaceTemplate` reads ONE cp_catalog_cache row.
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (h.row ? [h.row] : []),
  };
  return { ...actual, db: { select: () => chain } };
});

import { PackageApplySchema } from "../routers/hub-protocol/rest/packages.js";
import { definitionEngineProcedures } from "../routers/workspaces/definition-engine.js";
import { overlayDefinitionForIdentifiedBase } from "../services/compose-overlay.js";
import { resolveWorkspaceTemplate } from "../services/capabilities/resolve-workspace-template.js";
import { projectTemplateIntent } from "@synap/database";

const here = dirname(fileURLToPath(import.meta.url));
const WT_DEFINE = join(
  here,
  "../../../../../synap-app/packages/workspace-templates/src/define.ts"
);
type Define = {
  toPackageDefinition: (slug: string) => Record<string, unknown>;
  toWorkspaceDefinition: (slug: string) => {
    definition: Record<string, unknown>;
  };
};
const define = async () =>
  (await import(/* @vite-ignore */ WT_DEFINE)) as Define;

const WS = "00000000-0000-4000-8000-000000000001";
const INTENT = {
  label: "Sales",
  produces: [{ profile: "lead" }, { profile: "deal" }],
};

type Parser = { parse: (v: unknown) => unknown };
const inputOf = (name: "createFromDefinition" | "reconcileFromDefinition") =>
  (
    definitionEngineProcedures[name] as unknown as {
      _def: { inputs: Parser[] };
    }
  )._def.inputs[0]!;

describe("template intent — every install door carries it", () => {
  // Measured: this definition object is `.passthrough()` AND declares
  // `intent`, so removing either one alone stays green; removing both is red
  // (verified). The case pins that the door carries it, not which half does.
  it("tRPC createFromDefinition keeps it", () => {
    const parsed = inputOf("createFromDefinition").parse({
      definition: { workspaceName: "CRM", description: "d", intent: INTENT },
    }) as { definition: Record<string, unknown> };
    expect(parsed.definition.intent).toEqual(INTENT);
  });

  it("tRPC reconcileFromDefinition keeps it (not passthrough)", () => {
    const parsed = inputOf("reconcileFromDefinition").parse({
      workspaceId: WS,
      definition: { intent: INTENT },
    }) as { definition: Record<string, unknown> };
    expect(parsed.definition.intent).toEqual(INTENT);
  });

  it("Hub /packages/apply keeps it (plain z.object)", () => {
    const body = PackageApplySchema.parse({
      _meta: { slug: "crm" },
      workspaceName: "CRM",
      intent: INTENT,
    }) as { intent?: unknown };
    expect(body.intent).toEqual(INTENT);
  });

  it("the CP-cache path (installFromCatalog, boot reconcile) maps it off the package body", async () => {
    h.row = {
      source: "https://cp.test",
      version: "h-1",
      retiredAt: null,
      definition: {
        _meta: { slug: "crm" },
        workspaceName: "CRM",
        description: "d",
        profiles: [],
        intent: INTENT,
      },
    };
    const resolved = await resolveWorkspaceTemplate("crm");
    expect(resolved?.source).toBe("cache");
    expect(
      (resolved?.workspaceDefinition as { intent?: unknown } | undefined)
        ?.intent
    ).toEqual(INTENT);
  });

  it("an overlay onto an identified base never carries it", () => {
    const def = overlayDefinitionForIdentifiedBase({
      workspaceName: "Pack",
      intent: INTENT,
      profiles: [],
    } as never) as { intent?: unknown; profiles?: unknown };
    expect(def.intent).toBeUndefined();
    expect(def.profiles).toEqual([]);
  });

  // END TO END from the SOLD templates, through the real converters: the
  // catalog's own declaration arrives at the stored shape on both doors.
  it("the real crm package (Hub door) carries its intent top-level, never in _meta", async () => {
    const pkg = (await define()).toPackageDefinition("crm");
    expect((pkg._meta as Record<string, unknown>).intent).toBeUndefined();
    const body = PackageApplySchema.parse(pkg) as { intent?: unknown };
    expect(projectTemplateIntent(body.intent)).toEqual({
      label: "Sales",
      produces: expect.arrayContaining(["lead", "client", "deal"]),
      source: "template",
    });
  });

  it("the real builder workspace definition (tRPC door) carries its intent", async () => {
    const { definition } = (await define()).toWorkspaceDefinition(
      "builder-workspace"
    );
    const parsed = inputOf("createFromDefinition").parse({ definition }) as {
      definition: { intent?: unknown };
    };
    expect(projectTemplateIntent(parsed.definition.intent)).toEqual({
      label: "Product",
      produces: ["devplane_feature", "devplane_story", "ui-design"],
      source: "template",
    });
  });
});
