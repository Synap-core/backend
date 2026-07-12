import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — workspace placement has ONE door (WorkspaceResolutionService).
 *
 * Wave 1 collapsed every "which workspace does this land in?" decision into
 * `resolveWorkspacePlacement()` in `@synap/database` (the one home the api
 * handlers AND the @synap/jobs materializer can both import). This test locks
 * the four properties that keep the four-door bug (R1) from re-opening:
 *
 *   (a) The agent/proposal/n8n create doors NEVER stamp the ambient workspace
 *       as a `targetWorkspaceId` — only an EXPLICIT caller-supplied workspace
 *       becomes one. Re-introducing `targetWorkspaceId: <ambient>` is exactly
 *       the governance-changes-where-data-lands bug.
 *   (b) The materializer reads the resolved placement back through
 *       `resolveMaterializedEntityWorkspaceId` — it must not re-derive.
 *   (c) The `entities.create` + `capture.execute` doors call the resolver.
 *   (d) The K1 entity-scope precedence has exactly ONE implementation
 *       (`export function resolveEntityWorkspacePlacement` lives only in
 *       @synap/database; the api lib file re-exports it, never re-defines).
 *
 * If a check fails: route through `resolveWorkspacePlacement` /
 * `resolveMaterializedEntityWorkspaceId` instead of hand-rolling placement.
 */

// packages/api (cwd during the api test run) → packages/
const PACKAGES_ROOT = join(process.cwd(), "..");

function read(relFromPackages: string): string {
  const p = join(PACKAGES_ROOT, relFromPackages);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Strip line + block comments so a comment mentioning the token isn't a hit. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\S*\/\/.*$/gm, (m) => m.replace(/\/\/.*$/, ""));
}

describe("tripwire: workspace placement has one door", () => {
  it("(a) agent / n8n create doors never stamp the ambient workspace as targetWorkspaceId", () => {
    const files = [
      "api/src/routers/hub-protocol/entities.ts",
      "api/src/routers/n8n/actions.ts",
    ];
    // The ambient/auth workspace being forced into a targetWorkspaceId is the
    // R1 bug. Only an explicit `input.workspaceId` may become one. Matched
    // structurally (any *WorkspaceId-shaped identifier, or ctx.workspaceId)
    // rather than by an enumerated name list — a name-list missed this
    // wave's own `authWorkspaceId` → `ambientWorkspaceId` rename, letting
    // the exact convention it just established sail through un-caught.
    const AMBIENT_FALLBACK =
      /targetWorkspaceId:\s*(\w*[Ww]orkspaceId|ctx\.workspaceId)\b/;
    const offenders = files.filter((f) =>
      AMBIENT_FALLBACK.test(stripComments(read(f)))
    );
    expect(offenders).toEqual([]);
  });

  it("(b) the materializer reads placement back via resolveMaterializedEntityWorkspaceId", () => {
    const src = read("jobs/src/workers/materializer.ts");
    expect(src).toContain("resolveMaterializedEntityWorkspaceId");
  });

  it("(c) entities.create + capture.execute route through the resolver door", () => {
    expect(read("api/src/routers/entities.ts")).toContain(
      "resolveWorkspacePlacement"
    );
    expect(read("api/src/routers/capture.ts")).toContain(
      "resolveWorkspacePlacement"
    );
  });

  it("(d) exactly one K1-precedence implementation exists across packages", () => {
    const NEEDLE = "export function resolveEntityWorkspacePlacement";
    const roots = ["api/src", "database/src", "jobs/src"];
    let count = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".d.ts") &&
          !entry.name.endsWith(".test.ts")
        ) {
          if (readFileSync(p, "utf8").includes(NEEDLE)) count++;
        }
      }
    };
    for (const r of roots) {
      const abs = join(PACKAGES_ROOT, r);
      if (existsSync(abs)) walk(abs);
    }
    expect(count).toBe(1);
  });
});
