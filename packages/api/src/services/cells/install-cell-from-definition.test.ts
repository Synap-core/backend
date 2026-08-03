/**
 * The mapping both cell-install doors share. What matters here is not that it
 * "runs" but that the two properties a silent drop would break are preserved:
 * the namespaced typeKey (so a re-install through the OTHER door converges on
 * the same row instead of minting a duplicate renderer) and `viewTypes` (no
 * affinity → the render chokepoint can never select the cell).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const defineCell = vi.fn(async (_input: Record<string, unknown>) => ({
  typeKey: "stub",
  changeType: "created" as const,
}));
vi.mock("./define-cell.js", () => ({ defineCell }));

/** The single `defineCell` argument of the Nth call. */
function callArg(n = 0): Record<string, unknown> {
  const call = defineCell.mock.calls[n];
  if (!call) throw new Error(`defineCell was not called ${n + 1} time(s)`);
  return call[0];
}

const { installCellFromDefinition, packageCellTypeKey } =
  await import("./install-cell-from-definition.js");

const BASE = {
  key: "todo-table",
  name: "Todo Table",
  code: "export default () => null;",
};

beforeEach(() => defineCell.mockClear());

describe("installCellFromDefinition", () => {
  it("derives the namespaced typeKey from package + cell key", async () => {
    await installCellFromDefinition({
      definition: BASE,
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(defineCell).toHaveBeenCalledTimes(1);
    const arg = callArg();
    expect(arg.typeKey).toBe("cell:crm:todo-table");
    expect(arg.typeKey).toBe(packageCellTypeKey("crm", "todo-table"));
    expect(arg.workspaceId).toBe("ws-1");
    expect(arg.rendererSource).toBe(BASE.code);
  });

  it("threads viewTypes through — the affinity the renderer chain needs", async () => {
    await installCellFromDefinition({
      definition: { ...BASE, viewTypes: ["table", "list"] },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    const arg = callArg();
    expect(arg.viewTypes).toEqual(["table", "list"]);
  });

  it("passes viewTypes as UNDEFINED when unstated, never []", async () => {
    // `defineCell` treats `[]`/null as "clear the stored affinity" and
    // `undefined` as "say nothing". A payload silent about affinity must not
    // erase one a previous install declared.
    await installCellFromDefinition({
      definition: BASE,
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    const arg = callArg();
    expect(arg.viewTypes).toBeUndefined();
  });

  it("an explicit cellKey overrides the definition's own key", async () => {
    await installCellFromDefinition({
      definition: BASE,
      name: "Todo Table",
      packageSlug: "pkg",
      cellKey: "from-slug",
      workspaceId: null,
      userId: "u-1",
    });
    const arg = callArg();
    expect(arg.typeKey).toBe("cell:pkg:from-slug");
  });

  it("refuses a cell with no renderer source, without touching the write door", async () => {
    await expect(
      installCellFromDefinition({
        definition: { key: "broken", name: "Broken" },
        name: "Broken",
        packageSlug: "crm",
        userId: "u-1",
      })
    ).rejects.toThrow(/renderer source/);
    expect(defineCell).not.toHaveBeenCalled();
  });

  it("refuses a keyless cell — there is no stable row to install under", async () => {
    await expect(
      installCellFromDefinition({
        definition: { name: "Anon", code: "x" },
        name: "Anon",
        packageSlug: "crm",
        userId: "u-1",
      })
    ).rejects.toThrow(/no key/);
    expect(defineCell).not.toHaveBeenCalled();
  });
});
