/**
 * TRIPWIRE — an HTML page is written ONLY through the HTML page door
 * (`createHtmlPage`, `@synap/database` `utils/html-page.ts`; founder decision,
 * 27 Nov 2026, session 53d7cbed). The door is where the checks live (the
 * 2 MB cap, declared reads inside the frame-read ceiling) and where the
 * stored shape is set (`type: "html"`, `text/html`, `metadata.reads`).
 *
 * THE DEFECT THIS PINS: the html-embed cell routes (Hub `POST
 * /cell-instances/html`, tRPC `createHtmlCell`, the place door, the `cell/create`
 * approval) wrote their own html documents beside the document door: stored
 * as `type: "text"` + `text/html`, with no size cap, no declared reads, no
 * block manifest, under their own governance. Two shapes of one thing.
 *
 * Two layers, because neither alone covers the other:
 *
 *  1. RUN TIME (the real fence): `createDocumentWithContent` refuses an html
 *     body (type `html` or mime `text/html`) whose input lacks the door's
 *     mark (`HTML_PAGE_DOOR_MARK`, a module symbol `@synap/database` does
 *     not export). Proven by `html-page-one-door.pglite.test.ts`. PART 1 here
 *     pins who may hold the mark: the door, the create door that checks it,
 *     and the module that defines it. Nothing else.
 *
 *  2. SOURCE (what the run-time fence cannot see): a documents row written
 *     WITHOUT `createDocumentWithContent` (a raw `insert(documents)`, a
 *     `DocumentRepository`). PART 2: a file that writes document rows and
 *     names an html document shape in CODE (comments and prose stripped) is
 *     a violation unless it is the door or classified below, pinned by count.
 *
 * WHAT IT SCANS: every non-test `.ts` under every `packages/<pkg>/src` (the
 * set is DERIVED from the directory listing: a new package joins by existing).
 *
 * WHAT IT CANNOT SEE (measured, not implied): an html shape built from a
 * variable (`type: someType` that happens to be "html") on a raw insert or a
 * `DocumentRepository.create`; part 1's run-time fence covers that case only
 * when the write goes through `createDocumentWithContent`. Granularity is the
 * FILE (hence the pinned counts). Measured: re-inlining the old cell write
 * (`createDocumentWithContent` with `mimeType: "text/html"`, no mark) in
 * `create-cell-instance.ts` went RED in part 2, and its run time refusal is
 * the pglite test's.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const BACKEND = fileURLToPath(new URL("../../../..", import.meta.url));
const PACKAGES = join(BACKEND, "packages");
const DOOR = "packages/database/src/utils/html-page.ts";
const TOKEN = "packages/database/src/utils/html-page-door-token.ts";
const CREATE_DOOR = "packages/database/src/utils/claim-document-revision.ts";

/** Who may name the mark: the door, its definition, the create door that checks it. */
const MARK_HOLDERS = [DOOR, TOKEN, CREATE_DOOR].sort();

/**
 * Files that write document rows AND name an html shape in code, outside the
 * door, each with its reason and the exact count (a new site fails).
 */
const HTML_SHAPE_EXEMPT: Record<string, { count: number; reason: string }> = {
  "packages/database/src/services/entity-body-service.ts": {
    count: 1,
    reason:
      "a STORED FILE: bytes a person uploaded (`setBodyBytes` / `setBodyStoredObject`), typed from their mime type. Not an authored page; finding filed on the session (an uploaded .html file is stored as type html without the page door's checks).",
  },
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (
      name.endsWith(".ts") &&
      !name.includes(".test.") &&
      !full.includes("__tripwires__")
    )
      yield full;
  }
}

