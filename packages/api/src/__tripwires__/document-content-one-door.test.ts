/**
 * TRIPWIRE — a document's stored content is written ONLY through the two doors
 * in @synap/database `utils/claim-document-revision.ts`:
 * `claimDocumentRevision` (REPLACE a live body) and `createDocumentWithContent`
 * (CREATE a document with its body). Part 2 (the create door) is at the bottom.
 *
 * THE DEFECT THIS PINS (documents-centerpiece W4a): six independent writers
 * replaced a document's body — human save, restore, approval, section door,
 * snapshot, Yjs — and only one of them compared anything. An approved AI edit
 * could be overwritten by an open editor's next autosave; a restore could write
 * Yjs base64 over the markdown; a human save was invisible to the base-version
 * check. The door is where the compare-and-set, the author-switch checkpoint and
 * the upload live together, so a writer that bypasses it loses all three.
 *
 * WHAT IT SCANS: every non-test `.ts` file under every `packages/<pkg>/src` in
 * synap-backend (the set is DERIVED from the directory listing, so a new package
 * joins by existing). A violation is a `storage.upload(` whose FIRST argument
 * reads a loaded row's key — a property access ending in `.storageKey`
 * (`doc.storageKey`, `document.storageKey!`, `body.storageKey`). That is the
 * shape of "overwrite the body of a document that already exists".
 *
 * WHAT IT CANNOT SEE (measured, not implied):
 *   - a writer that first copies the key into a local (`const k = doc.storageKey;
 *     storage.upload(k, …)`) — the Yjs WHITEBOARD persistence does exactly that
 *     and is legitimately outside the door (whiteboards are not text documents);
 *   - creates, which upload to a freshly built key in a local variable — those
 *     are not replaces and need no door.
 *
 * EXEMPT (each with its reason; keyed by file so a NEW site in the same file is
 * still caught by the per-file count):
 *   - views.ts: whiteboard VIEW content (tldraw JSON, the Yjs canonical for a
 *     whiteboard). Different semantics; the plan leaves whiteboards untouched.
 *   - sync.ts: `/receive-file`, the federation replica write of a remote pod's
 *     file under the remote's own key. Out of the content plane.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const BACKEND = fileURLToPath(new URL("../../../..", import.meta.url));
const PACKAGES = join(BACKEND, "packages");
const DOOR = "packages/database/src/utils/claim-document-revision.ts";

const EXEMPT: Record<string, { count: number; reason: string }> = {
  "packages/api/src/routers/views.ts": {
    count: 1,
    reason: "whiteboard view content (tldraw JSON), not the text content plane",
  },
  "packages/api/src/routers/sync.ts": {
    count: 1,
    reason: "federation replica write under the remote pod's key",
  },
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".ts") && !name.includes(".test.")) yield full;
  }
}

/** `storage.upload(<first arg>,` — the first argument, across newlines. */
const UPLOAD_RE = /storage\s*\.\s*upload\(\s*([^,]+?)\s*,/gs;
const ROW_KEY_RE = /\.\s*storageKey\b/;

export function findRowKeyUploads(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(UPLOAD_RE)) {
    if (ROW_KEY_RE.test(m[1]!)) hits.push(m[1]!.replace(/\s+/g, " "));
  }
  return hits;
}

let scanned: ReturnType<typeof runScan> | undefined;
function scan() {
  return (scanned ??= runScan());
}

function runScan() {
  const pkgs = readdirSync(PACKAGES).filter((p) =>
    existsSync(join(PACKAGES, p, "src"))
  );
  const byFile = new Map<string, string[]>();
  let uploadsSeen = 0;
  for (const pkg of pkgs) {
    for (const file of walk(join(PACKAGES, pkg, "src"))) {
      const src = readFileSync(file, "utf8");
      uploadsSeen += [...src.matchAll(UPLOAD_RE)].length;
      const hits = findRowKeyUploads(src);
      if (hits.length) byFile.set(relative(BACKEND, file), hits);
    }
  }
  return { pkgs, byFile, uploadsSeen };
}

describe("document content has ONE write door", () => {
  it("self-check: the scanner sees a row-key upload across a newline, and not a fresh-key create", () => {
    expect(
      findRowKeyUploads(
        "await storage.upload(\n  document.storageKey!,\n  buf, {})"
      )
    ).toHaveLength(1);
    expect(
      findRowKeyUploads("await storage.upload(storageKey, content, {})")
    ).toHaveLength(0);
  });

  it("non-vacuity: the scan walks the backend and sees uploads", () => {
    const { pkgs, uploadsSeen, byFile } = scan();
    expect(pkgs).toEqual(
      expect.arrayContaining(["api", "jobs", "database", "realtime"])
    );
    expect(uploadsSeen).toBeGreaterThan(15);
    // The door itself must still be seen, or the scan is blind to the pattern.
    expect(byFile.get(DOOR)?.length).toBeGreaterThanOrEqual(1);
  });

  it("no row-key upload outside the door (exemptions pinned by count)", () => {
    const { byFile } = scan();
    const violations: string[] = [];
    for (const [file, hits] of byFile) {
      if (file === DOOR) continue;
      const exempt = EXEMPT[file];
      if (exempt && hits.length === exempt.count) continue;
      violations.push(`${file}: ${hits.join(" | ")}`);
    }
    expect(violations).toEqual([]);
  });
});

