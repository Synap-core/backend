/**
 * ROUND TRIP: grants.yaml's "Grant Process" through EVERY playbook-definition
 * door, asserting `scope: "project"` + its 6 stages ARRIVE — at
 * `playbooks.create`'s input where the door reaches it, never merely "the key is
 * declared" (guards-and-tests: reachability, not shape).
 *
 * The defect this pins: every door re-declared its own playbook z.object and
 * zod stripped what it forgot. Hub `/packages/apply` (+ `market.install` and the
 * approve executor, which inherit its parse) dropped scope/stages/criteria/
 * expectedOutputs/metadata; the browser `createFromDefinition` door dropped
 * scope/stages/criteria/metadata AND its body builder re-listed fields;
 * `/capabilities` + `/loops` dropped scope; the `--from-project` exporter never
 * selected them. So a shipped PROJECT method reached no pod as a method.
 *
 * Driven with the REAL template: the generated WT source module (same seam as
 * database/.../reconcile-workspace-automations-commands.test.ts), not the
 * backend's pinned npm bundle — the pinned 0.11.0 bundle predates `scope` on
 * grants.yaml (bumping the pin is a founder step; see the W3a report).
 *
 * DOOR SET: the doors that `.extend` the ONE schema are DERIVED by scanning
 * src for `playbookDefinitionSchema.extend(` / `packagePlaybookDefinitionSchema`
 * and every one must be exercised below (the last test) — a new door joins the
 * check by existing. What this does NOT execute: the approve executor and
 * `market.install` are asserted to reuse the Hub door's parse (source scan),
 * not run; `/capabilities` is asserted at its parse (its applier forwards
 * scope/stages — create-from-definition.ts, read, not executed here).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const { createPlaybookMock } = vi.hoisted(() => ({
  createPlaybookMock: vi.fn(async (_input: Record<string, unknown>) => ({
    status: "created",
    playbook: { id: "33333333-3333-3333-3333-333333333333" },
    proposalId: null,
  })),
}));

vi.mock("../routers/playbooks.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../routers/playbooks.js")>();
  return {
    ...actual,
    playbooksRouter: {
      ...actual.playbooksRouter,
      createCaller: () => ({ create: createPlaybookMock }),
    },
  };
});
vi.mock("../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../routers/hub-protocol/utils.js")
  >()),
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("../services/links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
}));
// db.select()...limit() → [] : no existing playbook to reuse ⇒ create runs.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [] as unknown[],
  };
  return { ...actual, db: { select: () => chain } };
});

import { PackageApplySchema } from "../routers/hub-protocol/rest/packages.js";
import { PlaybookDefSchema } from "../routers/hub-protocol/rest/capabilities.js";
import { LoopPlaybookDefSchema } from "../routers/hub-protocol/rest/loops.js";
import { definitionEngineProcedures } from "../routers/workspaces/definition-engine.js";
import { buildPostWorkspaceBodyFromDefinition } from "../routers/workspaces/helpers.js";
import { applyPackagePostWorkspace } from "../services/package-apply-post-workspace.js";
import { createLoopFromDefinition } from "../services/loops/create-from-definition.js";
import { playbookRowToPackagePlaybook } from "../services/workspace-to-package-definition.js";
import { createInputSchema } from "../routers/playbooks.js";
import type { LoopDefinition } from "@synap/playbooks";
import type { Context } from "../types/context.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const WT_DEFINE = join(
  here,
  "../../../../../synap-app/packages/workspace-templates/src/define.ts"
);

const GRANT_STAGE_KEYS = [
  "identify",
  "draft",
  "submit",
  "awaiting",
  "awarded",
  "delivering",
];
const WS = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

type Pb = Record<string, unknown> & { name: string };

async function grantsPackage(): Promise<Record<string, unknown>> {
  const { toPackageDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  return toPackageDefinition("grants") as Record<string, unknown>;
}
async function grantsWorkspaceDefinition(): Promise<Record<string, unknown>> {
  const { toWorkspaceDefinition } = await import(/* @vite-ignore */ WT_DEFINE);
  return toWorkspaceDefinition("grants").definition as Record<string, unknown>;
}
const grantProcess = (playbooks: unknown): Pb => {
  const gp = (playbooks as Pb[]).find((p) => p.name === "Grant Process");
  expect(gp, "Grant Process not in the parsed playbooks").toBeDefined();
  return gp!;
};
function expectMethod(pb: Record<string, unknown>, door: string): void {
  expect(pb.scope, `${door}: scope`).toBe("project");
  const stages = pb.stages as Array<{ key: string }> | undefined;
  expect(
    stages?.map((s) => s.key),
    `${door}: stages`
  ).toEqual(GRANT_STAGE_KEYS);
}
const lastCreate = () =>
  createPlaybookMock.mock.calls.at(-1)![0] as Record<string, unknown>;

