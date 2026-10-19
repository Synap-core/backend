import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../scripts/strip-comments.mjs";

/**
 * The console draws content people and agents wrote, with no
 * Content-Security-Policy behind it. Its safety is HOW it draws: one renderer
 * (`app/_lib/object/content/`) that turns markdown into React elements, and
 * no HTML injected anywhere. These scans keep it that way.
 */

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__tripwires__",
  ".turbo",
  "coverage",
]);
const CONTENT_DIR = ["app", "_lib", "object", "content"].join(sep) + sep;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
    }
  };
  walk(APP_ROOT);
  return out;
}

const FILES = sourceFiles().map((path) => ({
  path: relative(APP_ROOT, path),
  test: /\.test\.tsx?$/.test(path),
  body: stripComments(readFileSync(path, "utf8"), "ts"),
}));

describe("content is drawn, never injected", () => {
  it("scans the app (guards against a broken walker)", () => {
    expect(FILES.length).toBeGreaterThan(40);
    expect(FILES.some((f) => f.path.startsWith(CONTENT_DIR))).toBe(true);
  });

  it("injects HTML nowhere but the root layout's own boot scripts", () => {
    // `app/layout.tsx` writes two scripts the server builds from config
    // (runtime URLs, the sidebar state) — never content.
    const allowed = new Set([join("app", "layout.tsx")]);
    const hits = FILES.filter(
      (f) =>
        !f.test &&
        /dangerouslySetInnerHTML/.test(f.body) &&
        !allowed.has(f.path)
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("parses markdown only in the one content renderer", () => {
    const hits = FILES.filter(
      (f) =>
        /["']@synap-core\/markdown-core(?:\/[\w-]+)?["']/.test(f.body) &&
        !f.path.startsWith(CONTENT_DIR)
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("brings in no second markdown or HTML pipeline", () => {
    const hits = FILES.filter((f) =>
      /["'](?:react-markdown|marked|markdown-it|dompurify|isomorphic-dompurify|rehype-raw|rehype[\w-]*|remark[\w-]*|unified)["']/.test(
        f.body
      )
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("reads content only through a door floored to the viewer", () => {
    // `documents.getGlobal` / `getInWorkspace` and `files.getDownloadUrl` are
    // admin doors with no user floor: a pod admin would see a member's private
    // document the pod itself would not show them.
    const hits = FILES.filter((f) =>
      /\bdocuments\.(?:getGlobal|getInWorkspace)\b|\bfiles\.getDownloadUrl\b/.test(
        f.body
      )
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("loads no image from content (no <img> in the renderer)", () => {
    const renderer = FILES.filter(
      (f) => f.path.startsWith(CONTENT_DIR) && !f.test
    );
    expect(renderer.length).toBeGreaterThan(2);
    const hits = renderer.filter((f) => /<img\b/.test(f.body));
    expect(hits.map((h) => h.path)).toEqual([]);
  });
});
