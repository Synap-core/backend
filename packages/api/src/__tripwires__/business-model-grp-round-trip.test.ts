/**
 * DRY-RUN PARSE: business-model.yaml (the canonical GRP, W4a) through the ONE
 * playbook-definition schema at every install door — asserting the track
 * template ARRIVES as a 6-step project method with its per-step `domain`
 * (reachability, not shape). Same seam as playbook-definition-round-trip:
 * driven from the WT SOURCE module, not the backend's pinned npm bundle.
 *
 * Also parses the W4a role REFERENCES (crm / business-developer / ecosystem —
 * slug + displayName + scope + profileKind, no body) through the tRPC
 * createFromDefinition input, which REQUIRES `displayName` on every profile: a
 * reference that dropped it would be refused at the browser install door.
 *
 * What this does NOT execute: the applier/reconcile writes (the round-trip
 * tripwire covers the applier path for grants with the same schema).
 */

import { describe, it, expect, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../routers/hub-protocol/utils.js")
  >()),
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));

import { PackageApplySchema } from "../routers/hub-protocol/rest/packages.js";
import { definitionEngineProcedures } from "../routers/workspaces/definition-engine.js";
import { createInputSchema } from "../routers/playbooks.js";

const here = dirname(fileURLToPath(import.meta.url));
const WT_DEFINE = join(
  here,
  "../../../../../synap-app/packages/workspace-templates/src/define.ts"
);

const GRP_STEPS: Array<[string, string]> = [
  ["porteur", "foundation"],
  ["offer_buyer", "foundation"],
  ["conventions_cost", "foundation"],
  ["money_means", "finance"],
  ["refutation", "research-base"],
  ["maintain", "foundation"],
];

type Pb = Record<string, unknown> & { name: string };
const grp = (playbooks: unknown): Pb => {
  const pb = (playbooks as Pb[]).find((p) => p.name === "Business Model (GRP)");
  expect(pb, "Business Model (GRP) not in the parsed playbooks").toBeDefined();
  return pb!;
};
function expectMethod(pb: Record<string, unknown>, door: string): void {
  expect(pb.scope, `${door}: scope`).toBe("project");
  const stages = pb.stages as Array<{ key: string; domain?: string }>;
  expect(
    stages?.map((s) => [s.key, s.domain]),
    `${door}: stages + domains`
  ).toEqual(GRP_STEPS);
}

async function pkg(slug: string): Promise<Record<string, unknown>> {
  const { toPackageDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  return toPackageDefinition(slug) as Record<string, unknown>;
}
async function wsDef(slug: string): Promise<Record<string, unknown>> {
  const { toWorkspaceDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  return toWorkspaceDefinition(slug).definition as Record<string, unknown>;
}
const trpcInput = () =>
  (
    definitionEngineProcedures.createFromDefinition as unknown as {
      _def: { inputs: Array<{ parse: (v: unknown) => unknown }> };
    }
  )._def.inputs[0]!;

describe("business-model.yaml (canonical GRP) — dry-run parse at every door", () => {
  it("source template: the method + its step domains (non-vacuity)", async () => {
    expectMethod(
      grp((await pkg("business-model")).playbooks),
      "business-model.yaml"
    );
  });

  it("Hub /packages/apply (+ market.install, approve executor) parse", async () => {
    const parsed = PackageApplySchema.parse(await pkg("business-model"));
    expectMethod(grp(parsed.playbooks), "Hub parse");
    expect((parsed.playbooks as Pb[]).map((p) => p.name).sort()).toEqual([
      "Business Model (GRP)",
      "GRP Deprecation Check",
    ]);
  });

  it("tRPC createFromDefinition input parse", async () => {
    const parsed = trpcInput().parse({
      definition: await wsDef("business-model"),
    }) as { definition: { playbooks: unknown } };
    expectMethod(grp(parsed.definition.playbooks), "tRPC parse");
  });

  it("playbooks.create input (the router's own schema, stage domains validated)", async () => {
    const parsed = createInputSchema.parse(
      grp((await pkg("business-model")).playbooks)
    ) as Record<string, unknown>;
    expectMethod(parsed, "playbooks.create input");
  });

  it("a step domain the pod refuses (a workspace id) fails the same parse", async () => {
    const m = grp((await pkg("business-model")).playbooks);
    const broken = {
      ...m,
      stages: (m.stages as Array<Record<string, unknown>>).map((s, i) =>
        i === 3 ? { ...s, domain: "38f3053c-11de-4e1d-95d6-9ef38506ff43" } : s
      ),
    };
    expect(createInputSchema.safeParse(broken).success).toBe(false);
  });

  it("role REFERENCES pass the tRPC door (displayName kept) for crm / business-developer / ecosystem", async () => {
    for (const slug of ["crm", "business-developer", "ecosystem"]) {
      const def = await wsDef(slug);
      const refs = (def.profiles as Array<Record<string, unknown>>).filter(
        (p) =>
          p.scope === "shared" && p.profileKind === "role" && !p.applicableKinds
      );
      expect(refs.length, `${slug}: no reference found`).toBeGreaterThan(0);
      const res = (
        trpcInput() as unknown as {
          safeParse: (v: unknown) => { success: boolean; error?: unknown };
        }
      ).safeParse({ definition: def });
      expect(res.success, `${slug}: ${JSON.stringify(res.error)}`).toBe(true);
    }
  });
});
