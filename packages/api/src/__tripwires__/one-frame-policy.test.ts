/**
 * TRIPWIRE — ONE frame policy, and every frame host in this repo takes it.
 *
 * Decision R3 (founder, 3 Nov 2026): one policy for every frame that runs
 * stored code, on every client: the desktop's, with no CDN. Until then
 * `@synap-core/types/cell-bridge` allowed three script CDNs and Google Fonts
 * (pod admin's frame) while the desktop and web frames allowed none, so one
 * page ran in pod admin and stayed blank on the desktop, and nothing compared
 * the two.
 *
 * WHAT IS CHECKED
 *   1. The one policy (`buildCellFrameCsp`, and `buildCellModuleFrameCsp` for a
 *      module cell) names NO origin: every source is a keyword or a bare
 *      scheme (`data:`, `blob:`). A CDN coming back is red here.
 *   2. Every frame host in this repo writes the policy FROM the leaf: a source
 *      file that renders a `srcDoc` frame or writes a CSP `<meta http-equiv>`
 *      imports `@synap-core/types/cell-bridge` and spells no CSP directive of
 *      its own. Only the leaf (`packages/types/src/cell-bridge/frame.ts`)
 *      writes directives.
 *   3. Every host that RUNS a page (calls `wrapHtmlForFrame`) also asks
 *      `frameNetworkCodeRefusal` first, so a page whose code is on a CDN is
 *      shown with its reason, never as a blank frame.
 *
 * THE SET IS DERIVED: every non-test `.ts`/`.tsx`/`.js`/`.mjs` file under
 * `apps/` and `packages/` (no `node_modules`, `dist`, `.next`). The test
 * asserts the set reaches pod admin's `html-frame.tsx`, so an emptied scan
 * cannot pass.
 *
 * WHAT IT CANNOT SEE: the sibling repos (synap-app, browser, relay-app). Their
 * copies adopt this export in their own lanes (wave 3 lanes 2, 3, 8), each
 * with its own parity tripwire. `deploy/Caddyfile`'s header for raw stored
 * files is not a frame host (it allows no script at all) and is not scanned.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCellFrameCsp,
  buildCellModuleFrameCsp,
} from "@synap-core/types/cell-bridge";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const LEAF = "packages/types/src/cell-bridge/frame.ts";
const POD_ADMIN_FRAME = "apps/pod-admin/app/_lib/object/content/html-frame.tsx";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
]);
const SOURCE = /\.(?:ts|tsx|js|mjs)$/;
const TEST = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|__tests__|__tripwires__/;

/** A file that hosts a frame: renders a srcdoc iframe or writes a CSP meta. */
const FRAME_HOST =
  /\bsrc[Dd]oc\s*=|\.srcdoc\s*=|http-equiv\s*=\s*\\?["']?Content-Security-Policy/;
/** A CSP directive spelled out (the leaf's job alone). */
const CSP_DIRECTIVE =
  /["'`][^"'`\n]*\b(?:default|script|style|connect|img|font|frame|child)-src\b/;
const IMPORTS_LEAF = /from\s+["']@synap-core\/types\/cell-bridge["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return SOURCE.test(name) ? [p] : [];
  });
}

/** Every source the policy names, across all its directives. */
function sources(csp: string): string[] {
  return csp
    .split(";")
    .flatMap((part) => part.trim().split(/\s+/).slice(1))
    .filter(Boolean);
}

const NOT_AN_ORIGIN = /^(?:'none'|'unsafe-inline'|data:|blob:)$/;

describe("tripwire: one frame policy, no CDN, taken by every frame host", () => {
  const files = ["apps", "packages"]
    .flatMap((d) => sourceFiles(join(REPO, d)))
    .map((abs) => ({ abs, rel: relative(REPO, abs).split("\\").join("/") }))
    .filter(({ rel }) => !TEST.test(rel));
  const text = new Map(
    files.map(({ abs, rel }) => [rel, readFileSync(abs, "utf8")])
  );
  const hosts = [...text.keys()].filter(
    (rel) => rel !== LEAF && FRAME_HOST.test(text.get(rel)!)
  );
  const runners = [...text.keys()].filter(
    (rel) => rel !== LEAF && /\bwrapHtmlForFrame\s*\(/.test(text.get(rel)!)
  );

  it("the scan reaches the leaf and pod admin's frame (an empty scan cannot pass)", () => {
    expect(text.has(LEAF)).toBe(true);
    expect(hosts).toContain(POD_ADMIN_FRAME);
    expect(runners).toContain(POD_ADMIN_FRAME);
  });

  it("the page policy names no origin: no script CDN, no font, style or image host", () => {
    const named = sources(buildCellFrameCsp()).filter(
      (s) => !NOT_AN_ORIGIN.test(s)
    );
    expect(named).toEqual([]);
  });

  it("the module-cell policy names no origin either, until a cell's hosts are approved", () => {
    const named = sources(buildCellModuleFrameCsp()).filter(
      (s) => !NOT_AN_ORIGIN.test(s)
    );
    expect(named).toEqual([]);
  });

  it("every frame host imports the leaf and spells no CSP directive of its own", () => {
    const offenders = hosts.flatMap((rel) => {
      const src = text.get(rel)!;
      const out: string[] = [];
      if (!IMPORTS_LEAF.test(src))
        out.push(`${rel}: hosts a frame without @synap-core/types/cell-bridge`);
      const line = src.split("\n").findIndex((l) => CSP_DIRECTIVE.test(l));
      if (line >= 0)
        out.push(
          `${rel}:${line + 1}: writes a CSP directive; take it from the leaf`
        );
      return out;
    });
    expect(offenders).toEqual([]);
  });

  it("every host that runs a page refuses network code first", () => {
    const silent = runners.filter(
      (rel) => !/\bframeNetworkCodeRefusal\s*\(/.test(text.get(rel)!)
    );
    expect(silent).toEqual([]);
  });
});