/** Source with comments removed (block, then line comments outside strings). */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const MARK_RE = /\bHTML_PAGE_DOOR_MARK\b/;
const DOCUMENT_WRITE_RE =
  /\bcreateDocumentWithContent\s*\(|\binsert\(\s*documents\s*\)|\bDocumentRepository\b/;
/**
 * An html document shape named in code: the mime type, or a `type` /
 * `extension` property whose value is "html" (pinned at both ends: the value
 * is followed by `,`, `}` or a line end, so prose in a message string such as
 * 'a `type: "html"` page' is not a shape).
 */
const HTML_SHAPE_RE =
  /["'`]text\/html|\b(?:type|extension)\s*:\s*["'`]html["'`]\s*[,}\n]/g;

/** html shapes in a file that writes document rows (0 when it writes none). */
export function htmlShapesBesideDocumentWrite(source: string): number {
  const code = stripComments(source);
  if (!DOCUMENT_WRITE_RE.test(code)) return 0;
  return [...code.matchAll(HTML_SHAPE_RE)].length;
}

let scanned: ReturnType<typeof runScan> | undefined;
function scan() {
  return (scanned ??= runScan());
}

function runScan() {
  const pkgs = readdirSync(PACKAGES).filter((p) =>
    existsSync(join(PACKAGES, p, "src"))
  );
  const markHolders: string[] = [];
  const shapes = new Map<string, number>();
  let files = 0;
  let documentWriters = 0;
  for (const pkg of pkgs) {
    for (const file of walk(join(PACKAGES, pkg, "src"))) {
      files += 1;
      const src = readFileSync(file, "utf8");
      const rel = relative(BACKEND, file);
      if (MARK_RE.test(src)) markHolders.push(rel);
      if (DOCUMENT_WRITE_RE.test(stripComments(src))) documentWriters += 1;
      const n = htmlShapesBesideDocumentWrite(src);
      if (n > 0) shapes.set(rel, n);
    }
  }
  return {
    pkgs,
    files,
    markHolders: markHolders.sort(),
    shapes,
    documentWriters,
  };
}

describe("an HTML page is written through ONE door", () => {
  it("self-check: the scanner sees an html shape beside a document write, not in a comment, not alone", () => {
    expect(
      htmlShapesBesideDocumentWrite(
        'await createDocumentWithContent(db, ev, {\n  type: "text",\n  mimeType: "text/html",\n});'
      )
    ).toBe(1);
    expect(
      htmlShapesBesideDocumentWrite(
        "await tx.insert( documents ).values({ type: 'html' })"
      )
    ).toBe(1);
    // In a comment: not code.
    expect(
      htmlShapesBesideDocumentWrite(
        '// was: mimeType: "text/html"\nawait createDocumentWithContent(db, ev, { type: "markdown" });'
      )
    ).toBe(0);
    // An html shape with no document write in the file (a served response).
    expect(
      htmlShapesBesideDocumentWrite('c.header("content-type", "text/html")')
    ).toBe(0);
  });

  it("non-vacuity: the scan walks every package and sees the door and many document writers", () => {
    const { pkgs, files, shapes, documentWriters } = scan();
    expect(pkgs).toEqual(expect.arrayContaining(["api", "jobs", "database"]));
    expect(files).toBeGreaterThan(500);
    expect(documentWriters).toBeGreaterThanOrEqual(10);
    // The door names the html shape beside its write: the scan can see it.
    expect(shapes.get(DOOR) ?? 0).toBeGreaterThanOrEqual(2);
    for (const file of Object.keys(HTML_SHAPE_EXEMPT)) {
      expect({ file, seen: shapes.has(file) }).toEqual({ file, seen: true });
    }
  });

  it("PART 1: only the door, its mark's definition and the create door name the door's mark", () => {
    expect(scan().markHolders).toEqual(MARK_HOLDERS);
  });

  it("PART 2: no file writes a document row with an html shape outside the door (exemptions pinned by count)", () => {
    const violations: string[] = [];
    for (const [file, n] of scan().shapes) {
      if (file === DOOR) continue;
      const exempt = HTML_SHAPE_EXEMPT[file];
      if (exempt && n === exempt.count) continue;
      violations.push(
        `${file}: ${n} html document shape(s) beside a document write — write the page through createHtmlPage`
      );
    }
    expect(violations).toEqual([]);
  });
});
