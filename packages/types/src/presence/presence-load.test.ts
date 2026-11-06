/**
 * `@synap-core/types/presence` is safe to LOAD where there is no Web Crypto
 * (Relay's Hermes): app-bases' failure-words reads its refusal codes on the
 * phone (`isPresenceCode`), and a module that touched `crypto.subtle` at load
 * would crash every screen importing it. Web Crypto is reached only inside the
 * digest functions, which the phone path never calls. Main red relay-tripwires
 * @3bcfaa29: the subpath also needs its explicit export, which Relay's walk
 * and tsconfig resolve (never the `./*` wildcard).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("@synap-core/types/presence on a runtime with no Web Crypto", () => {
  it("loads, and its refusal codes read, with globalThis.crypto undefined", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.resetModules();
    const mod = await import("./index.js");
    expect(mod.isPresenceCode("PRESENCE_REQUIRED")).toBe(true);
    expect(mod.isPresenceCode("NOPE")).toBe(false);
    expect(mod.PRESENCE_REFUSAL_CODES.length).toBeGreaterThan(0);
  });

  it("is an explicit package export, not only reachable through ./*", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")
    ) as { exports: Record<string, unknown> };
    expect(pkg.exports["./presence"]).toEqual({
      types: "./dist/presence/index.d.ts",
      import: "./dist/presence/index.js",
    });
  });
});
