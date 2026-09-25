/**
 * `loadDocumentBodyTexts` — what search indexes for a document (W4a).
 *
 * Pinned:
 *   - the STORED body is read (not the last checkpoint row);
 *   - a body that is legacy `yjs:` editor state yields no text;
 *   - a FAILED read lands in `failed`, never as empty text;
 *   - an external reference (no storage key) is neither text nor failure.
 */

import { describe, it, expect, vi } from "vitest";

const blobs = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: vi.fn(async (key: string) => {
      const b = blobs.get(key);
      if (!b) throw new Error(`no blob ${key}`);
      return b;
    }),
  },
}));

import { loadDocumentBodyTexts } from "./document-body-text.js";

type Row = { id: string; storageKey: string | null; mimeType: string | null };

function fakeDb(rows: Row[]) {
  return {
    select: () => ({
      from: () => ({ where: async () => rows }),
    }),
  } as unknown as Parameters<typeof loadDocumentBodyTexts>[0];
}

describe("loadDocumentBodyTexts", () => {
  it("reads stored markdown, skips yjs state, reports failed reads, ignores references", async () => {
    blobs.set("k/md", Buffer.from("# Title\n\nHuman save.", "utf-8"));
    blobs.set("k/yjs", Buffer.from("yjs:AQIDBA==", "utf-8"));
    const { texts, failed } = await loadDocumentBodyTexts(
      fakeDb([
        { id: "md", storageKey: "k/md", mimeType: "text/markdown" },
        { id: "yjs", storageKey: "k/yjs", mimeType: "text/markdown" },
        { id: "gone", storageKey: "k/missing", mimeType: "text/markdown" },
        { id: "ref", storageKey: null, mimeType: "text/html" },
      ]),
      ["md", "yjs", "gone", "ref"]
    );
    expect(Object.fromEntries(texts)).toEqual({
      md: "# Title\n\nHuman save.",
    });
    expect([...failed.keys()]).toEqual(["gone"]);
    expect(failed.get("gone")).toContain("no blob");
  });

  it("no ids → no query, nothing read", async () => {
    const { texts, failed } = await loadDocumentBodyTexts(fakeDb([]), []);
    expect(texts.size + failed.size).toBe(0);
  });
});
