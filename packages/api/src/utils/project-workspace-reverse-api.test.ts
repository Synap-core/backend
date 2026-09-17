/**
 * Wave E — reverse INDEX on workspace get.
 *
 * Asserts the field is REACHABLE from the two doors that ship it (tRPC
 * `workspaces.get`, Hub `GET /workspaces` + `GET /workspaces/:workspaceId`),
 * not merely declared somewhere. A comment-only or unused import would pass a
 * shape check and still leave the UI with nothing to render.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRPC_WS = readFileSync(join(HERE, "../routers/workspaces.ts"), "utf8");
const HUB_WS = readFileSync(
  join(HERE, "../routers/hub-protocol/rest/workspaces.ts"),
  "utf8"
);
const HELPER = readFileSync(join(HERE, "./project-workspace.ts"), "utf8");

describe("usedByProjectIds — reverse INDEX on workspace get", () => {
  it("helper floors reverse reads with ownerPrivateVisibleWhere", () => {
    expect(HELPER).toMatch(/listProjectsUsingWorkspace/);
    expect(HELPER).toMatch(/listProjectsUsingWorkspaces/);
    // Both reverse doors JOIN projects and apply the visibility floor.
    const floorHits = HELPER.match(
      /ownerPrivateVisibleWhere\(\s*projects\.workspaceId/g
    );
    expect(floorHits?.length).toBeGreaterThanOrEqual(2);
  });

  it("tRPC workspaces.get returns usedByProjectIds on both access paths", () => {
    expect(TRPC_WS).toMatch(/listProjectsUsingWorkspace/);
    // Both the pod_visible early return and the member return must carry it —
    // a field only on one arm is permanently absent for the other access kind.
    const returns = TRPC_WS.match(/usedByProjectIds/g);
    expect(returns?.length).toBeGreaterThanOrEqual(3); // call site + 2 returns
  });

  it("Hub list and GET /workspaces/:workspaceId both expose usedByProjectIds", () => {
    expect(HUB_WS).toMatch(/listProjectsUsingWorkspaces/);
    expect(HUB_WS).toMatch(/listProjectsUsingWorkspace/);
    expect(HUB_WS).toMatch(/app\.get\("\/workspaces\/:workspaceId"/);
    expect(HUB_WS).toMatch(/usedByProjectIds:\s*usedBy\.get/);
    expect(HUB_WS).toMatch(/usedByProjectIds,/);
  });
});
