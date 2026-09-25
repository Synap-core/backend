/**
 * TRIPWIRE — a document's stored content is written ONLY through
 * `claimDocumentRevision` (@synap/database, utils/claim-document-revision.ts).
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
