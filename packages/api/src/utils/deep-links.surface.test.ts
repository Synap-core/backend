/**
 * `/open/<kind>/<id>?surface=<surfaceId>` (Surfaces P3): the pod's link
 * builder and the client one (`@synap-core/hub-rest-client` `openPath`) are
 * ONE grammar, kept byte-identical by hand (the api package does not depend on
 * the client). This reads the client's source and compares the two blocks
 * (`OpenPathOptions` + `openPath`) after normalising whitespace, then pins the
 * behaviour on the pod side.
 *
 * What it cannot see, stated: a client that builds the same URL some other
 * way (a hand-concatenated `?surface=`) is not compared; the pod admin parser
 * has its own round-trip test (pod admin's `open-params.test.ts`). No path
 * to another package is written here: CI's test selection reads one as an
 * edge to that whole package.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openLink, openPath } from "./deep-links.js";

const CLIENT = join(
  __dirname,
  "..",
  "..",
  "..",
  "hub-rest-client",
  "src",
  "open.ts"
);
const POD = join(__dirname, "deep-links.ts");

/** The `OpenPathOptions` interface through the end of `openPath`. */
function block(file: string): string {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf("export interface OpenPathOptions");
  const fn = src.indexOf("export function openPath(", start);
  const end = src.indexOf("\n}\n", fn);
  expect(start, `OpenPathOptions not found in ${file}`).toBeGreaterThan(-1);
  expect(fn, `openPath not found in ${file}`).toBeGreaterThan(start);
  return src
    .slice(start, end + 2)
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("openPath with a surface", () => {
  it("is the same code in the pod and in hub-rest-client", () => {
    const pod = block(POD);
    expect(pod).toContain("?surface=");
    expect(block(CLIENT)).toBe(pod);
  });

  it("builds the bare, typed and surface forms", () => {
    expect(openPath("abc")).toBe("/open/abc");
    expect(openPath("abc", { kind: "entity" })).toBe("/open/entity/abc");
    expect(openPath("abc", { kind: "entity", surface: "v 1" })).toBe(
      "/open/entity/abc?surface=v%201"
    );
    // A surface needs the kind: the bare route would lose it.
    expect(openPath("abc", { surface: "v1" })).toBe("/open/abc");
  });

  it("keeps the device flavour after the surface", () => {
    expect(
      openLink("abc", { kind: "project", surface: "v1", client: "mobile" })
    ).toMatch(/\/open\/project\/abc\?surface=v1&client=mobile$/);
    expect(openLink("abc", { client: "mobile" })).toMatch(
      /\/open\/abc\?client=mobile$/
    );
  });
});
