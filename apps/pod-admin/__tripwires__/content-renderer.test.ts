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
 *
 * HTML RUNS in exactly one frame (`content/html-frame.tsx`,
 * `sandbox="allow-scripts"` srcdoc, contract `@synap-core/types/cell-bridge`),
 * mounted in exactly two places: a stored HTML document's own page
 * (`content-block.tsx`) and an HTML cell embedded in a body
 * (`embed-view.tsx`). Its behaviour is pinned by `html-frame.test.tsx` and
 * `embed-view.test.tsx`; the scans below pin that there is no SECOND frame
 * and no third site.
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

  it("runs HTML only in the one frame, never same-origin", () => {
    // A second <iframe> (or a srcdoc anywhere else) would be a frame whose
    // sandbox nobody tests. `allow-same-origin` anywhere in app code would
    // hand a page the console's origin. Comments are stripped before the
    // scan, so prose may name it; code may not. It does NOT see a frame
    // built at runtime (`document.createElement("iframe")` is caught below
    // only by name).
    const door = join("app", "_lib", "object", "content", "html-frame.tsx");
    const code = FILES.filter((f) => !f.test);
    const frames = code.filter((f) =>
      /<iframe\b|\bsrcDoc\b|createElement\(\s*["']iframe["']/i.test(f.body)
    );
    expect(frames.map((f) => f.path)).toEqual([door]);
    // Non-vacuity: the door is seen, and its sandbox is the shared constant.
    expect(code.find((f) => f.path === door)?.body).toContain(
      "sandbox={CELL_FRAME_SANDBOX}"
    );
    const sameOrigin = code.filter((f) => /allow-same-origin/.test(f.body));
    expect(sameOrigin.map((f) => f.path)).toEqual([]);
  });

  it("mounts the frame only on a page and in a body's cell embed", () => {
    // Every file that names one of the frame's exports, outside the frame
    // itself. A third site would run HTML somewhere these tests do not
    // reach. It sees names, not calls: an export re-bound under another name
    // in a listed file is not caught.
    const door = join("app", "_lib", "object", "content", "html-frame.tsx");
    const embedSite = join(
      "app",
      "_lib",
      "object",
      "content",
      "embed-view.tsx"
    );
    const pageSite = join(
      "app",
      "_lib",
      "object",
      "content",
      "content-block.tsx"
    );
    const sites = FILES.filter(
      (f) =>
        !f.test &&
        f.path !== door &&
        /\b(?:HtmlFrame|SandboxedFrame|HtmlPageSection|HtmlPageBody)\b/.test(
          f.body
        )
    ).map((f) => f.path);
    expect(sites.sort()).toEqual([pageSite, embedSite].sort());
    // Non-vacuity: the embed site mounts the shared frame, by its name.
    expect(FILES.find((f) => f.path === embedSite)?.body).toMatch(
      /<HtmlFrame\b/
    );
  });

  it("draws an image only through the one image door", () => {
    // `app/_lib/media/media-view.tsx` signs on the reader's own floor, draws
    // only allowlisted rasters and never loads an outside address. A second
    // `<img>` (or `next/image`, which would fetch and cache a signed URL on
    // the console's server) would skip all three.
    const door = join("app", "_lib", "media", "media-view.tsx");
    const imgs = FILES.filter((f) => !f.test && /<img\b/.test(f.body));
    expect(imgs.map((f) => f.path)).toEqual([door]);
    const nextImage = FILES.filter((f) =>
      /["']next\/image["']|\bnew Image\(/.test(f.body)
    );
    expect(nextImage.map((f) => f.path)).toEqual([]);
  });
});
