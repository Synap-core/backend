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
 * Code RUNS in exactly two frames, both on the contract
 * `@synap-core/types/cell-bridge`: `content/html-frame.tsx` (a stored HTML
 * page, `sandbox="allow-scripts"` srcdoc, read-only bridge) and
 * `content/module-frame.tsx` (a module cell on the pod's renderer bundle,
 * `CELL_MODULE_FRAME_SANDBOX` srcdoc, reads and governed writes). Their
 * behaviour is pinned by `html-frame.test.tsx`, `module-frame.test.tsx` and
 * `embed-view.test.tsx`; the scans below pin that there is no THIRD frame
 * and no site beyond the listed ones.
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

  it("loads no image from content (the renderer's one <img> is a diagram's blob)", () => {
    // A ```mermaid fence is drawn by the console's own mermaid, strict, as an
    // SVG Blob in an <img>: an image document runs no script and loads no
    // outside address. That file is the only <img> in the renderer, and its
    // only source is the object URL of that Blob.
    const fence = join("app", "_lib", "object", "content", "mermaid-fence.tsx");
    const model = join("app", "_lib", "object", "content", "mermaid-model.ts");
    const renderer = FILES.filter(
      (f) => f.path.startsWith(CONTENT_DIR) && !f.test
    );
    expect(renderer.length).toBeGreaterThan(2);
    const hits = renderer.filter((f) => /<img\b/.test(f.body));
    expect(hits.map((h) => h.path)).toEqual([fence]);
    const fenceBody = FILES.find((f) => f.path === fence)!.body;
    expect(fenceBody.match(/\bsrc=/g)).toEqual(["src="]);
    expect(fenceBody).toContain("src={state.url}");
    expect(fenceBody.match(/status: "ready", url\b/g)).toEqual([
      'status: "ready", url',
    ]);
    expect(fenceBody).toContain(
      'URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))'
    );
    const modelBody = FILES.find((f) => f.path === model)!.body;
    expect(modelBody).toContain('securityLevel: "strict"');
    expect(modelBody).toContain("htmlLabels: false");
    expect(modelBody).toContain("flowchart: { htmlLabels: false }");
  });

  it("runs code only in exactly two frames, never same-origin", () => {
    // A third <iframe> (or a srcdoc anywhere else) would be a frame whose
    // sandbox nobody tests. `allow-same-origin` anywhere in app code would
    // hand a page the console's origin. Comments are stripped before the
    // scan, so prose may name it; code may not. It does NOT see a frame
    // built at runtime (`document.createElement("iframe")` is caught below
    // only by name).
    const door = join("app", "_lib", "object", "content", "html-frame.tsx");
    const moduleDoor = join(
      "app",
      "_lib",
      "object",
      "content",
      "module-frame.tsx"
    );
    const code = FILES.filter((f) => !f.test);
    const frames = code.filter((f) =>
      /<iframe\b|\bsrcDoc\b|createElement\(\s*["']iframe["']/i.test(f.body)
    );
    expect(frames.map((f) => f.path).sort()).toEqual([door, moduleDoor].sort());
    // Non-vacuity: each door is seen, and its sandbox is the shared constant.
    expect(code.find((f) => f.path === door)?.body).toContain(
      "sandbox={CELL_FRAME_SANDBOX}"
    );
    const moduleBody = code.find((f) => f.path === moduleDoor)?.body ?? "";
    expect(moduleBody).toContain("sandbox={CELL_MODULE_FRAME_SANDBOX}");
    // srcdoc only: the module frame never takes a `src` address.
    expect(moduleBody).not.toMatch(/<iframe\b[^>]*\ssrc=/);
    const sameOrigin = code.filter((f) => /allow-same-origin/.test(f.body));
    expect(sameOrigin.map((f) => f.path)).toEqual([]);
  });

  it("mounts the frame only on a page, in a cell embed and in a proposal's preview", () => {
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
        /\b(?:HtmlFrame|SandboxedFrame|HtmlPageSection|HtmlPageBody|HtmlPagePreview)\b/.test(
          f.body
        )
    ).map((f) => f.path);
    // The preview (`html-preview.tsx`, no pod bridge) is the third door, used
    // by a proposal's record card, a proposed document's body and a document
    // update's pages (Result, Before | After) only.
    const previewDoor = join(
      "app",
      "_lib",
      "object",
      "content",
      "html-preview.tsx"
    );
    const proposalDir = join("app", "proposal", "[id]");
    const proposalSites = [
      join(proposalDir, "ProposedRecordCard.tsx"),
      join(proposalDir, "ProposedDocumentBody.tsx"),
      join(proposalDir, "DocumentUpdateChanges.tsx"),
    ];
    // A connected object's stored HTML file is drawn by the preview too
    // (no bridge): it is another object's file, not this page's own body.
    const connectedSite = join(
      "app",
      "_lib",
      "object",
      "connected-objects.tsx"
    );
    // A cell's own page (`/open/cell/<key>`) runs a page cell as a
    // document's body does: the same bridged frame.
    const cellPage = join("app", "open", "_views", "cell-view.tsx");
    expect(sites.sort()).toEqual(
      [
        pageSite,
        embedSite,
        previewDoor,
        connectedSite,
        cellPage,
        ...proposalSites,
      ].sort()
    );
    // The connected-objects site draws through the PREVIEW (no bridge) only:
    // never the bridged frame, section or body.
    const connectedBody =
      FILES.find((f) => f.path === connectedSite)?.body ?? "";
    expect(connectedBody).toContain("<HtmlPagePreview");
    expect(connectedBody).not.toMatch(
      /\b(?:HtmlFrame|SandboxedFrame|HtmlPageSection|HtmlPageBody)\b/
    );
    // Non-vacuity: the preview never answers pod reads.
    expect(FILES.find((f) => f.path === previewDoor)?.body).toContain(
      "bridge={false}"
    );
    // Non-vacuity: the embed site mounts the shared frame, by its name.
    expect(FILES.find((f) => f.path === embedSite)?.body).toMatch(
      /<HtmlFrame\b/
    );
  });

  it("mounts the module frame only through rendered-object, at the listed sites", () => {
    // `ModuleFrame` is mounted in ONE file (`rendered-object.tsx`: the cell's
    // source + the bundle's host modules), and that file's components are
    // used only by a cell embed, a cell's page, a view's page, an entity's
    // detail and Home's "Made for you" card (its first record only, capped
    // by `MAX_FRAMED_ENTITY_CARDS`: `member-home.test.tsx`). A new site
    // would run a cell where no test looks.
    const content = ["app", "_lib", "object", "content"];
    const moduleDoor = join(...content, "module-frame.tsx");
    const renderedDoor = join(...content, "rendered-object.tsx");
    const frameSites = FILES.filter(
      (f) =>
        !f.test &&
        f.path !== moduleDoor &&
        /\b(?:ModuleFrame|ModuleSandbox|createModuleFrameHost)\b/.test(f.body)
    ).map((f) => f.path);
    expect(frameSites).toEqual([renderedDoor]);
    const renderedSites = FILES.filter(
      (f) =>
        !f.test &&
        f.path !== renderedDoor &&
        /\b(?:RenderedObject|CellByKey|ModuleCell)\b/.test(f.body)
    ).map((f) => f.path);
    expect(renderedSites.sort()).toEqual(
      [
        join(...content, "embed-view.tsx"),
        join("app", "open", "_views", "cell-view.tsx"),
        join("app", "open", "_views", "view-view.tsx"),
        join("app", "open", "_views", "entity-view.tsx"),
        join("app", "(admin)", "home", "_lib", "member-cards.tsx"),
      ].sort()
    );
    // Non-vacuity: the door mounts the frame by its name.
    expect(FILES.find((f) => f.path === renderedDoor)?.body).toMatch(
      /<ModuleFrame\b/
    );
  });

  it("a body frames at most ONE entity card, and every module frame mounts lazily", () => {
    // Each module frame carries the renderer bundle (about 3 MB of srcdoc).
    // A body with twenty record embeds must not mount twenty: the body picks
    // its framed cards (`entityFrameNodes`, capped by
    // `MAX_FRAMED_ENTITY_CARDS`), every other card is its identity card, and
    // each frame mounts only near the viewport (`observeNear`). Behaviour:
    // `embed-view.test.tsx` ("a body runs at most …"), `module-frame.test.tsx`.
    const content = ["app", "_lib", "object", "content"];
    const body = (name: string) =>
      FILES.find((f) => f.path === join(...content, name))?.body ?? "";
    const embed = body("embed-view.tsx");
    expect(embed).toMatch(/export const MAX_FRAMED_ENTITY_CARDS = 1;/);
    // The card slot is reached only within the cap.
    expect(embed).toMatch(/if \(!subject \|\| !mayFrame\) return identity;/);
    const markdown = body("markdown-view.tsx");
    expect(markdown).toMatch(/entityFrameNodes\(tree\)/);
    expect(markdown).toMatch(/<EmbedBodyContext\.Provider\b/);
    expect(markdown).toMatch(/node=\{node\}/);
    const frame = body("module-frame.tsx");
    // No srcdoc is built before the frame is near.
    expect(frame).toMatch(/refusal \|\| !near\s*\?\s*""/);
    expect(frame).toMatch(/useNearViewport\(/);
  });

  it("draws an image only through the one image door", () => {
    // `app/_lib/media/media-view.tsx` signs on the reader's own floor, draws
    // only allowlisted rasters and never loads an outside address. A second
    // `<img>` (or `next/image`, which would fetch and cache a signed URL on
    // the console's server) would skip all three.
    // The diagram's blob image (pinned above) is the one other site.
    const door = join("app", "_lib", "media", "media-view.tsx");
    const diagram = join(
      "app",
      "_lib",
      "object",
      "content",
      "mermaid-fence.tsx"
    );
    const imgs = FILES.filter((f) => !f.test && /<img\b/.test(f.body));
    expect(imgs.map((f) => f.path).sort()).toEqual([door, diagram].sort());
    const nextImage = FILES.filter((f) =>
      /["']next\/image["']|\bnew Image\(/.test(f.body)
    );
    expect(nextImage.map((f) => f.path)).toEqual([]);
  });

  it("plays video and audio only through the one media door", () => {
    // The door signs on the reader's own floor and decides on the type the pod
    // SIGNED, against three allowlists that never overlap. A second `<video>`
    // or `<audio>` would play whatever it was handed, from any address, with
    // none of that. (`SpatialMediaPreview` is the app's door, not this one.)
    const door = join("app", "_lib", "media", "media-view.tsx");
    const players = FILES.filter(
      (f) => !f.test && /<(video|audio)\b/.test(f.body)
    );
    expect(players.map((f) => f.path)).toEqual([door]);
    // Non-vacuity: the scan can still see both elements where they live.
    const body = FILES.find((f) => f.path === door)?.body ?? "";
    expect(body).toMatch(/<video\b/);
    expect(body).toMatch(/<audio\b/);
    // A player never autoplays and never loads the whole file up front.
    expect(body).not.toMatch(/\bautoPlay\b/i);
    expect(body).not.toMatch(/preload=["']auto["']/);
    // The door hands a player only a `src` it got from the signing: a literal
    // address in a media element is the pod's signed URL replaced by a guess.
    expect(body).not.toMatch(/<(video|audio)\b[^>]*\bsrc=["']https?:/);
  });
});
