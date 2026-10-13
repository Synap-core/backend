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
  // NOT COVERED, measured: this definition object is `.passthrough()`, so
  // deleting its `intent` declaration stays green (verified); the case catches
  // the passthrough going away, not the typed declaration.
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
});
