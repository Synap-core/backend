/**
 * TRIPWIRE — the tRPC template doors report every install layer honestly.
 *
 * WHAT IT GUARDED, AND WHERE THAT MOVED (W3, APPLY-ONE-DOOR-PLAN). This file
 * used to scan `definition-engine.ts` for every `applyPackagePostWorkspace` /
 * `reconcileWorkspaceFromDefinition` call and assert its catch threw or pushed
 * an `InstallLayerReport` — because the defect was an ABSENCE (a catch that
 * logged and returned a clean payload), invisible to a behavioural test of a
 * mutation that still resolved. Since W3 those doors no longer call an install
 * layer at all: they are wrappers over the ONE template apply
 * (`template-door.ts` → `applyTemplate`), which records a layer-2 failure on
 * the space and hands it back as `layer2: {status: "failed"}`. The honesty
 * question therefore moved to two places, and this guards both:
 *
 *   1. `definition-engine.ts` never drives an install layer itself (a second,
 *      unreported copy is exactly how the three swallows got in). The only
 *      layer-1 call left is the write-free dry-run preview.
 *   2. The doors' reply carries the apply's verdict: a failed layer 2 becomes
 *      a `failed` layer entry, under a uniform `layers` key (never a
 *      conditional spread — that widened the reply into a union and hid
 *      `composed` from every consumer), and on the re-sync report too.
 *
 * That a door actually reaches the apply, and does not throw on a layer-2
 * failure, is the contract suite's scenario (4)
 * (`services/template-apply/template-apply.contract.pglite.test.ts`), which
 * drives `createFromDefinition`, `installFromCatalog` and
 * `reconcileFromDefinition` for real.
 *
 * NOT covered: a layer call spelled through an alias or a dynamic import in
 * `definition-engine.ts` (the scan reads plain call names).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { templateDoorReply, templateLayerReports } from "./template-door.js";
import type { TemplateApplyResult } from "../../services/template-apply/index.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The engine's code, comments blanked (a comment naming a call is not one). */
const SOURCE = readFileSync(join(here, "definition-engine.ts"), "utf8").replace(
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  ""
);

function callsOf(name: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, "g");
  for (const m of SOURCE.matchAll(re)) out.push(m.index!);
  return out;
}

describe("definition-engine never drives an install layer itself", () => {
  it("the scan still sees the engine's own calls (non-vacuity)", () => {
    // The one apply door it does call, and the dry-run preview.
    expect(callsOf("applyTemplateForTrpc").length).toBeGreaterThanOrEqual(3);
    expect(callsOf("reconcileWorkspaceFromDefinition")).toHaveLength(1);
  });

  it.each([
    "applyPackagePostWorkspace",
    "createWorkspaceFromDefinition",
    "createWorkspaceFromDefinitionIdempotent",
    "materializeWorkspaceCore",
    "finishTemplateApply",
    "reconcileWorkspaceIfStale",
    "applyLayerOne",
    "applyTemplate",
  ])("no direct %s( call", (name) => {
    expect(callsOf(name)).toEqual([]);
  });

  it("the one layer-1 call left is the write-free dry run", () => {
    const [idx] = callsOf("reconcileWorkspaceFromDefinition");
    const call = SOURCE.slice(idx, SOURCE.indexOf("});", idx));
    expect(call).toMatch(/dryRun:\s*true/);
    // …and it sits behind the dry-run branch, never on the apply path.
    expect(SOURCE.slice(Math.max(0, idx - 120), idx)).toMatch(
      /if\s*\(\s*input\.dryRun\s*\)/
    );
  });
});

describe("the doors' reply carries the apply's layer verdict", () => {
  const base = {
    workspaceId: "ws-1",
    outcome: "reconciled",
    materializeStatus: "reused",
    dependencies: [],
    finished: null,
    warning: null,
  } as const;
  const reconciled = {
    workspaceId: "ws-1",
    dryRun: false,
  } as unknown as NonNullable<
    NonNullable<TemplateApplyResult["layerOne"]>["reconciled"]
  >;
  const result = (layer2: TemplateApplyResult["layer2"]): TemplateApplyResult =>
    ({
      ...base,
      layer2,
      layerOne: {
        workspaceId: "ws-1",
        created: false,
        outcome: "reconciled",
        action: { kind: "resync", reason: "stale", reopen: false },
        reconciled,
      },
    }) as unknown as TemplateApplyResult;

  it("a layer 2 that threw is a failed post-workspace entry, on the reply and the re-sync report", () => {
    const reply = templateDoorReply(
      result({ status: "failed", error: new Error("boom") })
    );
    expect(reply.layers).toEqual([
      { layer: "post-workspace", status: "failed", message: "boom" },
    ]);
    expect(reply.reconciled?.layers).toEqual(reply.layers);
  });

  it("an applied layer 2 whose items errored is reported through the ONE summarizer", () => {
    const post = { capabilities: [{ status: "error", error: "no key" }] };
    expect(
      templateLayerReports({ layer2: { status: "applied", post } })
    ).toEqual([
      expect.objectContaining({ layer: "post-workspace", status: "failed" }),
    ]);
  });

  it("nothing failed → `layers` is present and undefined (a uniform key, not a spread)", () => {
    const reply = templateDoorReply(result({ status: "skipped" }));
    expect("layers" in reply).toBe(true);
    expect(reply.layers).toBeUndefined();
    expect(reply.reconciled).toBe(reconciled);
    expect(templateLayerReports({ layer2: { status: "skipped" } })).toEqual([]);
  });
});