describe("playbook definition round trip — grants.yaml Grant Process", () => {
  beforeEach(() => createPlaybookMock.mockClear());

  it("the source template itself is a 6-step project method (non-vacuity)", async () => {
    expectMethod(
      grantProcess((await grantsPackage()).playbooks),
      "grants.yaml"
    );
  });

  it("Hub /packages/apply → applier → playbooks.create", async () => {
    const parsed = PackageApplySchema.parse(await grantsPackage());
    expectMethod(grantProcess(parsed.playbooks), "Hub parse");
    const gp = grantProcess(parsed.playbooks);
    const res = await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { playbooks: [gp], _meta: { slug: "grants", version: "h-1" } },
    } as never);
    expect(createPlaybookMock).toHaveBeenCalledTimes(1);
    expectMethod(lastCreate(), "Hub applier create");
    // The created row carries its package source-link (managed baseline).
    const ms = (lastCreate().metadata as Record<string, unknown>)
      .marketSource as {
      packageSlug: string;
      baseline: Record<string, unknown>;
    };
    expect(ms.packageSlug).toBe("grants");
    expectMethod(ms.baseline, "marketSource baseline");
    // And the install result carries the scope (offer "Start on a project…").
    expect((res.playbooks as Array<{ scope?: string }>)[0].scope).toBe(
      "project"
    );
  });

  it("market.install + the approve executor reuse the Hub door's parse", () => {
    const install = readFileSync(
      join(SRC, "services/capabilities/marketplace-install.ts"),
      "utf8"
    );
    expect(install).toMatch(/PackageApplySchema\.safeParse\(definition\)/);
    const exec = readFileSync(
      join(SRC, "routers/proposals/executors/workspace.ts"),
      "utf8"
    );
    // The executor applies the STORED definition, which the Hub door stored
    // AFTER its parse — so it inherits exactly what that parse keeps.
    expect(exec).toMatch(/applyPackagePostWorkspace\(/);
  });

  it("tRPC createFromDefinition → body builder → loop applier → playbooks.create", async () => {
    const def = await grantsWorkspaceDefinition();
    const inputSchema = (
      definitionEngineProcedures.createFromDefinition as unknown as {
        _def: { inputs: Array<{ parse: (v: unknown) => unknown }> };
      }
    )._def.inputs[0]!;
    const parsed = inputSchema.parse({ definition: def }) as {
      definition: Parameters<typeof buildPostWorkspaceBodyFromDefinition>[0];
    };
    expectMethod(grantProcess(parsed.definition.playbooks), "tRPC parse");
    const body = buildPostWorkspaceBodyFromDefinition(parsed.definition, WS);
    const loop = body.loops![0]!.definition as unknown as LoopDefinition;
    expectMethod(grantProcess(loop.playbooks), "body builder");
    await createLoopFromDefinition({ ...loop, triggers: [] }, {}, {
      userId: USER,
      workspaceId: WS,
    } as unknown as Context);
    const gpCall = createPlaybookMock.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((c) => c.name === "Grant Process");
    expectMethod(gpCall!, "loop applier create");
  });

  it("Hub /capabilities playbook parse", async () => {
    const gp = grantProcess((await grantsPackage()).playbooks);
    expectMethod(
      PlaybookDefSchema.parse(gp) as Record<string, unknown>,
      "/capabilities"
    );
  });

  it("Hub /loops → loop applier → playbooks.create", async () => {
    const gp = grantProcess((await grantsPackage()).playbooks);
    // A loop authors grants as RESOLVED `{kind, id}` pairs (a template's grant
    // NAMES go through the package door, which resolves them) — so the name
    // list is dropped here; every definition field travels as authored.
    const parsed = LoopPlaybookDefSchema.parse({
      ...gp,
      ref: "grant",
      grants: undefined,
    });
    expectMethod(parsed as Record<string, unknown>, "/loops parse");
    await createLoopFromDefinition(
      {
        key: "k",
        name: "k",
        playbooks: [parsed] as unknown as LoopDefinition["playbooks"],
        triggers: [],
      },
      {},
      { userId: USER, workspaceId: WS } as unknown as Context
    );
    expectMethod(lastCreate(), "/loops applier create");
  });

  it("the router's own create input keeps them (playbooks.create)", async () => {
    const gp = grantProcess((await grantsPackage()).playbooks);
    expectMethod(
      createInputSchema.parse(gp) as Record<string, unknown>,
      "playbooks.create input"
    );
  });

  it("--from-project export → re-install parse keeps scope + stages", async () => {
    // Install once through the Hub door, take what reached playbooks.create as
    // the stored row, export it, and push the export back through the door.
    const parsed = PackageApplySchema.parse(await grantsPackage());
    await applyPackagePostWorkspace({
      workspaceId: WS,
      userId: USER,
      body: { playbooks: [grantProcess(parsed.playbooks)] },
    } as never);
    const row = lastCreate();
    const exported = playbookRowToPackagePlaybook(
      {
        name: row.name as string,
        description: (row.description as string) ?? null,
        goalTemplate: row.goalTemplate as string,
        params: row.params ?? [],
        executor: (row.executor as string) ?? "is-agent",
        inputStrategy: row.inputStrategy ?? { kind: "none" },
        channelSpec: row.channelSpec ?? {},
        schedule: row.schedule ?? null,
        subjectProfile: row.subjectProfile ?? null,
        status: (row.status as string) ?? "active",
        scope: (row.scope as string) ?? null,
        stages: row.stages ?? [],
        criteria: row.criteria ?? [],
        expectedOutputs: row.expectedOutputs ?? [],
        metadata: row.metadata ?? {},
      },
      undefined
    );
    const reparsed = PackageApplySchema.parse({
      _meta: { slug: "exported" },
      workspaceName: "x",
      profiles: [],
      playbooks: [exported],
    });
    expectMethod(grantProcess(reparsed.playbooks), "export → re-install");
  });

  it("every door that extends the ONE schema is exercised here (derived set)", () => {
    const EXERCISED = new Set([
      "routers/playbooks.ts",
      "routers/hub-protocol/rest/capabilities.ts",
      "routers/hub-protocol/rest/loops.ts",
      "routers/workspaces/definition-engine.ts",
      "routers/hub-protocol/rest/packages.ts",
      // defines the schemas themselves
      "schemas/playbook-definition.ts",
      // not a door: the template reconcile normalizes `desired` through the
      // package schema (covered by playbook-market-source.test.ts)
      "services/playbooks/playbook-market-source.ts",
    ]);
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "node_modules" || name === "dist") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          const src = readFileSync(p, "utf8");
          if (
            /\bplaybookDefinitionSchema\b|\bpackagePlaybookDefinitionSchema\b/.test(
              src
            )
          )
            found.push(relative(SRC, p));
        }
      }
    };
    walk(SRC);
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found.filter((f) => !EXERCISED.has(f))).toEqual([]);
  });
});
