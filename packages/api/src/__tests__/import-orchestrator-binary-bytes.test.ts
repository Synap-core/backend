/**
 * submitBatch keeps bytes as bytes.
 *
 * The regression this pins: every item was decoded with `buf.toString("utf-8")`
 * and uploaded as `Buffer.from(content, "utf-8")`, so any non-UTF-8 file (PNG,
 * JPEG, PDF, docx) was stored with its invalid sequences replaced by U+FFFD —
 * a corrupted blob under the original content type. Driven through the real
 * `submitBatch` with only storage/emit/structuring stubbed.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { storageUploadMock, proposeImportGraphMock } = vi.hoisted(() => ({
  storageUploadMock: vi.fn().mockResolvedValue(undefined),
  proposeImportGraphMock: vi
    .fn()
    .mockResolvedValue({ proposalId: "p1", deduplicated: false }),
}));

vi.mock("../utils/event-emit.js", () => ({
  emitImportFileProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@synap/storage", () => ({
  storage: { upload: storageUploadMock },
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  messages: {},
  getDb: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../routers/channels.js", () => ({
  channelsRouter: { createCaller: vi.fn(() => ({})) },
}));

vi.mock("../utils/import-path.js", () => ({
  sanitizeImportPath: (p: string) => p,
  mimeFromPath: vi.fn().mockReturnValue(null),
}));

vi.mock("@synap/jobs", () => ({ getBoss: vi.fn() }));
vi.mock("@synap/search", () => ({ searchService: {} }));

vi.mock("../services/import/structuring.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/import/structuring.js")
  >()),
  proposeImportGraph: proposeImportGraphMock,
  resolveProfileHints: vi.fn().mockResolvedValue({}),
}));

import { ImportOrchestrator } from "../services/import-orchestrator.js";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// PNG signature + IHDR chunk start + a spread of bytes that are NOT valid UTF-8
// (0x80-0xFF lone continuation / lead bytes). Any utf-8 round-trip changes these.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x80, 0x81, 0xfe, 0xff, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28,
  0xa1, 0xf0, 0x90, 0x28, 0xbc, 0xff,
]);

function orchestrator() {
  return new ImportOrchestrator({
    workspaceId: "ws_test",
    userId: "user_test",
    trpcCtx: {},
  });
}

describe("submitBatch — stored bytes are the received bytes", () => {
  beforeEach(() => {
    storageUploadMock.mockClear();
    proposeImportGraphMock.mockClear();
  });

  it("uploads a PNG byte-identical (sha256) and counts it storedOnly", async () => {
    // Self-check: the fixture really is non-UTF-8, so a utf-8 round-trip
    // would change it — otherwise this test could never go red.
    expect(sha256(Buffer.from(PNG_BYTES.toString("utf-8"), "utf-8"))).not.toBe(
      sha256(PNG_BYTES)
    );

    const res = await orchestrator().submitBatch([
      {
        path: "photos/receipt.png",
        contentBase64: PNG_BYTES.toString("base64"),
        mimeType: "image/png",
      },
    ]);

    expect(storageUploadMock).toHaveBeenCalledTimes(1);
    const [key, body, opts] = storageUploadMock.mock.calls[0]!;
    expect(key).toContain("photos/receipt.png");
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(sha256(body as Buffer)).toBe(sha256(PNG_BYTES));
    expect(opts).toMatchObject({ contentType: "image/png" });
    expect(res.filesStoredOnly).toBe(1);
    expect(proposeImportGraphMock).not.toHaveBeenCalled();
  });

  it("still decodes a markdown file to text for the import engine", async () => {
    const md = "# Launch\n\nCafé — naïve résumé ✓";
    const res = await orchestrator().submitBatch([
      {
        path: "notes/launch.md",
        contentBase64: Buffer.from(md, "utf-8").toString("base64"),
        mimeType: "text/markdown",
      },
    ]);

    const [, body] = storageUploadMock.mock.calls[0]!;
    expect(sha256(body as Buffer)).toBe(sha256(Buffer.from(md, "utf-8")));
    expect(proposeImportGraphMock).toHaveBeenCalledTimes(1);
    const files = proposeImportGraphMock.mock.calls[0]![3] as Array<{
      path: string;
      content: string;
    }>;
    expect(files).toEqual([{ path: "notes/launch.md", content: md }]);
    expect(res.proposalsCreated).toBe(1);
  });
});
