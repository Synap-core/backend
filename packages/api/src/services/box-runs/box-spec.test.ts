import { describe, it, expect } from "vitest";
import {
  BOX_LIMITS,
  boxRunSpecFor,
  describeBoxDeclaration,
  parseBoxDeclaration,
} from "./box-spec.js";

/**
 * The box declaration is what the person approves besides the code: every
 * refusal row below is a declaration that would widen what a box may do
 * (a range instead of a pin, an IP literal, a limit above the host budget)
 * or run the wrong thing (an entrypoint of the other language).
 */
describe("parseBoxDeclaration", () => {
  it("normalises: default entrypoint, lowercased de-duplicated hosts, default limits", () => {
    const out = parseBoxDeclaration({
      language: "node",
      packages: [{ name: "@scope/pkg", version: "1.2.3" }],
      hosts: ["API.example.com", "api.example.com", "cdn.example.org:8443"],
    });
    expect(out).toEqual({
      ok: true,
      box: {
        language: "node",
        entrypoint: "main.mjs",
        packages: [{ name: "@scope/pkg", version: "1.2.3" }],
        hosts: ["api.example.com", "cdn.example.org:8443"],
        limits: {
          wallSeconds: BOX_LIMITS.wallSeconds[0],
          cpus: BOX_LIMITS.cpus[0],
          memoryMb: BOX_LIMITS.memoryMb[0],
          diskMb: BOX_LIMITS.diskMb[0],
          outMb: BOX_LIMITS.outMb[0],
        },
      },
    });
  });

  it.each([
    ["no language", {}],
    ["an unknown language", { language: "ruby" }],
    [
      "a version range",
      { language: "python", packages: [{ name: "pandas", version: ">=2" }] },
    ],
    [
      "a caret range",
      { language: "node", packages: [{ name: "lodash", version: "^4.17.21" }] },
    ],
    ["an IPv4 host", { language: "python", hosts: ["10.10.0.10"] }],
    [
      "an IP host with port",
      { language: "python", hosts: ["10.10.0.10:4000"] },
    ],
    ["localhost", { language: "python", hosts: ["localhost"] }],
    [
      "a URL instead of a host",
      { language: "python", hosts: ["https://api.example.com"] },
    ],
    [
      "a wall above the host budget",
      { language: "python", limits: { wallSeconds: 7200 } },
    ],
    [
      "memory above the host budget",
      { language: "python", limits: { memoryMb: 4096 } },
    ],
    [
      "a node entrypoint for python",
      { language: "python", entrypoint: "main.mjs" },
    ],
    [
      "a path as entrypoint",
      { language: "python", entrypoint: "../etc/main.py" },
    ],
    [
      "the same package twice",
      {
        language: "python",
        packages: [
          { name: "a", version: "1" },
          { name: "A", version: "2" },
        ],
      },
    ],
    ["an unknown key", { language: "python", secrets: ["X"] }],
  ])("refuses %s", (_label, raw) => {
    const out = parseBoxDeclaration(raw);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/^box/);
  });
});

describe("boxRunSpecFor", () => {
  it("refuses a box skill with no code or no declaration", () => {
    expect(
      boxRunSpecFor({
        name: "x",
        code: "",
        metadata: { box: { language: "python" } },
      }).ok
    ).toBe(false);
    expect(
      boxRunSpecFor({ name: "x", code: "print(1)", metadata: {} }).ok
    ).toBe(false);
  });
  it("snapshots name + code + the normalised declaration", () => {
    const out = boxRunSpecFor({
      name: "x",
      code: "print(1)",
      metadata: {
        box: { language: "python" },
        allowedHosts: ["ignored.example"],
      },
    });
    expect(out).toMatchObject({
      ok: true,
      spec: { name: "x", code: "print(1)", entrypoint: "main.py", hosts: [] },
    });
  });
});

describe("describeBoxDeclaration", () => {
  it("names the packages and hosts the person approves", () => {
    const parsed = parseBoxDeclaration({
      language: "python",
      packages: [{ name: "pandas", version: "2.2.3" }],
      hosts: ["api.example.com"],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(describeBoxDeclaration(parsed.box)).toBe(
      "runs on your computer in a box (python, pandas==2.2.3; may reach api.example.com; up to 15 min)"
    );
  });
});
