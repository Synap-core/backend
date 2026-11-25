/**
 * The bundle's host modules: a full answer is cached by its set sha, a
 * `notModified` answer is served from that cache only when it names the
 * cached set, NOT_FOUND is "no bundle", and anything else (a failure, an
 * answer without React) is FAILED, never "no bundle".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));

import {
  cachedHostModules,
  forgetHostModules,
  hostModulesFromWire,
  hostModulesState,
} from "./use-host-modules";

const MODULES = {
  react: "r",
  reactDom: "rd",
  reactDomClient: "rdc",
  jsxRuntime: "jsx",
  tokensCss: ":root{}",
};
const ok = (data: unknown) => ({ isLoading: false, error: null, data });

beforeEach(() => forgetHostModules());

describe("hostModulesFromWire", () => {
  it("takes sources as strings or as stored rows ({ source, sha256 })", () => {
    expect(
      hostModulesFromWire({
        ...MODULES,
        react: { source: "r", sha256: "x" },
        kit: { source: "k", sha256: "y" },
      })
    ).toEqual({ ...MODULES, kit: "k" });
  });

  it("a set without React (or without tokens) is not a set", () => {
    const { react: _r, ...noReact } = MODULES;
    expect(hostModulesFromWire(noReact)).toBeNull();
    const { tokensCss: _t, ...noTokens } = MODULES;
    expect(hostModulesFromWire(noTokens)).toBeNull();
  });
});

describe("hostModulesState", () => {
  it("a full answer is ready, and cached under its sha", () => {
    const state = hostModulesState(
      ok({
        notModified: false,
        setSha256: "s1",
        modules: MODULES,
        kitExports: ["Card"],
      })
    );
    expect(state).toEqual({
      state: "ready",
      setSha256: "s1",
      modules: MODULES,
      kitExports: ["Card"],
    });
    expect(cachedHostModules()?.setSha256).toBe("s1");
  });

  it("notModified is served from the cache when it names the cached set", () => {
    hostModulesState(
      ok({ notModified: false, setSha256: "s1", modules: MODULES })
    );
    const state = hostModulesState(ok({ notModified: true, setSha256: "s1" }));
    expect(state).toMatchObject({
      state: "ready",
      setSha256: "s1",
      modules: MODULES,
    });
  });

  it("notModified for ANOTHER set (or with no cache) is failed, not stale modules", () => {
    expect(
      hostModulesState(ok({ notModified: true, setSha256: "s1" })).state
    ).toBe("failed");
    hostModulesState(
      ok({ notModified: false, setSha256: "s1", modules: MODULES })
    );
    expect(
      hostModulesState(ok({ notModified: true, setSha256: "s2" })).state
    ).toBe("failed");
  });

  it("NOT_FOUND is 'no bundle on this pod'", () => {
    expect(
      hostModulesState({
        isLoading: false,
        error: { data: { code: "NOT_FOUND" } },
        data: undefined,
      })
    ).toEqual({ state: "none" });
  });

  it("any other failure, or a broken answer, is failed with its retry", () => {
    const retry = () => {};
    expect(
      hostModulesState({
        isLoading: false,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
        data: undefined,
        retry,
      })
    ).toEqual({ state: "failed", retry });
    expect(
      hostModulesState(ok({ notModified: false, setSha256: "s1", modules: {} }))
        .state
    ).toBe("failed");
    expect(hostModulesState(ok(null)).state).toBe("failed");
  });

  it("loading while the read is in flight", () => {
    expect(
      hostModulesState({ isLoading: true, error: null, data: undefined })
    ).toEqual({ state: "loading" });
  });
});
