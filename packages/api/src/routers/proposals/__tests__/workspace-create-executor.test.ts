/**
 * Phase 0 — workspace/create governance placement.
 *
 * Source-level contracts (no DB, no materializeWorkspaceCore):
 *   1. approve-executors registers key "workspace/create"
 *   2. packages.apply gate data includes full `definition: body` (not name-only)
 *   3. MCP synap_create_workspace goes through checkPermissionOrPropose
 *
 * These are the three verified bugs from Phase 0 — locking them as tripwires.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// vitest cwd is the api package root.
const API_SRC = join(process.cwd(), "src");

function readSrc(relFromApiSrc: string): string {
  return readFileSync(join(API_SRC, relFromApiSrc), "utf8");
}

describe("workspace/create approve executor registration", () => {
  // Wave 1 router-decomposition moved workspace/* executors into their own
  // domain module; both keys checked here are still adjacent there.
  const src = readSrc("routers/proposals/executors/workspace.ts");

  it("registers key workspace/create", () => {
    expect(src).toMatch(/key:\s*["']workspace\/create["']/);
  });

  it("materializes via the ONE template apply (shared core, not a fork)", () => {
    // The executor body must call the shared apply — not invent a second
    // create path. Its body is `executeTemplateApplyApproval` (shared with the
    // template-update arm of `workspace/update`), so: the key delegates to it
    // (registered by reference), and it runs `applyTemplate` (which drives
    // the core and layer 2 — pinned by the market-install layer-2 tripwire)
    // from the stored definition.
    const createBlock = src.slice(
      src.indexOf('key: "workspace/create"'),
      src.indexOf('key: "workspace/join"')
    );
    expect(createBlock).toMatch(/execute:\s*executeTemplateApplyApproval\b/);
    const body = src.slice(
      src.indexOf("async function executeTemplateApplyApproval("),
      src.indexOf("export function registerWorkspaceExecutors(")
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("applyTemplate(");
    expect(body).toContain("inner.definition");
  });
});

describe("packages.apply gate data shape (Phase 0 contract)", () => {
  const src = readSrc("routers/hub-protocol/rest/packages.ts");

  it("stores full definition body on the gate, not name-only", () => {
    // Regression of the Phase-0 bug: data: { name: ... } only — approve cannot recreate.
    expect(src).toMatch(/definition:\s*body/);
    expect(src).toMatch(/source:\s*["']packages\.apply["']/);
    expect(src).toMatch(/createdBy:\s*["']provisioning["']/);
    // Must still gate on workspace create (an update when a space already
    // holds the template). Until W2 this regex matched the AUDIT log's
    // `action: "create"` literal, not the gate, which is a ternary.
    const gate = src.slice(src.indexOf("checkPermissionOrPropose({"));
    expect(gate).toMatch(/subjectType:\s*["']workspace["']/);
    expect(gate).toMatch(
      /action:[^\n]*\?\s*["']update["']\s*:\s*["']create["']/
    );
  });

  it("does not use name-only gate data", () => {
    // The old buggy shape was exactly: data: { name: body.workspaceName ?? ... }
    // on a single-field object. Ensure definition appears in the same data bag.
    const permBlock = src.slice(
      src.indexOf("checkPermissionOrPropose"),
      src.indexOf('if ("denied"')
    );
    expect(permBlock).toContain("definition: body");
    expect(permBlock).toContain("name:");
  });
});

describe("MCP synap_create_workspace is governed", () => {
  // Router-decomposition Wave 7 moved `synap_create_workspace` out of
  // `adapter.ts`'s switch into its own domain file.
  const src = readSrc("routers/mcp/handlers/workspace.ts");

  it("routes through checkPermissionOrPropose before materialize", () => {
    const start = src.indexOf("synap_create_workspace: async");
    const end = src.indexOf("synap_declare_workspace_source: async");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain("checkPermissionOrPropose");
    expect(block).toMatch(/subjectType:\s*["']workspace["']/);
    expect(block).toMatch(/action:\s*["']create["']/);
    expect(block).toContain('status: "proposed"');
    // Granted path runs the ONE template apply, and only AFTER the gate.
    const gate = block.indexOf("checkPermissionOrPropose(");
    const apply = block.indexOf("applyTemplate({");
    expect(gate).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(gate);
    // Definition rides in gate data for approve materialization.
    expect(block).toMatch(/definition,/);
  });
});

describe("packages.apply gate data shape (pure unit mirror)", () => {
  /**
   * Pure shape assertion mirroring hub-protocol/rest/packages.ts gate `data`.
   * If the apply door regresses to name-only, approve cannot materialize.
   */
  function buildPackagesApplyGateData(body: {
    workspaceName?: string;
    workspaceType?: string;
    _meta?: { slug?: string };
    profiles?: unknown[];
    views?: unknown[];
  }) {
    return {
      name: body.workspaceName ?? body._meta?.slug ?? "untitled",
      definition: body,
      workspaceName: body.workspaceName,
      templateId: body._meta?.slug,
      packageSlug: body._meta?.slug,
      workspaceType: body.workspaceType,
      proposalId: body._meta?.slug,
      createdBy: "provisioning" as const,
      source: "packages.apply" as const,
    };
  }

  it("includes full definition object, not name-only", () => {
    const body = {
      workspaceName: "Builder",
      workspaceType: "operational",
      _meta: { slug: "builder-workspace" },
      profiles: [{ slug: "task" }],
      views: [{ name: "Board", type: "kanban" }],
    };
    const data = buildPackagesApplyGateData(body);

    expect(data.name).toBe("Builder");
    expect(data.definition).toBe(body);
    expect(data.definition.profiles).toEqual([{ slug: "task" }]);
    expect(data.packageSlug).toBe("builder-workspace");
    expect(data.proposalId).toBe("builder-workspace");
    expect(data.createdBy).toBe("provisioning");
    expect(data.source).toBe("packages.apply");
  });
});
