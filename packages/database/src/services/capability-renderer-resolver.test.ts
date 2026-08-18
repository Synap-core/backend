import { describe, it, expect, vi } from "vitest";

import {
  getEffectiveCapabilityRenderer,
  type CapabilityRendererPage,
} from "./profile-resolution-service.js";

const CAP_ID = "11111111-1111-1111-1111-111111111111";
const WS_ID = "22222222-2222-2222-2222-222222222222";

const overlayPage: CapabilityRendererPage = {
  slot: "overview",
  title: "Overview (workspace)",
  ref: { kind: "cell", cellKey: "ws-cell", props: {} },
};
const capPage: CapabilityRendererPage = {
  slot: "overview",
  title: "Overview (capability)",
  ref: {
    kind: "declarative",
    schema: [{ type: "heading", text: "Hi" }],
  },
};

/**
 * Fake db exposing only the two reads the resolver performs — a pure-logic test
 * of the 3-layer precedence, no Postgres. Mirrors profile-resolution-service.test.ts.
 */
function makeDb(opts: {
  workspaceSettings?: Record<string, unknown>;
  capabilityMetadata?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  return {
    query: {
      workspaces: {
        findFirst: vi.fn(async () =>
          opts.workspaceSettings !== undefined
            ? { settings: opts.workspaceSettings }
            : undefined
        ),
      },
      capabilities: {
        findFirst: vi.fn(async () =>
          opts.capabilityMetadata !== undefined
            ? { metadata: opts.capabilityMetadata }
            : undefined
        ),
      },
    },
  };
}

describe("getEffectiveCapabilityRenderer — 3-layer precedence", () => {
  it("layer 1: workspace overlay wins over capability default", async () => {
    const db = makeDb({
      workspaceSettings: {
        capabilityRenderers: { [CAP_ID]: { pages: [overlayPage] } },
      },
      capabilityMetadata: { renderers: { pages: [capPage] } },
    });

    const result = await getEffectiveCapabilityRenderer(db, CAP_ID, WS_ID);

    expect(result.source).toBe("workspace");
    expect(result.pages).toEqual([overlayPage]);
  });

  it("layer 2: capability default when no workspace overlay", async () => {
    const db = makeDb({
      workspaceSettings: {},
      capabilityMetadata: { renderers: { pages: [capPage] } },
    });

    const result = await getEffectiveCapabilityRenderer(db, CAP_ID, WS_ID);

    expect(result.source).toBe("capability");
    expect(result.pages).toEqual([capPage]);
  });

  it("layer 2: capability default when no workspace lens at all", async () => {
    const db = makeDb({
      capabilityMetadata: { renderers: { pages: [capPage] } },
    });

    const result = await getEffectiveCapabilityRenderer(db, CAP_ID, null);

    expect(result.source).toBe("capability");
    expect(result.pages).toEqual([capPage]);
  });

  it("layer 3: nothing bound → empty page-set, source 'default'", async () => {
    const db = makeDb({
      workspaceSettings: {},
      capabilityMetadata: {},
    });

    const result = await getEffectiveCapabilityRenderer(db, CAP_ID, WS_ID);

    expect(result.source).toBe("default");
    expect(result.pages).toEqual([]);
  });

  it("empty overlay page-set falls through to capability default (no accidental blanking)", async () => {
    const db = makeDb({
      workspaceSettings: {
        capabilityRenderers: { [CAP_ID]: { pages: [] } },
      },
      capabilityMetadata: { renderers: { pages: [capPage] } },
    });

    const result = await getEffectiveCapabilityRenderer(db, CAP_ID, WS_ID);

    expect(result.source).toBe("capability");
    expect(result.pages).toEqual([capPage]);
  });

  it("missing capability row → default (not a throw)", async () => {
    const db = makeDb({ workspaceSettings: {} });

    const result = await getEffectiveCapabilityRenderer(db, CAP_ID, WS_ID);

    expect(result.source).toBe("default");
    expect(result.pages).toEqual([]);
  });
});
