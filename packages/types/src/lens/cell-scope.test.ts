/**
 * The scope a cell reads inside a document: ONE rule for the web and the
 * phone (`./cell-scope.ts`). The rows are the ones where the two former copies
 * (web `cellLensScope` + `documentLensScope`, relay `documentCellScope`)
 * DISAGREED or could be confused: a pod scope under a host space (the web
 * narrowed, the phone did not), the host's space against the document's own,
 * a non-pod scope under a host space (never narrowed).
 */
import { describe, expect, it } from "vitest";
import {
  cellLensScope,
  documentCellScope,
  documentLensScope,
} from "./cell-scope.js";
import type { LensScope } from "./scope.js";

const T: LensScope = { kind: "track", trackId: "t1" };
const POD: LensScope = { kind: "pod" };
const HOST_W2 = { workspaceScope: { type: "workspace", workspaceId: "w2" } };

describe("cellLensScope: what the host stamped, else the cell's space, else the pod", () => {
  it("a stamped scope wins over every floor", () => {
    expect(
      cellLensScope({
        lensScope: T,
        workspaceId: "w",
        workspaceScope: { type: "workspace", workspaceId: "w2" },
      })
    ).toBe(T);
  });

  it("an explicit workspace floor beats the cell's workspace id", () => {
    expect(
      cellLensScope({
        workspaceId: "w",
        workspaceScope: { type: "workspace", workspaceId: "w2" },
      })
    ).toEqual({ kind: "workspace", workspaceId: "w2" });
  });

  it("a floor that names no space defers to the cell's workspace id", () => {
    expect(
      cellLensScope({ workspaceId: "w", workspaceScope: { type: "active" } })
    ).toEqual({ kind: "workspace", workspaceId: "w" });
    expect(
      cellLensScope({ workspaceId: "w", workspaceScope: { type: "workspace" } })
    ).toEqual({ kind: "workspace", workspaceId: "w" });
    expect(cellLensScope({ workspaceId: "w" })).toEqual({
      kind: "workspace",
      workspaceId: "w",
    });
  });

  it("a pod floor is the pod, even with a workspace id", () => {
    expect(
      cellLensScope({ workspaceId: "w", workspaceScope: { type: "pod" } })
    ).toEqual(POD);
  });

  it("nothing known is the pod", () => {
    expect(
      cellLensScope({ workspaceId: "", workspaceScope: { type: "active" } })
    ).toEqual(POD);
    expect(cellLensScope({})).toEqual(POD);
  });
});

describe("documentLensScope: a pod scope under a host space is that space", () => {
  it("narrows a pod scope to the space the host pinned", () => {
    expect(documentLensScope(POD, HOST_W2)).toEqual({
      kind: "workspace",
      workspaceId: "w2",
    });
  });

  it("keeps a pod scope when the host pinned no space", () => {
    expect(documentLensScope(POD, {})).toEqual(POD);
    expect(
      documentLensScope(POD, { workspaceScope: { type: "active" } })
    ).toEqual(POD);
    expect(documentLensScope(POD, { workspaceScope: { type: "pod" } })).toEqual(
      POD
    );
  });

  it("never narrows a scope that is not the pod", () => {
    expect(documentLensScope(T, HOST_W2)).toBe(T);
    const own: LensScope = { kind: "workspace", workspaceId: "w1" };
    expect(documentLensScope(own, HOST_W2)).toBe(own);
  });
});

describe("documentCellScope: the scope every cell of a document reads", () => {
  it("the stored scope, else the document's space, else the pod (the phone's rows)", () => {
    expect(documentCellScope({ scope: T, workspaceId: "w1" })).toEqual(T);
    expect(documentCellScope({ scope: null, workspaceId: "w1" })).toEqual({
      kind: "workspace",
      workspaceId: "w1",
    });
    expect(documentCellScope({ scope: null, workspaceId: null })).toEqual(POD);
  });

  it("a pod-scoped document read inside a space reads that space (the web's narrowing)", () => {
    expect(
      documentCellScope({ scope: POD, workspaceId: null }, HOST_W2)
    ).toEqual({ kind: "workspace", workspaceId: "w2" });
  });

  it("a pod-scoped document with no host floor reads its own space (the phone reads what the web reads inside it)", () => {
    // Review A6 (4 Nov 2026): a host that pins no space (the phone) defaults
    // the floor to the document's space, so a pod scope stored on a space's
    // document reads that space, as the web reads it inside the space.
    expect(documentCellScope({ scope: POD, workspaceId: "w1" })).toEqual({
      kind: "workspace",
      workspaceId: "w1",
    });
    expect(documentCellScope({ scope: POD, workspaceId: "w1" }, {})).toEqual({
      kind: "workspace",
      workspaceId: "w1",
    });
    expect(
      documentCellScope(
        { scope: POD, workspaceId: "w1" },
        { workspaceScope: { type: "active" } }
      )
    ).toEqual({ kind: "workspace", workspaceId: "w1" });
  });

  it("a host floor still wins: its pinned space, or the pod on purpose", () => {
    expect(
      documentCellScope({ scope: POD, workspaceId: "w1" }, HOST_W2)
    ).toEqual({ kind: "workspace", workspaceId: "w2" });
    expect(
      documentCellScope(
        { scope: POD, workspaceId: "w1" },
        { workspaceScope: { type: "pod" } }
      )
    ).toEqual(POD);
  });

  it("a pod-wide document (no space) with no host floor stays the pod", () => {
    expect(documentCellScope({ scope: POD, workspaceId: null })).toEqual(POD);
  });

  it("a document with no stored scope reads its own space, not the host's", () => {
    expect(
      documentCellScope({ scope: null, workspaceId: "w1" }, HOST_W2)
    ).toEqual({ kind: "workspace", workspaceId: "w1" });
  });

  it("a pod-wide document with no stored scope is the pod under any host", () => {
    expect(
      documentCellScope({ scope: null, workspaceId: null }, HOST_W2)
    ).toEqual(POD);
  });
});
