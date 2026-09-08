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

  it("threads contentKind through — the slot `renderersForType` filters on", async () => {
    // Without it the row lands as the column default `widget`, which
    // `renderersForType('entity-detail'|'entity-profile'|'collection')` never
    // returns: installed, and unpickable as a renderer forever.
    await installCellFromDefinition({
      definition: { ...BASE, contentKind: "entity-detail" },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().contentKind).toBe("entity-detail");
  });

  it("derives contentKind=collection from viewTypes when the package predates the field", async () => {
    await installCellFromDefinition({
      definition: { ...BASE, viewTypes: ["table"] },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().contentKind).toBe("collection");
  });

  it("an explicit contentKind wins over the viewTypes derivation", async () => {
    await installCellFromDefinition({
      definition: {
        ...BASE,
        viewTypes: ["table"],
        contentKind: "entity-profile",
      },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().contentKind).toBe("entity-profile");
  });

  /**
   * The MECHANISM, the third field of this exact drop class. The exporter had
   * no `rendererType` filter, the CP payload no slot, and this mapping never
   * passed one — so `defineCell` applied its `"frame"` default and an `iframe`
   * HTML Card installed as an ESM React cell that cannot mount.
   */
  it("threads rendererType through — an iframe Card installs as an iframe", async () => {
    await installCellFromDefinition({
      definition: { ...BASE, rendererType: "iframe" },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().rendererType).toBe("iframe");
  });

  it("passes rendererType as UNDEFINED when unstated, and drops a bogus value", async () => {
    // Unstated ⇒ omit-is-silence: `defineCell` applies its "frame" default on
    // insert and leaves an existing row's mechanism untouched.
    await installCellFromDefinition({
      definition: { ...BASE },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().rendererType).toBeUndefined();

    // A package payload must never smuggle host-code mechanisms into the
    // column, so an unrecognised value is dropped rather than forwarded.
    await installCellFromDefinition({
      definition: {
        ...BASE,
        rendererType: "native" as unknown as "iframe",
      },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg(1).rendererType).toBeUndefined();
  });

  it("threads minSize through — the floor an installed Card needs to render", async () => {
    await installCellFromDefinition({
      definition: { ...BASE, minSize: { w: 4, h: 3 } },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().minSize).toEqual({ w: 4, h: 3 });
  });

  it("forwards an EXPLICIT empty externalHosts — revocation must reach the row", async () => {
    // `[]` is the only way a re-published Card can REMOVE an origin it once
    // declared: `defineCell` maps it to null ("reaches no external origin"),
    // whereas an absent list is silence and leaves the old grant standing.
    await installCellFromDefinition({
      definition: { ...BASE, externalHosts: [] },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().externalHosts).toEqual([]);
  });

  it("passes contentKind as UNDEFINED on no signal, and ignores a bogus value", async () => {
    // Same omit-is-silence rule as viewTypes: an upsert must not stamp `widget`
    // over a kind a previous install declared, and an unknown string must not
    // reach a column typed by a union.
    await installCellFromDefinition({
      definition: BASE,
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().contentKind).toBeUndefined();

    await installCellFromDefinition({
      definition: { ...BASE, contentKind: "not-a-kind" },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg(1).contentKind).toBeUndefined();
  });

  it("threads externalHosts through — the frame's declared egress grant", async () => {
    // The list the browser composes into the frame's `connect-src`. Dropped
    // here, a cell a human approved WITH a disclosed host list installs
    // network-contained: every request it exists to make fails as a CSP
    // violation inside an opaque frame that reports to no surface.
    await installCellFromDefinition({
      definition: { ...BASE, externalHosts: ["https://api.vendor.com"] },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().externalHosts).toEqual(["https://api.vendor.com"]);
  });

  it("passes externalHosts as UNDEFINED when unstated, never []", async () => {
    // Same omit-is-silence rule as viewTypes, and it matters MORE here: `[]`
    // means "revoke", so a source-only re-push that said nothing about egress
    // would silently break an installed connected cell.
    await installCellFromDefinition({
      definition: BASE,
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg().externalHosts).toBeUndefined();

    // An EXPLICIT empty array is a real revocation and must reach the door.
    await installCellFromDefinition({
      definition: { ...BASE, externalHosts: [] },
      name: "Todo Table",
      packageSlug: "crm",
      workspaceId: "ws-1",
      userId: "u-1",
    });
    expect(callArg(1).externalHosts).toEqual([]);
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
