/**
 * `loadDocumentBodyTexts` — what search indexes for a document (W4a).
 *
 * Pinned:
 *   - the STORED body is read (not the last checkpoint row);
 *   - a body that is legacy `yjs:` editor state yields no text;
 *   - a FAILED read lands in `failed`, never as empty text;
 *   - an external reference (no storage key) is neither text nor failure;
 *   - a MARKDOWN body goes through the injected `markdownText` (search passes
 *     markdown-core's plain-text rule), any other text body is kept as is.
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

import { storage } from "@synap/storage";
import { loadDocumentBodyTexts } from "./document-body-text.js";

type Row = {
  id: string;
  storageKey: string | null;
  mimeType: string | null;
  metadata?: unknown;
};

/** A visible stand-in for markdown-core's `markdownToPlainText`. */
const OPTS = { markdownText: (md: string) => `plain(${md})` };

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
      ["md", "yjs", "gone", "ref"],
      OPTS
    );
    expect(Object.fromEntries(texts)).toEqual({
      md: "plain(# Title\n\nHuman save.)",
    });
    expect([...failed.keys()]).toEqual(["gone"]);
    expect(failed.get("gone")).toContain("no blob");
  });

  it("no ids → no query, nothing read", async () => {
    const { texts, failed } = await loadDocumentBodyTexts(fakeDb([]), [], OPTS);
    expect(texts.size + failed.size).toBe(0);
  });

  it("only a markdown body is flattened; html and plain text are kept as stored", async () => {
    blobs.set("k/html", Buffer.from("<p>Hi</p>", "utf-8"));
    blobs.set("k/txt", Buffer.from("plain words", "utf-8"));
    const { texts } = await loadDocumentBodyTexts(
      fakeDb([
        { id: "html", storageKey: "k/html", mimeType: "text/html" },
        { id: "txt", storageKey: "k/txt", mimeType: "text/plain" },
      ]),
      ["html", "txt"],
      OPTS
    );
    expect(Object.fromEntries(texts)).toEqual({
      html: "<p>Hi</p>",
      txt: "plain words",
    });
  });

  it("a Library item is searched by its light-read text, never its raw bytes or URL", async () => {
    blobs.set("k/url-body", Buffer.from("https://example.com/a", "utf-8"));
    blobs.set("k/pdf", Buffer.from("%PDF-1.7 raw bytes", "utf-8"));
    blobs.set(
      "library-read/u/read.txt",
      Buffer.from("What the page says.", "utf-8")
    );
    const { texts, failed } = await loadDocumentBodyTexts(
      fakeDb([
        {
          id: "read",
          storageKey: "k/url-body",
          mimeType: "text/plain",
          metadata: {
            importItem: { title: "A" },
            importRead: { status: "read", textKey: "library-read/u/read.txt" },
          },
        },
        {
          id: "unread",
          storageKey: "k/pdf",
          mimeType: "text/plain",
          metadata: { importItem: { title: "B" } },
        },
      ]),
      ["read", "unread"],
      OPTS
    );
    // Read → its text. Not read yet → no text (title-only), and not a failure.
    expect(Object.fromEntries(texts)).toEqual({ read: "What the page says." });
    expect(failed.size).toBe(0);
  });

  it("a body that is not text is never downloaded (3 Nov 2026: a 126 MB video)", async () => {
    blobs.set("k/video", Buffer.from("\u0000\u0000ftypmp42", "utf-8"));
    blobs.set("k/audio", Buffer.from("RIFF....WAVE", "utf-8"));
    blobs.set("k/nomime", Buffer.from("bytes of no stated type", "utf-8"));
    blobs.set("k/note", Buffer.from("# Kept", "utf-8"));
    const download = vi.mocked(storage.downloadBuffer);
    download.mockClear();
    const { texts, failed } = await loadDocumentBodyTexts(
      fakeDb([
        { id: "video", storageKey: "k/video", mimeType: "video/mp4" },
        { id: "audio", storageKey: "k/audio", mimeType: "audio/wav" },
        { id: "nomime", storageKey: "k/nomime", mimeType: null },
        { id: "note", storageKey: "k/note", mimeType: "text/markdown" },
      ]),
      ["video", "audio", "nomime", "note"],
      OPTS
    );
    expect(download.mock.calls.map(([key]) => key)).toEqual(["k/note"]);
    // Not text: no text, and not a failure either.
    expect(Object.fromEntries(texts)).toEqual({ note: "plain(# Kept)" });
    expect(failed.size).toBe(0);
  });
});
