/**
 * TRIPWIRE — the pre-July `workspaces.settings.controlPlane` record has ONE
 * reader (lane cp-link, 2026-10-23).
 *
 * That record lost its writers in bda48e071 (2026-07-14), yet its readers kept
 * deciding a pod's connection state, tier, trial and CP pod id: every pod
 * registered since read "disconnected", tier "solo", podId null. The pod's
 * Control Plane link and plan are now read through `readControlPlaneLink` /
 * `readControlPlaneEntitlement` (`@synap/database` utils/control-plane-link.ts),
 * which alone may still read the old record — as the link of a not-yet-enrolled
 * pod and for its one-time boot migration.
 *
 * DERIVES the scanned set (every non-test `.ts` under `packages/*\/src` and
 * `apps/*\/src`) and fails on any read of that record outside the door:
 *   - SQL:        `-> 'controlPlane'` / `->> 'controlPlane'` / `? 'controlPlane'`
 *   - property:   `.controlPlane` / `?.controlPlane` / `["controlPlane"]`
 *   - destructure `const { controlPlane … } = …`
 *
 * WHAT THIS DOES NOT SEE: a key built at runtime (`settings[k]`), or a read
 * through a raw SQL string file. Writing the KEY in an object literal (the
 * status response's `controlPlane: {…}`) is not a read and is allowed.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");

/** The one file allowed to read the old record. */
const DOOR = "packages/database/src/utils/control-plane-link.ts";

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    const dir = path.join(REPO, group);
    if (!fs.existsSync(dir)) continue;
    for (const pkg of fs.readdirSync(dir)) {
      const src = path.join(dir, pkg, "src");
      if (fs.existsSync(src)) roots.push(src);
    }
  }
  return roots;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.includes(".test.") &&
      !full.includes("__tests__") &&
      !full.includes("__tripwires__")
    ) {
      out.push(full);
    }
  }
  return out;
}

const READS: Array<[string, RegExp]> = [
  ["sql", /(?:->>?|\?)\s*'controlPlane'/],
  ["property", /\??\.controlPlane\b/],
  ["bracket", /\[\s*["'`]controlPlane["'`]\s*\]/],
  ["destructure", /const\s*\{[^}]*\bcontrolPlane\b[^}]*\}\s*=/],
];

/** Strip line and block comments so prose about the record is not a read. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("workspaces.settings.controlPlane — read only through the link door", () => {
  const files = sourceRoots().flatMap((root) => walk(root));

  it("scans the source tree (reachability: the door itself is in the set)", () => {
    const rel = files.map((f) => path.relative(REPO, f));
    expect(rel).toContain(DOOR);
    expect(rel).toContain("apps/api/src/routers/provision.ts");
    expect(rel).toContain("packages/api/src/utils/tier-check.ts");
    expect(rel.length).toBeGreaterThan(500);
  });

  it("the door still reads it (so the scan's patterns match a real read)", () => {
    const text = code(fs.readFileSync(path.join(REPO, DOOR), "utf8"));
    expect(READS.some(([, re]) => re.test(text))).toBe(true);
  });

  it("no other file reads it", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO, file);
      if (rel === DOOR) continue;
      const text = code(fs.readFileSync(file, "utf8"));
      for (const [kind, re] of READS) {
        if (re.test(text)) offenders.push(`${rel} (${kind})`);
      }
    }
    expect(
      offenders,
      "Read the pod's CP link / plan through readControlPlaneLink / readControlPlaneEntitlement (@synap/database utils/control-plane-link.ts)"
    ).toEqual([]);
  });
});
