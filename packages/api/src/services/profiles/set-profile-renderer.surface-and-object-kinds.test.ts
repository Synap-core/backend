/**
 * `setProfileRenderer` — which bindings mirror into the legacy stores, and
 * which must not demand a profile row.
 *
 * Two defects this pins, both behavioural (driven through the real function,
 * with only the DB layer faked):
 *
 *  1. A POD-scope binding for a NON-PROFILE object kind (`proposal`) threw
 *     NOT_FOUND: the preflight demanded a `profiles` row for a subject that is
 *     an object-nav kind, not a profile. It must bind, and never mirror.
 *  2. An `mcp-app`-surface binding must live ONLY in `renderer_bindings`. The
 *     legacy stores are IN-APP readers that know no surface — mirroring an
 *     outside-host cell into `profiles.defaultRenderers` would serve it to the
 *     browser/relay.
 *
 * And the control: a profile subject on the in-app surface still mirrors
 * exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  resolveProfile: vi.fn(),
  profileUpdate: vi.fn(),
  setRendererBinding: vi.fn(),
  revokeRendererBinding: vi.fn(),
  cellRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", () => ({
  getDb: async () => ({
    query: { workspaces: { findFirst: async () => null } },
    // widget_definitions lookup for the surface ↔ renderer-type check
    select: () => ({ from: () => ({ where: async () => calls.cellRows }) }),
  }),
  ProfileRepository: class {
    update = calls.profileUpdate;
  },
  ProfileResolutionService: class {
    resolveProfile = calls.resolveProfile;
  },
  WorkspaceRepository: class {},
  eventRepository: {},
  setRendererBinding: calls.setRendererBinding,
  revokeRendererBinding: calls.revokeRendererBinding,
  workspaces: {},
  widgetDefinitions: {},
  and: () => undefined,
  or: () => undefined,
  isNull: () => undefined,
  eq: () => undefined,
}));
vi.mock("./renderer-binding-authz.js", () => ({
  assertMayBindRenderer: async () => undefined,
}));

import {
  isNonProfileObjectKind,
  setProfileRenderer,
} from "./set-profile-renderer.js";

const ref = { kind: "cell" as const, cellKey: "proposal-card", props: {} };
const podInput = {
  userId: "u-1",
  workspaceId: null,
  slot: "detail" as const,
  ref,
  scope: "pod" as const,
};

beforeEach(() => {
  for (const fn of Object.values(calls)) {
    if (typeof fn === "function") fn.mockReset();
  }
  calls.cellRows = [];
  calls.resolveProfile.mockResolvedValue(null);
});

describe("isNonProfileObjectKind (read from OBJECT_KINDS)", () => {
  it("object-nav kinds are non-profile; entity profiles and custom slugs are not", () => {
    expect(isNonProfileObjectKind("proposal")).toBe(true);
    expect(isNonProfileObjectKind("session")).toBe(true);
    expect(isNonProfileObjectKind("capability")).toBe(true);
    expect(isNonProfileObjectKind("person")).toBe(false);
    expect(isNonProfileObjectKind("my-custom-profile")).toBe(false);
    // A prototype key is not a registered kind.
    expect(isNonProfileObjectKind("constructor")).toBe(false);
  });
});

describe("setProfileRenderer — pod-scope binding for a non-profile kind", () => {
  it("binds `proposal` at pod scope without a profile row, and never mirrors", async () => {
    await expect(
      setProfileRenderer({ ...podInput, profileSlug: "proposal" })
    ).resolves.toBeUndefined();

    expect(calls.resolveProfile).not.toHaveBeenCalled();
    expect(calls.profileUpdate).not.toHaveBeenCalled();
    expect(calls.setRendererBinding).toHaveBeenCalledTimes(1);
    expect(calls.setRendererBinding.mock.calls[0]![1]).toMatchObject({
      scopeKind: "pod",
      subjectKind: "proposal",
      contentKind: "entity-detail",
      surface: "app",
    });
  });

  it("a pod-scope `proposal` binding can be cleared (only the binding table holds it)", async () => {
    await expect(
      setProfileRenderer({ ...podInput, profileSlug: "proposal", ref: null })
    ).resolves.toBeUndefined();
    expect(calls.revokeRendererBinding).toHaveBeenCalledTimes(1);
  });
});

describe("setProfileRenderer — the mcp-app surface never mirrors", () => {
  it("a pod-scope mcp-app binding of a PROFILE writes only the binding", async () => {
    calls.cellRows = [
      { workspaceId: null, rendererType: "mcp-app", isActive: true },
    ];
    await setProfileRenderer({
      ...podInput,
      profileSlug: "person",
      surface: "mcp-app",
    });
    expect(calls.resolveProfile).not.toHaveBeenCalled();
    expect(calls.profileUpdate).not.toHaveBeenCalled();
    expect(calls.setRendererBinding.mock.calls[0]![1]).toMatchObject({
      subjectKind: "person",
      surface: "mcp-app",
    });
  });
});

describe("control — an in-app PROFILE binding still mirrors as before", () => {
  it("pod scope resolves the profile and writes its legacy default", async () => {
    calls.resolveProfile.mockResolvedValue({ id: "p-1", defaultRenderers: {} });
    await setProfileRenderer({ ...podInput, profileSlug: "person" });
    expect(calls.resolveProfile).toHaveBeenCalledTimes(1);
    expect(calls.profileUpdate).toHaveBeenCalledTimes(1);
    expect(calls.profileUpdate.mock.calls[0]![1]).toMatchObject({
      defaultDetailRenderer: ref,
      defaultRenderers: { "entity-detail": ref },
    });
  });

  it("a missing profile is still NOT_FOUND, before any write", async () => {
    await expect(
      setProfileRenderer({ ...podInput, profileSlug: "person" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.setRendererBinding).not.toHaveBeenCalled();
  });
});