/**
 * PART 2 — THE CREATE DOOR (text tiers T3 follow-up).
 *
 * THE DEFECT THIS PINS: nine writers each hand-rolled "upload a body to a key,
 * insert the `documents` row, write the v1 version" — two tRPC routes, the Hub
 * `createDocument`, the promote door, the approval materializer, intake, the
 * session document, the entity body service, and three html-cell doors. Each
 * chose its own v1 author (the rail named the human for an agent's document),
 * its own key, its own mimeType. `createDocumentWithContent` is the one place.
 *
 * WHAT IT SCANS (derived, same walk as part 1): a file is a DOCUMENT-CREATE SITE
 * when it both calls `storage.upload(` and creates a `documents` row — an
 * `insert(documents)` or any use of `DocumentRepository`. Every upload in such
 * a file outside the door module is a violation unless the FILE is exempt below
 * with an exact upload count (so a new upload in an exempt file still fails).
 *
 * WHAT IT CANNOT SEE (measured): granularity is the FILE, not the call — an
 * upload for an unrelated purpose in a file that also creates documents counts
 * (hence the pinned counts); and a create that reaches the row insert only
 * through a helper imported from elsewhere, with no `DocumentRepository` /
 * `insert(documents)` in the file, is invisible. Measured: a bare upload added
 * to `routers/documents.ts` (which now creates only through the door) stayed
 * GREEN; re-inlining the create (upload + `insert(documents)`) there went RED.
 *
 * EXEMPT — not the text content plane, each with its reason:
 */
const CREATE_EXEMPT: Record<string, { count: number; reason: string }> = {
  "packages/api/src/routers/views.ts": {
    count: 3,
    reason: "whiteboard/canvas VIEW content (tldraw JSON)",
  },
  "packages/database/src/utils/create-default-whiteboard.ts": {
    count: 1,
    reason: "a workspace's default whiteboard (tldraw JSON)",
  },
  "packages/jobs/src/workers/materializer.ts": {
    count: 1,
    reason: "an approved whiteboard VIEW's canvas JSON",
  },
  "packages/api/src/routers/sync.ts": {
    count: 1,
    reason: "federation replica write under the remote pod's key",
  },
  "packages/api/src/utils/store-entity-source-blob.ts": {
    count: 1,
    reason: "the raw SOURCE bytes slot (sourceFile*), not a body",
  },
  "packages/database/src/services/entity-body-service.ts": {
    count: 1,
    reason:
      "bytes-mode BINARY body (pdf/docx upload): uploaded once with a pre-uploaded v1; the create door is for text",
  },
};

const DOCUMENT_ROW_CREATE_RE =
  /\binsert\(\s*documents\s*\)|\bDocumentRepository\b/;

/** The uploads in a file that creates document rows; 0 when it creates none. */
export function documentCreateUploads(source: string): number {
  if (!DOCUMENT_ROW_CREATE_RE.test(source)) return 0;
  return [...source.matchAll(UPLOAD_RE)].length;
}

let createScanned: Map<string, number> | undefined;
function createScan(): Map<string, number> {
  if (createScanned) return createScanned;
  const byFile = new Map<string, number>();
  for (const pkg of scan().pkgs) {
    for (const file of walk(join(PACKAGES, pkg, "src"))) {
      const n = documentCreateUploads(readFileSync(file, "utf8"));
      if (n > 0) byFile.set(relative(BACKEND, file), n);
    }
  }
  return (createScanned = byFile);
}

describe("a document is CREATED with its body through ONE door", () => {
  it("self-check: an upload beside a documents insert is a create site; an upload alone is not", () => {
    expect(
      documentCreateUploads(
        "await storage.upload(key, md, {});\nawait tx.insert( documents ).values({})"
      )
    ).toBe(1);
    expect(
      documentCreateUploads(
        "const r = new DocumentRepository(db, ev);\nawait storage\n  .upload(k, b, {})"
      )
    ).toBe(1);
    expect(documentCreateUploads("await storage.upload(key, png, {})")).toBe(0);
  });

  it("non-vacuity: the door itself is seen as a create site, among several", () => {
    const byFile = createScan();
    // The door module holds both uploads (replace + create).
    expect(byFile.get(DOOR)).toBeGreaterThanOrEqual(2);
    expect(byFile.size).toBeGreaterThanOrEqual(5);
    // Every exemption still names a real create site (a stale one is noise
    // that would silently widen the next time the file changes).
    for (const file of Object.keys(CREATE_EXEMPT)) {
      expect({ file, seen: byFile.has(file) }).toEqual({ file, seen: true });
    }
  });

  it("no document-create upload outside the door module (exemptions pinned by count)", () => {
    const violations: string[] = [];
    for (const [file, n] of createScan()) {
      if (file === DOOR) continue;
      const exempt = CREATE_EXEMPT[file];
      if (exempt && n === exempt.count) continue;
      violations.push(`${file}: ${n} upload(s) beside a documents-row create`);
    }
    expect(violations).toEqual([]);
  });
});
